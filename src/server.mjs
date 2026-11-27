import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "./collect.mjs";
import { createStore } from "./store.mjs";
import { access } from "node:fs/promises";
import { LAUNCHERS, normalizeId, PLAN_HOMES, readRawConfig, REVIEW_ROLES, saveSeatConfig, SEAT_PURPOSES } from "./seats.mjs";
import { cursorModelIds, defaultProbe } from "./doctor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = { "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"], "/settings": ["settings.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/settings.js": ["settings.js", "text/javascript"], "/styles.css": ["styles.css", "text/css"] };
const MAX_BODY = 64 * 1024;

function send(res, status, body, type) { res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }); res.end(body); }
const json = (res, status, value) => send(res, status, JSON.stringify(value), "application/json");

// The server listens on 127.0.0.1, but any page in the browser can still send
// it requests. Writes must come from this page: our own Host (no DNS
// rebinding), our own Origin, and a JSON body (cross-site forms cannot send one
// without a preflight this server never answers).
const hostsFor = (port) => [`127.0.0.1:${port}`, `localhost:${port}`];

export function fromThisPage(req, port) {
  const hosts = hostsFor(port);
  if (!hosts.includes(req.headers.host)) return false;
  if (req.headers.origin && !hosts.some((host) => req.headers.origin === `http://${host}`)) return false;
  return String(req.headers["content-type"] || "").split(";")[0].trim() === "application/json";
}

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => { size += chunk.length; if (size > MAX_BODY) { reject(new Error("Request too large")); req.destroy(); } else chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function projectList(store) {
  const [projects, streams] = await Promise.all([store.projects(), store.workstreams()]);
  return Promise.all(projects.map(async (project) => ({
    ...project,
    repoExists: await access(project.repoPath).then(() => true, () => false),
    workstreams: streams.filter((stream) => stream.project === project.id).length
  })));
}

// Suggestions only: the page offers them, and any typed id still works.
// Cursor lists the account's models; codex and claude cannot, so their
// suggestions come from the config and the shipped example.
export async function modelSuggestions({ probe = defaultProbe(), configs = [] } = {}) {
  const byLaunch = Object.fromEntries(LAUNCHERS.map((launch) => [launch, new Map()]));
  for (const raw of configs) {
    for (const seat of Object.values(raw?.seats || {})) {
      for (const model of seat?.models || []) {
        if (byLaunch[model.launch] && typeof model.id === "string" && model.id) byLaunch[model.launch].set(`${model.id} ${model.cliModel || ""}`, { id: model.id, cliModel: model.cliModel || null });
      }
    }
  }
  let cursorError = null;
  const listed = await probe.run("cursor-agent", ["--list-models"]);
  if (listed.code === 0) {
    for (const cliModel of cursorModelIds(listed.stdout)) {
      const id = normalizeId(cliModel);
      if (id) byLaunch.cursor.set(`${id} ${cliModel}`, { id, cliModel: cliModel === id ? null : cliModel });
    }
  } else cursorError = listed.code === "ENOENT" ? "cursor-agent is not installed" : "cursor-agent --list-models failed; sign in with cursor-agent login";
  return { byLaunch: Object.fromEntries(Object.entries(byLaunch).map(([launch, models]) => [launch, [...models.values()]])), cursorError };
}

export function createServer({ port, store = createStore(), probe = defaultProbe() }) {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    // A DNS-rebound name reaches this server too; only our own host may call the API.
    if (pathname.startsWith("/api/") && !hostsFor(port).includes(req.headers.host)) return json(res, 403, { error: "Unknown host" });
    if (req.method === "POST" && pathname === "/api/refresh") {
      try { return json(res, 200, await collect()); }
      catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (req.method === "POST" && pathname === "/api/config") {
      if (!fromThisPage(req, port)) return json(res, 403, { error: "Config can only be saved from the Field Report settings page" });
      let raw;
      try { raw = JSON.parse(await body(req)); } catch (error) { return json(res, 400, { error: error.message }); }
      try { await saveSeatConfig(raw); return json(res, 200, await readRawConfig()); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === "POST" && (pathname === "/api/projects/update" || pathname === "/api/projects/remove")) {
      if (!fromThisPage(req, port)) return json(res, 403, { error: "Projects can only be changed from the Field Report settings page" });
      let input;
      try { input = JSON.parse(await body(req)); } catch (error) { return json(res, 400, { error: error.message }); }
      try {
        if (pathname === "/api/projects/remove") await store.removeProject(input.id, { withWorkstreams: input.withWorkstreams === true, expectedWorkstreams: Number.isInteger(input.expectedWorkstreams) ? input.expectedWorkstreams : null });
        else await store.updateProject(input.id, { label: input.label, githubRepo: input.githubRepo, baseBranch: input.baseBranch, tracker: input.tracker });
        return json(res, 200, { projects: await projectList(store) });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method !== "GET") return send(res, 405, "Method not allowed", "text/plain");
    if (pathname === "/api/projects") {
      try { return json(res, 200, { projects: await projectList(store) }); }
      catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (pathname === "/api/models") {
      try {
        const current = await readRawConfig();
        const example = JSON.parse(await readFile(path.join(root, "config", "config.example.json"), "utf8"));
        return json(res, 200, await modelSuggestions({ probe, configs: [current.raw, example] }));
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (pathname === "/api/config") {
      try { return json(res, 200, { ...(await readRawConfig()), roles: REVIEW_ROLES, purposes: SEAT_PURPOSES, launchers: LAUNCHERS, planHomes: PLAN_HOMES }); }
      catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (pathname === "/api/state") {
      try { return send(res, 200, await readFile(path.join(store.root, "projection.json")), "application/json"); }
      catch { return json(res, 200, await collect()); }
    }
    const page = PAGES[pathname];
    if (!page) return send(res, 404, "Not found", "text/plain");
    try { return send(res, 200, await readFile(path.join(root, "public", page[0])), page[1]); }
    catch { return send(res, 404, "Not found", "text/plain"); }
  });
}

export function startServer(port = Number(process.env.PORT || 4177)) {
  const server = createServer({ port });
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${port} is in use; try fr ui --port <n>` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Field Report: http://127.0.0.1:${port} (settings: http://127.0.0.1:${port}/settings)`);
    collect().catch(() => {});
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
