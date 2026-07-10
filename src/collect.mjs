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

async function readLocalEvents(streamId) {
  try {
    const content = await readFile(path.join(root, "events", `${streamId}.jsonl`), "utf8");
    const labels = { created: "Workstream created", onboard: "Session armed", disarm: "Session disarmed", checkpoint: "Checkpoint", reconcile: "Reconciliation", status: "Situation update", question: "Uncertainty opened", decision: "Decision recorded", milestone: "Milestone update", update: "Workstream update", updated: "Workstream update" };
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((event) => ({
      at: event.at,
      actor: event.actor || "fr",
      type: event.type,
      label: labels[event.type] || "Field Report update",
      text: event.text
    }));
  } catch { return []; }
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

function issueUpdatedMillis(issue) {
  const raw = Number(issue.updated_at || issue.updatedAt || 0);
  return raw > 10 ** 15 ? raw / 1_000_000 : raw > 10 ** 12 ? raw : raw * 1000;
}

function commitShas(value) {
  return [...new Set(String(value || "").match(/\b[0-9a-f]{7,40}\b/gi) || [])].slice(0, 12);
}

function projectIssueInventory(project, projectStreams, allIssues) {
  const namespaces = new Set(project.issueNamespaces || []);
  const uuidToId = new Map(allIssues.map((issue) => [issue.uuid, issue.id]));
  const weights = { in_progress: 0, open: 1, closed: 2 };
  return allIssues.filter((issue) => namespaces.has(issue.session_name) || namespaces.has(String(issue.id || "").split(".")[0]))
    .map((issue) => {
      const linkedStreams = projectStreams.filter((stream) => (stream.issuePrefixes || []).some((prefix) => issue.id === prefix || issue.id?.startsWith(`${prefix}.`)) || (stream.chunks || []).some((chunk) => (chunk.issueIds || []).includes(issue.id)));
      const shas = commitShas(`${issue.title || ""} ${issue.body || ""} ${issue.resolution || ""}`);
      return {
        id: issue.id,
        uuid: issue.uuid,
        parentId: issue.parent_uuid ? uuidToId.get(issue.parent_uuid) || null : null,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        sessionName: issue.session_name,
        updatedAt: issueUpdatedMillis(issue) ? new Date(issueUpdatedMillis(issue)).toISOString() : null,
        workstreamIds: linkedStreams.map((stream) => stream.id),
        commits: shas.map((sha) => ({ sha, url: project.githubRepo ? `https://github.com/${project.githubRepo}/commit/${sha}` : null }))
      };
    })
    .sort((a, b) => (weights[a.status] ?? 9) - (weights[b.status] ?? 9) || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, 300);
}

async function enrichReferences(stream, project) {
  if (!(stream.references || []).length) return [];
  const head = await command("git", ["rev-parse", "HEAD"], project.repoPath);
  return Promise.all(stream.references.map(async (reference) => {
    const exists = await command("git", ["cat-file", "-e", `${head.ok ? head.value : "HEAD"}:${reference.path}`], project.repoPath);
    return {
      ...reference,
      commit: head.ok ? head.value : null,
      exists: exists.ok,
      url: head.ok && project.githubRepo ? `https://github.com/${project.githubRepo}/blob/${head.value}/${reference.path}${reference.section ? `#${reference.section}` : ""}` : null
    };
  }));
}

function messageText(message) {
  return String(message.subject || message.title || message.body || message.content || "");
}

function protocol(message) {
  const subject = String(message.subject || message.title || "").trim();
  const match = subject.match(/^\[(QUESTION|ANSWER|STATUS|COMPLETE|REVIEW|PR|RATING|ASSESSMENT|ASSESSMENT_REQUEST)\s+([^\]\s]+)(?:\s+(Q\d+))?\]\s*(.*)$/i);
  if (!match) return null;
  return { type: match[1].toUpperCase(), streamId: match[2], questionId: match[3], tail: match[4] || "", body: message.body || message.content || "" };
}

function keyValues(text) {
  return Object.fromEntries([...String(text || "").matchAll(/(?:^|\s)([a-z_]+)=([^\s]+)/gi)].map((match) => [match[1].toLowerCase(), match[2]]));
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function lineValue(text, key) {
  return String(text || "").match(new RegExp(`^${key}:\\s*(.+)$`, "im"))?.[1]?.trim() || null;
}

function structuredAssessment(message, streamId) {
  const parsed = protocol(message);
  if (parsed?.type !== "ASSESSMENT" || parsed.streamId !== streamId) return null;
  const values = keyValues(`${parsed.tail}\n${parsed.body}`);
  return {
    outcomeConfidence: numberValue(values.outcome_confidence),
    mergeReadiness: numberValue(values.merge_readiness),
    structuralRisk: numberValue(values.structural_rebuild_risk),
    assessedHead: /^[0-9a-f]{7,40}$/i.test(values.head || "") ? values.head : null,
    necessity: values.necessity || null,
    simplerPath: values.simpler_path || null,
    scopeDrift: values.scope_drift || null,
    contractIntegrity: values.contract_integrity || null,
    evidenceQuality: values.evidence_quality || null,
    verdict: values.verdict || null,
    primaryRisk: lineValue(parsed.body, "primary_risk"),
    nextGate: lineValue(parsed.body, "next_gate") || (values.next_gate ? values.next_gate.replaceAll("_", " ") : null),
    rationale: lineValue(parsed.body, "rationale") || parsed.tail.replace(/(?:^|\s)[a-z_]+=[^\s]+/gi, " ").trim(),
    assessedAt: new Date(messageMillis(message)).toISOString(),
    assessedBy: message.from_name || message.fromName
  };
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
  let requestedAt = null;
  let requestedFrom = null;
  for (const message of [...inboxMessages].sort((a, b) => messageMillis(a) - messageMillis(b))) {
    const rating = ratings(message).find((candidate) => candidate.streamId === stream.id);
    if (rating) assessment = {
        mergeReadiness: rating.mergeReadiness,
        structuralRisk: rating.structuralRisk,
        assessedHead: rating.assessedHead,
        assessedAt: new Date(messageMillis(message)).toISOString(),
        assessedBy: message.from_name || message.fromName,
        rationale: message.body || rating.rationale
      };
    const structured = structuredAssessment(message, stream.id);
    if (structured) assessment = structured;
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
    if (parsed.type === "ASSESSMENT_REQUEST") {
      requestedAt = new Date(messageMillis(message)).toISOString();
      requestedFrom = message.to_name || message.toName;
    }
  }
  return {
    assessment,
    liveStatus,
    assessmentRequest: requestedAt ? {
      requestedAt,
      requestedFrom,
      pending: !assessment?.assessedAt || new Date(assessment.assessedAt).getTime() < new Date(requestedAt).getTime()
    } : null
  };
}

function eventSummary(parsed) {
  const labels = {
    ASSESSMENT_REQUEST: "Assessment requested",
    ASSESSMENT: "Reviewer assessment",
    RATING: "Reviewer rating",
    REVIEW: "Review decision",
    QUESTION: "Uncertainty opened",
    ANSWER: "Uncertainty resolved",
    STATUS: "Execution update",
    COMPLETE: "Milestone completed",
    PR: "Delivery update"
  };
  return labels[parsed.type] || parsed.type;
}

function derivedTimeline(stream, inboxMessages, streamIssues) {
  const materialTypes = new Set(["ASSESSMENT_REQUEST", "ASSESSMENT", "RATING", "REVIEW", "QUESTION", "ANSWER", "STATUS", "COMPLETE", "PR"]);
  const issueUuids = new Set(streamIssues.map((issue) => issue.uuid).filter(Boolean));
  const candidates = [];
  for (const message of inboxMessages) {
    const parsed = protocol(message);
    if (parsed?.streamId === stream.id && materialTypes.has(parsed.type)) candidates.push({ message, parsed });
    if (ratings(message).some((rating) => rating.streamId === stream.id) && parsed?.streamId !== stream.id) {
      candidates.push({ message, parsed: { type: "RATING", streamId: stream.id, tail: ratings(message).find((rating) => rating.streamId === stream.id)?.rationale || "Reviewer rating updated" } });
    }
    if (!parsed && issueUuids.has(message.related_issue_uuid)) {
      candidates.push({ message, parsed: { type: "EXECUTION", streamId: stream.id, tail: message.subject || message.body || "Issue-linked execution activity" } });
    }
  }
  return candidates.sort((a, b) => messageMillis(b.message) - messageMillis(a.message))
    .slice(0, 20)
    .map(({ message, parsed }) => {
      const raw = parsed.type === "ASSESSMENT" ? (parsed.body || parsed.tail) : (parsed.tail || parsed.body);
      const text = String(raw || eventSummary(parsed)).replace(/\s+/g, " ").trim();
      return {
        at: new Date(messageMillis(message)).toISOString(),
        actor: message.from_name || message.fromName || "AF",
        type: parsed.type.toLowerCase(),
        label: parsed.type === "EXECUTION" ? "Execution activity" : eventSummary(parsed),
        text: text.length > 280 ? `${text.slice(0, 277)}…` : text
      };
    });
}

async function main() {
  const { projects } = await readJson(path.join(root, "config/projects.json"));
  const files = (await readdir(path.join(root, "workstreams"))).filter((file) => file.endsWith(".json")).sort();
  const streams = await Promise.all(files.map((file) => readJson(path.join(root, "workstreams", file))));
  const localEventsByStream = Object.fromEntries(await Promise.all(streams.map(async (stream) => [stream.id, await readLocalEvents(stream.id)])));
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
  const enrichedStreams = await Promise.all(streams.map(async (stream) => {
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
      assessmentRequest: protocolState.assessmentRequest,
      timeline: [...derivedTimeline(stream, inbox.items, streamIssues), ...(localEventsByStream[stream.id] || [])]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 20),
      references: await enrichReferences(stream, projects.find((project) => project.id === stream.project)),
      questions: derivedQuestions(stream, inbox.items),
      prs: configuredPrs,
      afIssues: streamIssues,
      agents: [...new Set(agentNames)].map((name) => agentsByName[name] || { name, running: false })
    };
  }));

  const enrichedProjects = projects.map((project) => {
    const projectStreams = enrichedStreams.filter((stream) => stream.project === project.id);
    const projectPrs = prsByProject[project.id]?.items || [];
    const checks = projectPrs.flatMap((pr) => pr.statusCheckRollup || []);
    return {
      ...project,
      repoState: repoByProject[project.id],
      afIssues: projectIssueInventory(project, projectStreams, issues.items),
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
