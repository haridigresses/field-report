import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4177);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
let refreshPromise;
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
    refreshPromise = exec(process.execPath, [path.join(root, "src/collect.mjs")], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000
    }).finally(() => { refreshPromise = undefined; });
  }
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

Outcome: ${stream.title}
Current situation: ${stream.liveStatus?.text || stream.summary}
Branch: ${stream.branch || "none"}
Current head: ${currentHead}
Linked PRs: ${prs}

Explicitly test:
- Is each material mechanism necessary for the stated outcome?
- Is there a materially simpler design that preserves required behavior?
- Has scope drifted or absorbed unrelated work?
- Are ownership, authorization, persistence, compatibility, and failure contracts coherent?
- Does the evidence prove the behavior, or merely exercise the implementation?
- Is there any structural rot where a bounded rebuild would be safer or cheaper than continued patching?
- Is execution contradicting an earlier plan, decision, or constraint?

Send the assessment through AF to ${returnTarget} with this exact subject:
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
  if (pathname === "/" || pathname === "/index.html") return serveFile(res, "public/index.html");
  if (pathname === "/app.js") return serveFile(res, "public/app.js");
  if (pathname === "/styles.css") return serveFile(res, "public/styles.css");
  if (pathname === "/data/current.json") return serveFile(res, "data/current.json");
  return send(res, 404, "Not found");
});

server.listen(port, "127.0.0.1", () => console.log(`Workstream Control: http://127.0.0.1:${port}`));
runCollect().catch((error) => console.error(`Initial refresh failed: ${error.message}`));
