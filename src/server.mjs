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
    return { id: slug(chunk.id || chunk.title || `milestone-${index + 1}`), title: shortText(chunk.title, "Chunk title", 240), status };
  });
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
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
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
