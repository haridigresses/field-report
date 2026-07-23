import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { createFieldReportStore } from "./store.mjs";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4177);
const store = createFieldReportStore(root);
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
        const requested = await store.requestAssessments(workstreamIds);
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
        const batch = Array.isArray(values.passes);
        const operation = mutationPromise.then(async () => { await store.findWorkstream(id); const result = batch ? await store.recordReviewPasses(id, values.passes) : await store.recordReviewPass(id, values); await runCollect(); return result; });
        mutationPromise = operation.catch(() => {});
        const result = await operation;
        return send(res, 200, JSON.stringify(batch ? { ok: true, events: result } : { ok: true, event: result }), "application/json; charset=utf-8");
      } catch (error) { return send(res, 400, JSON.stringify({ ok: false, error: error.message }), "application/json; charset=utf-8"); }
    }
  if (req.method === "POST" && pathname === "/api/workstreams") {
    try {
      const values = await readJsonBody(req);
      const operation = mutationPromise.then(() => store.createWorkstream(values));
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
      const operation = mutationPromise.then(() => store.updateWorkstream(id, patch, patch.eventType || "updated"));
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
        await store.findWorkstream(id);
        const result = kind === "questions" ? await store.recordQuestion(id, values) : kind === "decisions" ? await store.recordDecision(id, values) : await store.appendWorkstreamEvent(id, values);
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
        await store.updateSessions(workstreamId, values);
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
    return send(res, 200, JSON.stringify({ role, markdown: await store.workflowContract(role) }), "application/json; charset=utf-8");
  }
  if (pathname === "/api/workstreams") return send(res, 200, JSON.stringify({ workstreams: await store.listCanonicalWorkstreams() }), "application/json; charset=utf-8");
  const mrrRoute = pathname.match(/^\/api\/workstreams\/([^/]+)\/mrr$/);
  if (mrrRoute) {
    try { return send(res, 200, JSON.stringify(await store.mrrStatus(decodeURIComponent(mrrRoute[1]))), "application/json; charset=utf-8"); }
    catch (error) { return send(res, 400, JSON.stringify({ error: error.message }), "application/json; charset=utf-8"); }
  }
  if (workstreamRoute) {
    try { return send(res, 200, JSON.stringify((await store.findWorkstream(decodeURIComponent(workstreamRoute[1]))).stream), "application/json; charset=utf-8"); }
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
