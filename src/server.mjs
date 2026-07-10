import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4177);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
let refreshPromise;
let refreshQueued = false;
let mutationPromise = Promise.resolve();

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

async function serveFile(res, relativePath) {
  const file = path.resolve(root, relativePath);
  if (!file.startsWith(root)) return send(res, 403, "Forbidden");
  try {
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, "Not found");
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, "Not found");
  }
}

async function runCollect() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      let result;
      do {
        refreshQueued = false;
        result = await exec(process.execPath, [path.join(root, "src/collect.mjs")], { cwd: root, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 });
      } while (refreshQueued);
      return result;
    })().finally(() => { refreshPromise = undefined; });
  } else refreshQueued = true;
  return refreshPromise;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sessionValue(value) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = String(value).trim();
  if (normalized.length > 200 || /[\r\n\0]/.test(normalized)) throw new Error("Session identifiers must be a single line under 200 characters");
  return normalized;
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}-${randomUUID()}.next`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

async function findWorkstream(workstreamId) {
  const workstreamDir = path.join(root, "workstreams");
  const files = (await readdir(workstreamDir)).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    const candidate = JSON.parse(await readFile(path.join(workstreamDir, file), "utf8"));
    if (candidate.id === workstreamId) {
      return { streamFile: path.join(workstreamDir, file), stream: candidate };
    }
  }
  throw new Error("Unknown workstream");
}

async function listCanonicalWorkstreams() {
  const workstreamDir = path.join(root, "workstreams");
  const files = (await readdir(workstreamDir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(workstreamDir, file), "utf8"))));
}

function workstreamId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 80) throw new Error("Workstream IDs use lowercase letters, numbers, and hyphens");
  return normalized;
}

function shortText(value, label, max = 500) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max || /\0/.test(normalized)) throw new Error(`${label} must be between 1 and ${max} characters`);
  return normalized;
}

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function normalizePrs(prs) {
  if (!Array.isArray(prs)) throw new Error("prs must be an array");
  return prs.map((pr) => {
    const number = Number(typeof pr === "object" ? pr.number : pr);
    if (!Number.isInteger(number) || number < 1) throw new Error("PR numbers must be positive integers");
    return typeof pr === "object" ? { number, chunks: Array.isArray(pr.chunks) ? pr.chunks.map(String) : [] } : { number, chunks: [] };
  });
}

function normalizeChunks(chunks) {
  if (!Array.isArray(chunks)) throw new Error("chunks must be an array");
  return chunks.map((chunk, index) => {
    const status = String(chunk.status || "planned");
    if (!["planned", "active", "blocked", "complete"].includes(status)) throw new Error("Chunk status must be planned, active, blocked, or complete");
    return {
      id: slug(chunk.id || chunk.title || `milestone-${index + 1}`),
      title: shortText(chunk.title, "Chunk title", 240),
      status,
      ...(Array.isArray(chunk.issueIds) ? { issueIds: chunk.issueIds.map(String) } : {}),
      ...(Array.isArray(chunk.commits) ? { commits: chunk.commits.map(String) } : {}),
      ...(Array.isArray(chunk.references) ? { references: normalizeReferences(chunk.references) } : {})
    };
  });
}

function normalizeReferences(references) {
  if (!Array.isArray(references)) throw new Error("references must be an array");
  return references.slice(0, 12).map((reference) => ({
    path: shortText(reference.path, "Reference path", 500),
    label: shortText(reference.label || reference.path, "Reference label", 200),
    kind: ["plan", "contract", "decision", "review"].includes(reference.kind) ? reference.kind : "plan",
    ...(reference.section ? { section: sessionValue(reference.section) } : {}),
    ...(reference.quote ? { quote: shortText(reference.quote, "Reference quote", 360) } : {})
  }));
}

function applyCanonicalPatch(stream, patch) {
  const next = { ...stream };
  if (patch.title != null) next.title = shortText(patch.title, "Title", 160);
  if (patch.summary != null) next.summary = shortText(patch.summary, "Summary", 1200);
  if (patch.status != null) {
    if (!["planned", "active", "blocked", "complete"].includes(patch.status)) throw new Error("Status must be planned, active, blocked, or complete");
    next.status = patch.status;
  }
  if (patch.branch !== undefined) next.branch = patch.branch ? sessionValue(patch.branch) : null;
  if (patch.reviewState != null) next.reviewState = shortText(patch.reviewState, "Current gate", 500);
  if (patch.chunks != null) next.chunks = normalizeChunks(patch.chunks);
  if (patch.prs != null) next.prs = normalizePrs(patch.prs);
  if (patch.references != null) next.references = normalizeReferences(patch.references);
  if (patch.issuePrefixes != null) {
    if (!Array.isArray(patch.issuePrefixes)) throw new Error("issuePrefixes must be an array");
    next.issuePrefixes = [...new Set(patch.issuePrefixes.map((value) => sessionValue(value)).filter(Boolean))];
  }
  if (patch.commits != null) {
    if (!Array.isArray(patch.commits) || patch.commits.some((sha) => !/^[0-9a-f]{7,40}$/i.test(sha))) throw new Error("commits must contain git SHAs");
    next.commits = [...new Set(patch.commits)];
  }
  if (patch.questions != null) {
    if (!Array.isArray(patch.questions)) throw new Error("questions must be an array");
    next.questions = patch.questions.map((question, index) => ({
      id: String(question.id || `Q${index + 1}`),
      text: shortText(question.text, "Question", 600),
      status: question.status === "answered" ? "answered" : "open",
      ...(question.askedAt ? { askedAt: question.askedAt } : {}),
      ...(question.answeredAt ? { answeredAt: question.answeredAt } : {}),
      ...(question.answer ? { answer: String(question.answer) } : {})
    }));
  }
  for (const field of ["fableAgent", "reviewerAgent", "codexExecutor"]) if (patch[field] !== undefined) next[field] = sessionValue(patch[field]);
  next.updatedAt = new Date().toISOString();
  next.updatedBy = patch.updatedBy ? sessionValue(patch.updatedBy) : "fr";
  return next;
}

async function createWorkstream(values) {
  const config = JSON.parse(await readFile(path.join(root, "config/projects.json"), "utf8"));
  const project = config.projects.find((candidate) => candidate.id === values.project);
  if (!project) throw new Error("Unknown project");
  const id = workstreamId(values.id || `${project.id}-${slug(values.title)}`);
  try { await findWorkstream(id); throw new Error("Workstream already exists"); } catch (error) { if (error.message !== "Unknown workstream") throw error; }
  const now = new Date().toISOString();
  const stream = {
    id,
    project: project.id,
    title: shortText(values.title, "Title", 160),
    summary: shortText(values.summary || values.outcome, "Outcome", 1200),
    status: "planned",
    branch: values.branch ? sessionValue(values.branch) : null,
    reviewState: values.reviewState ? shortText(values.reviewState, "Current gate", 500) : "Workstream created; initial plan pending",
    chunks: Array.isArray(values.chunks) ? normalizeChunks(values.chunks) : [],
    questions: [],
    prs: [],
    issuePrefixes: [],
    references: Array.isArray(values.references) ? normalizeReferences(values.references) : [],
    fableAgent: sessionValue(values.fableAgent || values.orchestrator || project.coordinator),
    reviewerAgent: sessionValue(values.reviewerAgent || values.reviewer || project.coordinator),
    codexExecutor: sessionValue(values.codexExecutor),
    assessment: null,
    updatedAt: now,
    updatedBy: values.updatedBy ? sessionValue(values.updatedBy) : "fr"
  };
  const file = path.join(root, "workstreams", `${id}.json`);
  await writeJsonAtomic(file, stream);
  await appendWorkstreamEvent(id, { type: "created", text: `Created workstream: ${stream.summary}`, actor: stream.updatedBy });
  return stream;
}

async function appendWorkstreamEvent(id, event) {
  const eventsDir = path.join(root, "events");
  await mkdir(eventsDir, { recursive: true });
  const record = {
    id: randomUUID(),
    workstreamId: id,
    at: new Date().toISOString(),
    type: String(event.type || "update").toLowerCase(),
    actor: sessionValue(event.actor) || "fr",
    text: shortText(event.text || event.summary || event.type || "Update", "Event text", 1200),
    ...(event.metadata && typeof event.metadata === "object" ? { metadata: event.metadata } : {})
  };
  await appendFile(path.join(eventsDir, `${id}.jsonl`), `${JSON.stringify(record)}\n`);
  return record;
}

async function updateWorkstream(id, patch, eventType = "updated") {
  const { streamFile, stream } = await findWorkstream(id);
  const next = applyCanonicalPatch(stream, patch);
  await writeJsonAtomic(streamFile, next);
  await appendWorkstreamEvent(id, { type: eventType, actor: patch.updatedBy, text: patch.eventText || patch.summary || patch.reviewState || `${eventType} checkpoint` });
  return next;
}

async function recordQuestion(id, values) {
  const { streamFile, stream } = await findWorkstream(id);
  const existing = stream.questions || [];
  const numeric = existing.map((question) => Number(String(question.id).replace(/^Q/i, ""))).filter(Number.isFinite);
  const questionId = values.questionId || `Q${Math.max(0, ...numeric) + 1}`;
  const question = { id: questionId, text: shortText(values.text, "Question", 600), status: "open", askedAt: new Date().toISOString() };
  const next = applyCanonicalPatch(stream, { questions: [...existing, question], updatedBy: values.actor });
  await writeJsonAtomic(streamFile, next);
  await appendWorkstreamEvent(id, { type: "question", actor: values.actor, text: question.text, metadata: { questionId } });
  return question;
}

async function recordDecision(id, values) {
  const { streamFile, stream } = await findWorkstream(id);
  const questions = [...(stream.questions || [])];
  const index = questions.findIndex((question) => question.id === values.questionId);
  if (index < 0) throw new Error("Unknown question");
  const answer = shortText(values.text, "Decision", 800);
  questions[index] = { ...questions[index], status: "answered", answer, answeredAt: new Date().toISOString() };
  const next = applyCanonicalPatch(stream, { questions, updatedBy: values.actor });
  await writeJsonAtomic(streamFile, next);
  await appendWorkstreamEvent(id, { type: "decision", actor: values.actor, text: answer, metadata: { questionId: values.questionId } });
  return questions[index];
}

async function updateSessions(workstreamId, values) {
  const { streamFile, stream } = await findWorkstream(workstreamId);

  stream.fableAgent = sessionValue(values.fableAgent);
  stream.reviewerAgent = sessionValue(values.reviewerAgent);
  stream.codexExecutor = sessionValue(values.codexExecutor);
  await writeJsonAtomic(streamFile, stream);
}

async function currentStream(workstreamId) {
  const data = JSON.parse(await readFile(path.join(root, "data/current.json"), "utf8"));
  const stream = data.workstreams.find((candidate) => candidate.id === workstreamId);
  return stream ? { stream, project: data.projects.find((project) => project.id === stream.project) } : null;
}

function assessmentPrompt(stream, returnTarget, currentHead) {
  const prs = (stream.prs || []).map((pr) => `#${pr.number} (${pr.state || "unknown"}; head ${pr.headRefOid || "unknown"})`).join(", ") || "none yet";
  return `You are the authoritative orchestrator/reviewer for workstream ${stream.id}. Give an honest, evidence-backed assessment using what you have observed in this workstream, the repository's merge-ready-review rules, the current branch, and linked AF issues. Inspect current evidence if needed; do not merely repeat the dashboard summary.

This request authorizes a read-only review and publication of the assessment. Do not wait for separate user confirmation unless completing the review would require a state-changing action outside that scope.

Outcome: ${stream.title}
Dashboard orientation (may be stale): ${stream.liveStatus?.text || stream.summary}
Branch: ${stream.branch || "none"}
Current head: ${currentHead}
Linked PRs: ${prs}

First reconcile the dashboard orientation against the current branch head, PR state, AF issue history, prior plan, and prior reviewer decisions. When they disagree, use the current evidence and call out the drift explicitly.

Explicitly test:
- Is each material mechanism necessary for the stated outcome?
- Is there a materially simpler design that preserves required behavior?
- Has scope drifted or absorbed unrelated work?
- Are ownership, authorization, persistence, compatibility, and failure contracts coherent?
- Does the evidence prove the behavior, or merely exercise the implementation?
- Is there any structural rot where a bounded rebuild would be safer or cheaper than continued patching?
- Is execution contradicting an earlier plan, decision, or constraint?

Publication lane: send the assessment through AF to ${returnTarget}. That inbox is deliberately monitored by the dashboard. If ${returnTarget} is your own AF identity, self-addressing is intentional; publish it there without asking for routing confirmation. Do not reroute it to the executor or workstream agent unless that agent is explicitly named as this publication lane. The structured ASSESSMENT below supersedes a separate compact RATING message.

Use this exact subject:
[ASSESSMENT ${stream.id}] head=${currentHead} outcome_confidence=<0-100> merge_readiness=<0-100> structural_rebuild_risk=<0-100> necessity=<clear|challenged|unjustified> simpler_path=<none_found|candidate|recommended> scope_drift=<none|low|material> contract_integrity=<sound|at_risk|broken> evidence_quality=<strong|partial|weak> verdict=<GO|CONDITIONAL_GO|NO_GO>

Use this exact body shape, keeping each value to one concise line:
primary_risk: <single most important unresolved risk>
next_gate: <evidence or action that clears the current gate>
rationale: <2-4 sentences explaining the judgment, including any simpler alternative or plan contradiction>`;
}

function delegationPrompt(stream, currentHead) {
  return `Perform a fresh, read-only merge-ready review of workstream ${stream.id} at head ${currentHead}. Work only from repository evidence, the linked PR, AF history, and the repository merge-ready-review rules. Do not edit files, commit, push, or send messages.

Outcome: ${stream.title}
Orientation (may be stale): ${stream.liveStatus?.text || stream.summary}
Branch: ${stream.branch || "none"}

Challenge necessity, materially simpler designs, scope drift, contract coherence, evidence quality, structural rot/rebuild risk, and contradictions with prior plans. Return only a JSON object with: verdict (GO, CONDITIONAL_GO, or NO_GO), mergeReadiness (0-100), structuralRisk (0-100), summary (2-4 sentences), findings (array of concise strings), unresolved (array of concise strings).`;
}

async function recordReviewPass(id, values) {
  const head = String(values.head || "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(head)) throw new Error("Review pass requires a git head SHA");
  const verdict = String(values.verdict || "UNKNOWN").toUpperCase();
  if (!["GO", "CONDITIONAL_GO", "NO_GO", "UNKNOWN"].includes(verdict)) throw new Error("Invalid review verdict");
  return appendWorkstreamEvent(id, {
    type: "review_pass",
    actor: values.reviewer || values.actor || "reviewer",
    text: values.summary || `${verdict} review pass at ${head.slice(0, 8)}`,
    metadata: {
      passId: values.passId || randomUUID(), head, verdict,
      reviewer: values.reviewer || values.actor || "reviewer",
      model: values.model || "unknown",
      independent: values.independent !== false,
      findings: Array.isArray(values.findings) ? values.findings : [],
      unresolved: Array.isArray(values.unresolved) ? values.unresolved : [],
      mergeReadiness: Number.isFinite(Number(values.mergeReadiness)) ? Number(values.mergeReadiness) : null,
      structuralRisk: Number.isFinite(Number(values.structuralRisk)) ? Number(values.structuralRisk) : null
    }
  });
}

async function delegateReview(id) {
  const current = await currentStream(id);
  if (!current) throw new Error(`No collected state for ${id}`);
  const { stream, project } = current;
  if (!project?.repoPath) throw new Error(`No repository path configured for ${id}`);
  const head = stream.prs?.find((pr) => pr.state === "OPEN")?.headRefOid || stream.assessment?.currentHead;
  if (!head) throw new Error(`Could not resolve current head for ${id}`);
  const prompt = delegationPrompt(stream, head);
  const { stdout } = await exec("zsh", ["-lic", 'claude-aws -p "$1" --output-format json', "fr-delegate", prompt], { cwd: project.repoPath, timeout: 30 * 60_000, maxBuffer: 10 * 1024 * 1024 });
  const envelope = JSON.parse(stdout);
  const raw = typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result || envelope);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Claude review did not return structured JSON");
  const result = JSON.parse(match[0]);
  const event = await recordReviewPass(id, { ...result, head, reviewer: "claude-aws", model: "anthropic.claude-fable-5", independent: true });
  return { event, result };
}

async function workflowContract(role = "shared") {
  const markdown = await readFile(path.join(root, "docs", "fr-workflow.md"), "utf8");
  if (role === "all") return markdown;
  const sections = markdown.split(/^## /m).slice(1).map((part) => {
    const newline = part.indexOf("\n");
    return { title: part.slice(0, newline).trim(), body: part.slice(newline + 1).trim() };
  });
  const roleTitles = { "repo-coordinator": "Repository coordinator", "workstream-orchestrator": "Workstream orchestrator", executor: "Executor", reviewer: "Reviewer" };
  const wanted = role === "shared" ? ["Shared contract"] : ["Shared contract", roleTitles[role]].filter(Boolean);
  return sections.filter((section) => wanted.includes(section.title)).map((section) => `## ${section.title}\n\n${section.body}`).join("\n\n");
}

async function requestAssessments(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20) throw new Error("Select between 1 and 20 workstreams");
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  const results = [];
  for (const id of uniqueIds) {
    const { stream } = await findWorkstream(id);
    const current = await currentStream(id);
    if (!current) throw new Error(`No collected state for ${id}`);
    const { stream: live, project } = current;
    const recipient = stream.reviewerAgent || stream.fableAgent;
    if (!recipient) throw new Error(`No reviewer or Fable agent configured for ${id}`);
    const subject = `[ASSESSMENT_REQUEST ${id}] Evidence-backed judgment requested for current workstream`;
    const returnTarget = project?.coordinator || stream.fableAgent || recipient;
    let currentHead = live.assessment?.currentHead || live.prs?.find((pr) => pr.headRefName === live.branch)?.headRefOid || null;
    if (!currentHead && project?.repoPath && live.branch) {
      try {
        const resolved = await exec("git", ["-C", project.repoPath, "rev-parse", live.branch], { timeout: 10_000, maxBuffer: 1024 * 1024 });
        currentHead = resolved.stdout.trim();
      } catch { currentHead = "replace-with-current-sha"; }
    }
    const body = assessmentPrompt(live, returnTarget, currentHead || "replace-with-current-sha");
    await exec("af", ["inbox", "send", recipient, subject, "--body", body], { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 });
    results.push({ id, recipient });
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, "http://127.0.0.1");
  const pathname = requestUrl.pathname;
  if (req.method === "POST" && pathname === "/api/refresh") {
    try {
      const { stdout } = await runCollect();
      return send(res, 200, JSON.stringify({ ok: true, message: stdout.trim() }), "application/json; charset=utf-8");
    } catch (error) {
      return send(res, 500, JSON.stringify({ ok: false, error: error.stderr || error.message }), "application/json; charset=utf-8");
    }
  }
    if (req.method === "POST" && pathname === "/api/assessments/request") {
    try {
      const { workstreamIds } = await readJsonBody(req);
      const operation = mutationPromise.then(async () => {
        const requested = await requestAssessments(workstreamIds);
        await runCollect();
        return requested;
      });
      mutationPromise = operation.catch(() => {});
      const requested = await operation;
      return send(res, 200, JSON.stringify({ ok: true, requested }), "application/json; charset=utf-8");
    } catch (error) {
      return send(res, 400, JSON.stringify({ ok: false, error: error.stderr || error.message }), "application/json; charset=utf-8");
    }
  }
    const passRoute = pathname.match(/^\/api\/workstreams\/([^/]+)\/passes$/);
    if (req.method === "POST" && passRoute) {
      try {
        const id = decodeURIComponent(passRoute[1]);
        const values = await readJsonBody(req);
        const operation = mutationPromise.then(async () => { await findWorkstream(id); const event = await recordReviewPass(id, values); await runCollect(); return event; });
        mutationPromise = operation.catch(() => {});
        return send(res, 200, JSON.stringify({ ok: true, event: await operation }), "application/json; charset=utf-8");
      } catch (error) { return send(res, 400, JSON.stringify({ ok: false, error: error.message }), "application/json; charset=utf-8"); }
    }
    const delegationRoute = pathname.match(/^\/api\/workstreams\/([^/]+)\/delegate-review$/);
    if (req.method === "POST" && delegationRoute) {
      try {
        const id = decodeURIComponent(delegationRoute[1]);
        const operation = mutationPromise.then(async () => { const result = await delegateReview(id); await runCollect(); return result; });
        mutationPromise = operation.catch(() => {});
        return send(res, 200, JSON.stringify({ ok: true, ...(await operation) }), "application/json; charset=utf-8");
      } catch (error) { return send(res, 400, JSON.stringify({ ok: false, error: error.stderr || error.message }), "application/json; charset=utf-8"); }
    }
  if (req.method === "POST" && pathname === "/api/workstreams") {
    try {
      const values = await readJsonBody(req);
      const operation = mutationPromise.then(() => createWorkstream(values));
      mutationPromise = operation.catch(() => {});
      const stream = await operation;
      runCollect().catch(() => {});
      return send(res, 201, JSON.stringify({ ok: true, workstream: stream }), "application/json; charset=utf-8");
    } catch (error) {
      return send(res, 400, JSON.stringify({ ok: false, error: error.message }), "application/json; charset=utf-8");
    }
  }
  const workstreamRoute = pathname.match(/^\/api\/workstreams\/([^/]+)$/);
  if (req.method === "PATCH" && workstreamRoute) {
    try {
      const id = decodeURIComponent(workstreamRoute[1]);
      const patch = await readJsonBody(req);
      const operation = mutationPromise.then(() => updateWorkstream(id, patch, patch.eventType || "updated"));
      mutationPromise = operation.catch(() => {});
      const stream = await operation;
      runCollect().catch(() => {});
      return send(res, 200, JSON.stringify({ ok: true, workstream: stream }), "application/json; charset=utf-8");
    } catch (error) {
      return send(res, error.message === "Unknown workstream" ? 404 : 400, JSON.stringify({ ok: false, error: error.message }), "application/json; charset=utf-8");
    }
  }
  const eventRoute = pathname.match(/^\/api\/workstreams\/([^/]+)\/(events|questions|decisions)$/);
  if (req.method === "POST" && eventRoute) {
    try {
      const id = decodeURIComponent(eventRoute[1]);
      const kind = eventRoute[2];
      const values = await readJsonBody(req);
      const operation = mutationPromise.then(async () => {
        await findWorkstream(id);
        const result = kind === "questions" ? await recordQuestion(id, values) : kind === "decisions" ? await recordDecision(id, values) : await appendWorkstreamEvent(id, values);
        return result;
      });
      mutationPromise = operation.catch(() => {});
      const result = await operation;
      runCollect().catch(() => {});
      return send(res, 200, JSON.stringify({ ok: true, result }), "application/json; charset=utf-8");
    } catch (error) {
      return send(res, error.message === "Unknown workstream" ? 404 : 400, JSON.stringify({ ok: false, error: error.message }), "application/json; charset=utf-8");
    }
  }
  const sessionRoute = pathname.match(/^\/api\/workstreams\/([^/]+)\/sessions$/);
  if (req.method === "POST" && sessionRoute) {
    try {
      const workstreamId = decodeURIComponent(sessionRoute[1]);
      const values = await readJsonBody(req);
      const operation = mutationPromise.then(async () => {
        await updateSessions(workstreamId, values);
        await runCollect();
      });
      mutationPromise = operation.catch(() => {});
      await operation;
      return send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    } catch (error) {
      return send(res, error.message === "Unknown workstream" ? 404 : 400, JSON.stringify({ ok: false, error: error.message }), "application/json; charset=utf-8");
    }
  }
  if (req.method !== "GET") return send(res, 405, "Method not allowed");
  if (pathname === "/api/workflow") {
    const role = requestUrl.searchParams.get("role") || "shared";
    return send(res, 200, JSON.stringify({ role, markdown: await workflowContract(role) }), "application/json; charset=utf-8");
  }
  if (pathname === "/api/workstreams") return send(res, 200, JSON.stringify({ workstreams: await listCanonicalWorkstreams() }), "application/json; charset=utf-8");
  if (workstreamRoute) {
    try { return send(res, 200, JSON.stringify((await findWorkstream(decodeURIComponent(workstreamRoute[1]))).stream), "application/json; charset=utf-8"); }
    catch { return send(res, 404, JSON.stringify({ error: "Unknown workstream" }), "application/json; charset=utf-8"); }
  }
  if (pathname === "/" || pathname === "/index.html") return serveFile(res, "public/index.html");
  if (pathname === "/app.js") return serveFile(res, "public/app.js");
  if (pathname === "/styles.css") return serveFile(res, "public/styles.css");
  if (pathname === "/data/current.json") return serveFile(res, "data/current.json");
  return send(res, 404, "Not found");
});

server.listen(port, "127.0.0.1", () => console.log(`Field Report: http://127.0.0.1:${port}`));
runCollect().catch((error) => console.error(`Initial refresh failed: ${error.message}`));
