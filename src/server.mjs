import http from "node:http";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectBattlefield, readOrCollectBattlefield } from "./collect.mjs";
import { BINARIES, defaultProbe, MODEL_LISTS } from "./doctor.mjs";
import { LAUNCHERS, normalizeId, readRawConfig, REVIEW_ROLES, saveSeatConfig, SEAT_PURPOSES } from "./seats.mjs";
import { createStore, PLAN_SERVICES, TODO_SERVICES } from "./store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = {
  "/": ["index.html", "text/html"],
  "/index.html": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/settings": ["settings.html", "text/html"],
  "/settings.js": ["settings.js", "text/javascript"],
  "/styles.css": ["styles.css", "text/css"]
};
const MAX_BODY = 64 * 1024;

function send(res, status, body, type) {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(body);
}
const json = (res, status, value) => send(res, status, JSON.stringify(value), "application/json");
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
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error("Request too large")); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function projectList(store) {
  const projects = await store.projects();
  return Promise.all(projects.map(async (project) => ({
    ...project,
    repoExists: await access(project.repoPath).then(() => true, () => false),
    branches: (await store.trackedBranches(project.id)).length
  })));
}

export async function modelSuggestions({ probe = defaultProbe(), configs = [] } = {}) {
  const byLaunch = Object.fromEntries(LAUNCHERS.map((launch) => [launch, new Map()]));
  for (const raw of configs) {
    for (const seat of Object.values(raw?.seats || {})) {
      for (const model of seat?.models || []) {
        if (byLaunch[model.launch] && typeof model.id === "string" && model.id) {
          byLaunch[model.launch].set(`${model.id} ${model.cliModel || ""}`, { id: model.id, cliModel: model.cliModel || null });
        }
      }
    }
  }
  const errors = {};
  for (const [launch, { args, parse }] of Object.entries(MODEL_LISTS)) {
    const listed = await probe.run(BINARIES[launch], args);
    if (listed.code === 0) {
      for (const cliModel of parse(listed.stdout)) {
        const id = normalizeId(cliModel);
        if (id) byLaunch[launch].set(`${id} ${cliModel}`, { id, cliModel: cliModel === id ? null : cliModel });
      }
    } else if (listed.code !== "ENOENT") {
      errors[launch] = `${BINARIES[launch]} ${args.join(" ")} failed`;
    }
  }
  return {
    byLaunch: Object.fromEntries(Object.entries(byLaunch).map(([launch, models]) => [launch, [...models.values()]])),
    errors
  };
}

export function createServer({ port, store = createStore(), probe = defaultProbe(), collectFn = collectBattlefield }) {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname.startsWith("/api/") && !hostsFor(port).includes(req.headers.host)) return json(res, 403, { error: "Unknown host" });

    if (req.method === "POST" && pathname === "/api/refresh") {
      if (!fromThisPage(req, port)) return json(res, 403, { error: "Battlefield can only be refreshed from the Field Report UI" });
      await body(req).catch(() => "");
      try {
        return json(res, 200, await collectFn({ store, outputFile: path.join(store.root, "projection.json") }));
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
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
        if (pathname === "/api/projects/remove") await store.removeProject(input.id);
        else await store.updateProject(input.id, { label: input.label, githubRepo: input.githubRepo, baseBranch: input.baseBranch, todos: input.todos, plans: input.plans });
        return json(res, 200, { projects: await projectList(store), todoServices: TODO_SERVICES, planServices: PLAN_SERVICES });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }

    if (req.method !== "GET") return send(res, 405, "Method not allowed", "text/plain");

    if (pathname === "/api/state") {
      try { return json(res, 200, await readOrCollectBattlefield({ store, collectFn })); }
      catch (error) { return json(res, 500, { error: error.message }); }
    }

    if (pathname === "/api/projects") {
      try { return json(res, 200, { projects: await projectList(store), todoServices: TODO_SERVICES, planServices: PLAN_SERVICES }); }
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
      try { return json(res, 200, { ...(await readRawConfig()), roles: REVIEW_ROLES, purposes: SEAT_PURPOSES, launchers: LAUNCHERS }); }
      catch (error) { return json(res, 500, { error: error.message }); }
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
    console.log(`Field Report battlefield: http://127.0.0.1:${port}/ (settings: http://127.0.0.1:${port}/settings)`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
