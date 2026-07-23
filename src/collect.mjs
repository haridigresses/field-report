import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { classifyPullRequests } from "./prs.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readLocalEvents(streamId) {
  try {
    const content = await readFile(path.join(root, "events", `${streamId}.jsonl`), "utf8");
    const labels = { created: "Workstream created", onboard: "Session armed", disarm: "Session disarmed", checkpoint: "Checkpoint", reconcile: "Reconciliation", status: "Situation update", question: "Uncertainty opened", decision: "Decision recorded", milestone: "Milestone update", update: "Workstream update", updated: "Workstream update", review_pass: "Review pass", delegation: "Delegated review" };
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((event) => ({
      at: event.at,
      actor: event.actor || "fr",
      type: event.type,
      label: labels[event.type] || "Field Report update",
        text: event.text,
        ...(event.metadata ? { metadata: event.metadata } : {})
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

async function collectPullRequests(project, configuredNumbers) {
  if (!project.githubRepo || project.githubRepo.startsWith("owner/")) return { items: [] };
  const fields = "number,title,url,state,isDraft,headRefName,headRefOid,updatedAt,mergeStateStatus,reviewDecision,statusCheckRollup";
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

async function enrichReferences(stream, project, revision) {
  if (!(stream.references || []).length) return [];
  const resolved = await command("git", ["rev-parse", revision || stream.branch || "HEAD"], project.repoPath);
  const commit = resolved.ok ? resolved.value : null;
  return Promise.all(stream.references.map(async (reference) => {
    const exists = commit ? await command("git", ["cat-file", "-e", `${commit}:${reference.path}`], project.repoPath) : { ok: false };
    return {
      ...reference,
      commit,
      exists: exists.ok,
      url: commit && project.githubRepo ? `https://github.com/${project.githubRepo}/blob/${commit}/${reference.path}${reference.section ? `#${reference.section}` : ""}` : null
    };
  }));
}

function sameHead(left, right) {
  return Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}

function semanticTimeline(events) {
  const material = new Set(["created", "checkpoint", "reconcile", "decision", "question", "assessment_requested", "review_pass", "milestone", "commit", "pr", "complete"]);
  const labels = {
    created: "Outcome created",
    checkpoint: "Gate checkpoint",
    reconcile: "Situation reconciled",
    decision: "Decision recorded",
    question: "Uncertainty opened",
    assessment_requested: "Review requested",
    review_pass: "Review pass",
    milestone: "Milestone completed",
    commit: "Patch committed",
    pr: "Delivery updated",
    complete: "Outcome completed"
  };
  return events.filter((event) => material.has(event.type)).map((event) => ({ ...event, label: labels[event.type] || event.type }));
}

function assessmentFromPasses(stream, passes, currentHead) {
  const current = passes.filter((event) => sameHead(event.metadata?.head, currentHead));
  const latest = current.at(-1) || null;
  if (!latest) return {
    ...(stream.assessment || {}),
    stale: stream.assessment?.assessedHead ? !sameHead(stream.assessment.assessedHead, currentHead) : Boolean(passes.length && currentHead),
    currentHead: currentHead || null
  };
  return {
    ...(stream.assessment || {}),
    mergeReadiness: latest.metadata?.mergeReadiness,
    structuralRisk: latest.metadata?.structuralRisk,
    assessedHead: latest.metadata?.head,
    assessedAt: latest.at,
    assessedBy: latest.metadata?.reviewer || latest.actor,
    rationale: latest.text,
    verdict: latest.metadata?.verdict,
    outcomeConfidence: latest.metadata?.outcomeConfidence,
    necessity: latest.metadata?.necessity,
    simplerPath: latest.metadata?.simplerPath,
    scopeDrift: latest.metadata?.scopeDrift,
    contractIntegrity: latest.metadata?.contractIntegrity,
    evidenceQuality: latest.metadata?.evidenceQuality,
    stale: false,
    currentHead
  };
}

async function main() {
  const { projects } = await readJson(path.join(root, "config/projects.json"));
  const sessionRegistry = await readJson(path.join(root, "config/sessions.json")).catch(() => ({ sessions: [] }));
  const files = (await readdir(path.join(root, "workstreams"))).filter((file) => file.endsWith(".json")).sort();
  const streams = await Promise.all(files.map((file) => readJson(path.join(root, "workstreams", file))));
  const localEventsByStream = Object.fromEntries(await Promise.all(streams.map(async (stream) => [stream.id, await readLocalEvents(stream.id)])));
  const prNumbersByProject = Object.fromEntries(projects.map((project) => [project.id, [...new Set(streams.filter((stream) => stream.project === project.id).flatMap((stream) => (stream.prs || []).map((pr) => typeof pr === "number" ? pr : pr.number)))]]));

  const [issues, ...remainingResults] = await Promise.all([
    collectIssues(),
    ...projects.map((project) => collectPullRequests(project, prNumbersByProject[project.id])),
    ...projects.map(collectRepoState)
  ]);

  const pullRequestResults = remainingResults.slice(0, projects.length);
  const repoResults = remainingResults.slice(projects.length);
  const prsByProject = Object.fromEntries(projects.map((project, index) => [project.id, pullRequestResults[index]]));
  const repoByProject = Object.fromEntries(projects.map((project, index) => [project.id, repoResults[index]]));
  const sessionsByReference = Object.fromEntries((sessionRegistry.sessions || []).flatMap((session) => [[session.id, session], [session.alias, session], ...(session.aliases || []).map((alias) => [alias, session])]));
  const enrichedStreams = await Promise.all(streams.map(async (stream) => {
    const livePrs = prsByProject[stream.project]?.items || [];
    const configuredPrs = classifyPullRequests((stream.prs || []).map((configured) => {
      const number = typeof configured === "number" ? configured : configured.number;
      return { ...configured, ...(livePrs.find((pr) => pr.number === number) || {}), number };
    }), stream.branch);
    const branchPr = configuredPrs.find((pr) => pr.current) || null;
    const issuePrefixes = stream.issuePrefixes || [];
    const streamIssues = issues.items.filter((issue) => issuePrefixes.some((prefix) => issue.id === prefix || issue.id?.startsWith(`${prefix}.`)));
    const orchestrator = stream.orchestrator || stream.fableAgent || null;
    const localEvents = localEventsByStream[stream.id] || [];
    const reviewPasses = localEvents.filter((event) => event.type === "review_pass").sort((a, b) => new Date(a.at) - new Date(b.at));
    let currentHead = branchPr?.headRefOid || null;
    if (!currentHead && stream.branch) {
      const project = projects.find((candidate) => candidate.id === stream.project);
      const resolved = await command("git", ["rev-parse", stream.branch], project?.repoPath);
      if (resolved.ok && /^[0-9a-f]{40}$/i.test(resolved.value)) currentHead = resolved.value;
    }
    const latestRequest = localEvents.filter((event) => event.type === "assessment_requested").sort((a, b) => new Date(a.at) - new Date(b.at)).at(-1) || null;
    const latestPass = reviewPasses.at(-1) || null;
    return {
      ...stream,
      orchestrator,
      assessment: assessmentFromPasses(stream, reviewPasses, currentHead),
      assessmentRequest: latestRequest ? {
        requestedAt: latestRequest.at,
        requestedFrom: latestRequest.metadata?.recipient || latestRequest.actor,
        pending: !latestPass || new Date(latestPass.at) < new Date(latestRequest.at)
      } : null,
      reviewPasses,
      timeline: semanticTimeline(localEvents).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 20),
      references: await enrichReferences(stream, projects.find((project) => project.id === stream.project), currentHead),
      questions: stream.questions || [],
      prs: configuredPrs,
      afIssues: streamIssues,
      agents: orchestrator ? [{ id: orchestrator, taskId: sessionsByReference[orchestrator]?.id || orchestrator, name: sessionsByReference[orchestrator]?.alias || orchestrator, kind: sessionsByReference[orchestrator]?.kind || "codex" }] : []
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
        assignedAgents: [...new Set(projectStreams.flatMap((stream) => stream.agents.map((agent) => agent.taskId)))].length,
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
      codexSessions: "field-report",
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
  const dailyFile = path.join(snapshotDir, `${date}.json`);
  const dailyTemp = `${dailyFile}.${process.pid}-${randomUUID()}.next`;
  await writeFile(dailyTemp, serialized);
  await rename(dailyTemp, dailyFile);

  process.stdout.write(`Refreshed ${enrichedStreams.length} workstreams at ${snapshot.generatedAt}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
