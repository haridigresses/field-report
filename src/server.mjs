import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4177);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

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

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/refresh") {
    try {
      const { stdout } = await exec(process.execPath, [path.join(root, "src/collect.mjs")], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
      return send(res, 200, JSON.stringify({ ok: true, message: stdout.trim() }), "application/json; charset=utf-8");
    } catch (error) {
      return send(res, 500, JSON.stringify({ ok: false, error: error.stderr || error.message }), "application/json; charset=utf-8");
    }
  }
  if (req.method !== "GET") return send(res, 405, "Method not allowed");
  if (req.url === "/" || req.url === "/index.html") return serveFile(res, "public/index.html");
  if (req.url === "/app.js") return serveFile(res, "public/app.js");
  if (req.url === "/styles.css") return serveFile(res, "public/styles.css");
  if (req.url === "/data/current.json") return serveFile(res, "data/current.json");
  return send(res, 404, "Not found");
});

await exec(process.execPath, [path.join(root, "src/collect.mjs")], { cwd: root });
server.listen(port, "127.0.0.1", () => console.log(`Workstream Control: http://127.0.0.1:${port}`));
