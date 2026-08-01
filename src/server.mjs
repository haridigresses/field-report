import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "./collect.mjs";
import { createStore } from "./store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createStore();
const port = Number(process.env.PORT || 4177);

function send(res, status, body, type) { res.writeHead(status, { "content-type": type, "cache-control": "no-store" }); res.end(body); }
async function file(res, name, type) { try { send(res, 200, await readFile(path.join(root, "public", name)), type); } catch { send(res, 404, "Not found", "text/plain"); } }

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  if (req.method === "POST" && pathname === "/api/refresh") {
    try { return send(res, 200, JSON.stringify(await collect()), "application/json"); }
    catch (error) { return send(res, 500, JSON.stringify({ error: error.message }), "application/json"); }
  }
  if (req.method !== "GET") return send(res, 405, "Read-only server", "text/plain");
  if (pathname === "/api/state") {
    try { return send(res, 200, await readFile(path.join(store.root, "projection.json")), "application/json"); }
    catch { return send(res, 200, JSON.stringify(await collect()), "application/json"); }
  }
  if (pathname === "/" || pathname === "/index.html") return file(res, "index.html", "text/html; charset=utf-8");
  if (pathname === "/app.js") return file(res, "app.js", "text/javascript; charset=utf-8");
  if (pathname === "/styles.css") return file(res, "styles.css", "text/css; charset=utf-8");
  return send(res, 404, "Not found", "text/plain");
});

server.listen(port, "127.0.0.1", async () => { await collect().catch(() => {}); console.log(`Field Report: http://127.0.0.1:${port}`); });
