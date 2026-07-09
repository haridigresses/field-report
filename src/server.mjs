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

async function updateSessions(workstreamId, values) {
  const workstreamDir = path.join(root, "workstreams");
  const files = (await readdir(workstreamDir)).filter((file) => file.endsWith(".json"));
  let streamFile;
  let stream;
  for (const file of files) {
    const candidate = JSON.parse(await readFile(path.join(workstreamDir, file), "utf8"));
    if (candidate.id === workstreamId) {
      streamFile = path.join(workstreamDir, file);
      stream = candidate;
      break;
    }
  }
  if (!stream) throw new Error("Unknown workstream");

  stream.fableAgent = sessionValue(values.fableAgent);
  stream.reviewerAgent = sessionValue(values.reviewerAgent);
  stream.codexExecutor = sessionValue(values.codexExecutor);

  const projectFile = path.join(root, "config/projects.json");
  const projectConfig = JSON.parse(await readFile(projectFile, "utf8"));
  const project = projectConfig.projects.find((item) => item.id === stream.project);
  if (!project) throw new Error("Workstream project is not configured");
  project.coordinator = sessionValue(values.coordinator);

  await writeJsonAtomic(streamFile, stream);
  await writeJsonAtomic(projectFile, projectConfig);
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
