import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function command(command, args, cwd = root) {
  try {
    const { stdout } = await exec(command, args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
    return { ok: true, value: stdout.trim() };
  } catch (error) {
    return { ok: false, error: error.stderr?.trim() || error.message };
  }
}

async function collectIssues() {
  const result = await command("af", ["issue", "list", "--other-agents", "--json"]);
  if (!result.ok) return { items: [], error: result.error };
  try {
    const parsed = JSON.parse(result.value || "[]");
    return { items: Array.isArray(parsed) ? parsed : parsed.issues || [] };
  } catch (error) {
    return { items: [], error: `Could not parse AF issue JSON: ${error.message}` };
  }
}

async function collectInbox(agentNames) {
  const messages = [];
  const errors = [];
  for (const agent of agentNames) {
    const result = await command("af", ["inbox", "list", "--for", agent, "--namespace", "--json"]);
    if (!result.ok) {
      errors.push(`${agent}: ${result.error}`);
      continue;
    }
    try {
      const parsed = JSON.parse(result.value || "[]");
      const items = Array.isArray(parsed) ? parsed : parsed.messages || [];
      messages.push(...items.map((message) => ({ ...message, inboxOwner: agent })));
    } catch (error) {
      errors.push(`${agent}: could not parse inbox JSON (${error.message})`);
    }
  }
  const deduped = [...new Map(messages.map((message) => [`${message.created_at}:${message.from_name}:${message.subject}`, message])).values()];
  return { items: deduped, error: errors.length ? errors.join("; ") : undefined };
}

async function collectPullRequests(project, configuredNumbers) {
  if (!project.githubRepo || project.githubRepo.startsWith("owner/")) return { items: [] };
  const fields = "number,title,url,state,isDraft,headRefName,headRefOid,updatedAt,mergeStateStatus,statusCheckRollup";
  const result = await command("gh", ["pr", "list", "--repo", project.githubRepo, "--state", "open", "--limit", "100", "--json", fields]);
  if (!result.ok) return { items: [], error: result.error };
  try {
    const open = JSON.parse(result.value || "[]");
    const byNumber = new Map(open.map((pr) => [pr.number, pr]));
    for (const number of configuredNumbers) {
      if (byNumber.has(number)) continue;
      const exact = await command("gh", ["pr", "view", String(number), "--repo", project.githubRepo, "--json", fields]);
      if (exact.ok) byNumber.set(number, JSON.parse(exact.value));
    }
    return { items: [...byNumber.values()] };
  } catch (error) {
    return { items: [], error: `Could not parse GitHub PR JSON: ${error.message}` };
  }
}

async function collectAgentStatus() {
  const result = await command("af", ["session", "ps", "--limit", "250"]);
  if (!result.ok) return { items: [], error: result.error };
  const items = [];
  for (const line of result.value.split("\n")) {
    const match = line.match(/^\[([^\]]+)\].*?#\d+\s+\[([^\]]+)\]/);
    if (match) items.push({ name: match[1], kind: line.includes(" claude ") ? "claude" : line.includes(" codex ") ? "codex" : "unknown", idleFor: match[2], running: true });
  }
  return { items };
}

async function collectRepoState(project) {
  const worktrees = await command("git", ["worktree", "list", "--porcelain"], project.repoPath);
  const status = await command("git", ["status", "--porcelain=v1", "--branch"], project.repoPath);
  if (!worktrees.ok || !status.ok) return { error: worktrees.error || status.error };
  const worktreeCount = (worktrees.value.match(/^worktree /gm) || []).length;
  const prunableCount = (worktrees.value.match(/^prunable /gm) || []).length;
  const statusLines = status.value.split("\n").filter(Boolean);
  return {
    worktreeCount,
    prunableCount,
    rootBranch: statusLines[0]?.replace(/^##\s*/, "") || "unknown",
    rootDirtyFiles: statusLines.slice(1).length
  };
}

function messageText(message) {
  return String(message.subject || message.title || message.body || message.content || "");
}

function protocol(message) {
  const subject = String(message.subject || message.title || "").trim();
  const match = subject.match(/^\[(QUESTION|ANSWER|STATUS|COMPLETE|REVIEW|PR|RATING)\s+([^\]\s]+)(?:\s+(Q\d+))?\]\s*(.*)$/i);
  if (!match) return null;
  return { type: match[1].toUpperCase(), streamId: match[2], questionId: match[3], tail: match[4] || "", body: message.body || message.content || "" };
}

function ratings(message) {
  const subject = String(message.subject || message.title || "");
  const found = [];
  const pattern = /\[RATING\s+([^\]\s]+)\]\s+merge=(\d{1,3})\s+structural=(\d{1,3})\s+head=([^\s—]+)\s*(?:—|-)?\s*([\s\S]*?)(?=\s*\[RATING\s+|$)/gi;
  for (const match of subject.matchAll(pattern)) {
    found.push({
      streamId: match[1],
      mergeReadiness: Number(match[2]),
      structuralRisk: Number(match[3]),
      assessedHead: /^[0-9a-f]{7,40}$/i.test(match[4]) ? match[4] : null,
      rationale: match[5].trim()
    });
  }
  return found.filter((rating) => rating.mergeReadiness <= 100 && rating.structuralRisk <= 100);
}

function messageMillis(message) {
  const raw = Number(message.created_at || message.createdAt || 0);
  if (!raw) return 0;
  return raw > 10 ** 15 ? raw / 1_000_000 : raw > 10 ** 12 ? raw : raw * 1000;
}

function derivedQuestions(stream, inboxMessages) {
  const questions = new Map((stream.questions || []).map((question) => [question.id, question]));
  const relevant = inboxMessages.map((message) => ({ message, parsed: protocol(message) }))
    .filter(({ parsed }) => parsed?.streamId === stream.id && ["QUESTION", "ANSWER"].includes(parsed.type))
    .sort((a, b) => messageMillis(a.message) - messageMillis(b.message));
  for (const { message, parsed } of relevant) {
    if (!parsed.questionId) continue;
    if (parsed.type === "QUESTION") {
      questions.set(parsed.questionId, {
        id: parsed.questionId,
        text: parsed.tail || parsed.body || "Question recorded in AF inbox",
        status: "open",
        askedAt: new Date(messageMillis(message)).toISOString()
      });
    } else {
      const prior = questions.get(parsed.questionId) || { id: parsed.questionId, text: "Question answered through AF inbox" };
      questions.set(parsed.questionId, { ...prior, status: "answered", answeredAt: new Date(messageMillis(message)).toISOString() });
    }
  }
  return [...questions.values()];
}

function derivedProtocolState(stream, inboxMessages) {
  const relevant = inboxMessages.map((message) => ({ message, parsed: protocol(message) }))
    .filter(({ parsed }) => parsed?.streamId === stream.id)
    .sort((a, b) => messageMillis(a.message) - messageMillis(b.message));
  let assessment = stream.assessment || null;
  let liveStatus = null;
  for (const message of inboxMessages) {
    const rating = ratings(message).find((candidate) => candidate.streamId === stream.id);
    if (!rating) continue;
    assessment = {
      mergeReadiness: rating.mergeReadiness,
      structuralRisk: rating.structuralRisk,
      assessedHead: rating.assessedHead,
      assessedAt: new Date(messageMillis(message)).toISOString(),
      assessedBy: message.from_name || message.fromName,
      rationale: message.body || rating.rationale
    };
  }
  for (const { message, parsed } of relevant) {
    if (["STATUS", "COMPLETE", "REVIEW"].includes(parsed.type)) {
      liveStatus = {
        type: parsed.type.toLowerCase(),
        text: parsed.tail || parsed.body,
        at: new Date(messageMillis(message)).toISOString(),
        from: message.from_name || message.fromName
      };
    }
  }
  return { assessment, liveStatus };
}

async function main() {
  const { projects } = await readJson(path.join(root, "config/projects.json"));
  const files = (await readdir(path.join(root, "workstreams"))).filter((file) => file.endsWith(".json")).sort();
  const streams = await Promise.all(files.map((file) => readJson(path.join(root, "workstreams", file))));
  const agents = [...new Set(projects.flatMap((project) => [project.coordinator]).concat(streams.flatMap((stream) => [stream.fableAgent, stream.reviewerAgent, stream.codexExecutor])).filter(Boolean))];
  const prNumbersByProject = Object.fromEntries(projects.map((project) => [project.id, [...new Set(streams.filter((stream) => stream.project === project.id).flatMap((stream) => (stream.prs || []).map((pr) => typeof pr === "number" ? pr : pr.number)))]]));

  const [issues, inbox, agentStatus, ...remainingResults] = await Promise.all([
    collectIssues(),
    collectInbox(agents),
    collectAgentStatus(),
    ...projects.map((project) => collectPullRequests(project, prNumbersByProject[project.id])),
    ...projects.map(collectRepoState)
  ]);

  const pullRequestResults = remainingResults.slice(0, projects.length);
  const repoResults = remainingResults.slice(projects.length);
  const prsByProject = Object.fromEntries(projects.map((project, index) => [project.id, pullRequestResults[index]]));
  const repoByProject = Object.fromEntries(projects.map((project, index) => [project.id, repoResults[index]]));
  const agentsByName = Object.fromEntries(agentStatus.items.map((agent) => [agent.name, agent]));
  const enrichedStreams = streams.map((stream) => {
    const livePrs = prsByProject[stream.project]?.items || [];
    const configuredPrs = (stream.prs || []).map((configured) => {
      const number = typeof configured === "number" ? configured : configured.number;
      return { ...configured, ...(livePrs.find((pr) => pr.number === number) || {}), number };
    });
    const branchPr = livePrs.find((pr) => pr.headRefName === stream.branch);
    const protocolState = derivedProtocolState(stream, inbox.items);
    const assessment = protocolState.assessment || {};
    const issuePrefixes = stream.issuePrefixes || [];
    const streamIssues = issues.items.filter((issue) => issuePrefixes.some((prefix) => issue.id === prefix || issue.id?.startsWith(`${prefix}.`)));
    const agentNames = [stream.fableAgent, stream.reviewerAgent, stream.codexExecutor].filter(Boolean);
    return {
      ...stream,
      assessment: {
        ...assessment,
        stale: Boolean(assessment.assessedHead && branchPr?.headRefOid && !branchPr.headRefOid.startsWith(assessment.assessedHead) && !assessment.assessedHead.startsWith(branchPr.headRefOid)),
        currentHead: branchPr?.headRefOid || null
      },
      liveStatus: protocolState.liveStatus,
      questions: derivedQuestions(stream, inbox.items),
      prs: configuredPrs,
      afIssues: streamIssues,
      agents: [...new Set(agentNames)].map((name) => agentsByName[name] || { name, running: false })
    };
  });

  const enrichedProjects = projects.map((project) => {
    const projectStreams = enrichedStreams.filter((stream) => stream.project === project.id);
    const projectPrs = prsByProject[project.id]?.items || [];
    const checks = projectPrs.flatMap((pr) => pr.statusCheckRollup || []);
    return {
      ...project,
      repoState: repoByProject[project.id],
      metrics: {
        activeWorkstreams: projectStreams.filter((stream) => ["active", "blocked"].includes(stream.status)).length,
        openQuestions: projectStreams.flatMap((stream) => stream.questions || []).filter((question) => question.status === "open").length,
        openPrs: projectPrs.filter((pr) => pr.state === "OPEN").length,
        failingChecks: checks.filter((check) => check.conclusion === "FAILURE" || check.state === "FAILURE").length,
        pendingChecks: checks.filter((check) => check.status === "IN_PROGRESS" || check.status === "QUEUED" || check.state === "PENDING").length,
        runningAgents: [...new Set(projectStreams.flatMap((stream) => stream.agents.filter((agent) => agent.running).map((agent) => agent.name)))].length,
        openIssues: projectStreams.flatMap((stream) => stream.afIssues).filter((issue) => issue.status !== "closed").length
      }
    };
  });

  const now = new Date();
  const snapshot = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    projects: enrichedProjects,
    workstreams: enrichedStreams,
    health: {
      afIssues: issues.error || "ok",
      afInbox: inbox.error || "ok",
      afSessions: agentStatus.error || "ok",
      github: Object.fromEntries(projects.map((project) => [project.id, prsByProject[project.id]?.error || "ok"]))
    }
  };

  const dataDir = path.join(root, "data");
  const snapshotDir = path.join(root, "snapshots");
  await mkdir(dataDir, { recursive: true });
  await mkdir(snapshotDir, { recursive: true });
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  const temp = path.join(dataDir, `current.json.${process.pid}-${randomUUID()}.next`);
  await writeFile(temp, serialized);
  await rename(temp, path.join(dataDir, "current.json"));

  const date = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const stable = JSON.stringify({ projects, workstreams: enrichedStreams });
  const digest = createHash("sha256").update(stable).digest("hex").slice(0, 10);
  const dailyFile = path.join(snapshotDir, `${date}-${digest}.json`);
  try {
    await readFile(dailyFile);
  } catch {
    await writeFile(dailyFile, serialized);
  }

  process.stdout.write(`Refreshed ${enrichedStreams.length} workstreams at ${snapshot.generatedAt}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
