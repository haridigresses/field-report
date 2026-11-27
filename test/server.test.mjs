import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "../src/server.mjs";
import { EXAMPLE_SEATS } from "./support/seats.mjs";

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function settingsServer() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fr-settings-"));
  process.env.FIELD_REPORT_CONFIG = path.join(dir, "config.json");
  const port = await freePort();
  const server = createServer({ port, store: { root: dir } });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}`;
  const post = (body, headers = {}) => fetch(`${url}/api/config`, { method: "POST", headers: { "content-type": "application/json", origin: url, ...headers }, body });
  return { server, url, post, file: process.env.FIELD_REPORT_CONFIG };
}

test("settings page shows the shipped defaults until a config is saved, then saves only valid configs", async () => {
  const { server, url, post, file } = await settingsServer();
  try {
    assert.equal((await fetch(`${url}/settings`)).status, 200);
    const initial = await (await fetch(`${url}/api/config`)).json();
    assert.equal(initial.exists, false);
    assert.deepEqual(initial.raw, JSON.parse(await readFile(EXAMPLE_SEATS, "utf8")));
    assert.deepEqual(initial.roles, ["correctness", "design", "intent"]);
    assert.deepEqual(Object.keys(initial.purposes), initial.roles, "every seat has a purpose to show");

    const config = { ...initial.raw, plans: { home: "ref", reference: "Engineering plans" } };
    const saved = await post(JSON.stringify(config));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).exists, true);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), config);

    const broken = { ...config, seats: { ...config.seats, "intent": { models: [] } } };
    const rejected = await post(JSON.stringify(broken));
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /intent needs a non-empty models list/);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), config, "a rejected save leaves the file alone");
  } finally { server.close(); }
});

test("config saves come only from the settings page", async () => {
  const { server, url, post, file } = await settingsServer();
  try {
    await writeFile(file, await readFile(EXAMPLE_SEATS, "utf8"));
    const before = await readFile(file, "utf8");
    const body = before;
    assert.equal((await post(body, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post(body, { "content-type": "text/plain" })).status, 403);
    // fetch drops a custom Host header, so send the rebinding case by hand.
    const rebound = await new Promise((resolve, reject) => {
      const request = http.request(`${url}/api/config`, { method: "POST", headers: { host: "attacker.example", "content-type": "application/json" } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
      request.end(body);
    });
    assert.equal(rebound, 403);
    const reboundRead = await new Promise((resolve, reject) => {
      const request = http.request(`${url}/api/config`, { headers: { host: "attacker.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
      request.end();
    });
    assert.equal(reboundRead, 403);
    assert.equal(await readFile(file, "utf8"), before);
  } finally { server.close(); }
});

test("saving writes through a symlinked config instead of replacing the link", async () => {
  const { symlink, lstat } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(os.tmpdir(), "fr-settings-link-"));
  const real = path.join(dir, "dotfiles-config.json");
  const link = path.join(dir, "config.json");
  await writeFile(real, await readFile(EXAMPLE_SEATS, "utf8"));
  await symlink(real, link);
  const { saveSeatConfig } = await import("../src/seats.mjs");
  const raw = { ...JSON.parse(await readFile(EXAMPLE_SEATS, "utf8")), plans: { home: "notion", reference: "Plans" } };
  await saveSeatConfig(raw, link);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(real, "utf8")).plans.reference, "Plans");
});

test("projects can be edited and removed from the settings page, removal deletes their workstreams only when asked", async () => {
  const { createStore } = await import("../src/store.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "fr-settings-projects-"));
  process.env.FIELD_REPORT_CONFIG = path.join(dir, "config.json");
  const store = createStore(path.join(dir, "state"));
  await store.saveProject({ id: "live", label: "Live", repoPath: dir });
  await store.saveProject({ id: "stale", label: "Stale", repoPath: path.join(dir, "gone") });
  await store.saveWorkstream({ id: "stale-work", project: "stale", title: "Old", outcome: "Old outcome", summary: "Old outcome", branch: "old" });
  await assert.rejects(store.removeProject("stale"), /has 1 workstream \(stale-work\).*--with-workstreams/);
  const port = await freePort();
  const server = createServer({ port, store });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}`;
  const post = (route, payload) => fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(payload) });
  try {
    const listed = (await (await fetch(`${url}/api/projects`)).json()).projects;
    assert.deepEqual(listed.map((project) => [project.id, project.repoExists, project.workstreams]), [["live", true, 0], ["stale", false, 1]]);
    const updated = await post("/api/projects/update", { id: "live", baseBranch: "develop", tracker: { kind: "linear", team: "ENG", label: "agent-todo" } });
    assert.equal(updated.status, 200);
    assert.deepEqual((await store.project("live")).tracker, { kind: "linear", team: "ENG", label: "agent-todo" });
    assert.equal((await post("/api/projects/update", { id: "live", tracker: { kind: "linear", team: "ENG TEAM" } })).status, 400);
    const stale = await post("/api/projects/remove", { id: "stale", withWorkstreams: true, expectedWorkstreams: 0 });
    assert.equal(stale.status, 400);
    assert.match((await stale.json()).error, /now has 1 workstreams, not 0; reload/);
    assert.equal((await post("/api/projects/remove", { id: "stale", withWorkstreams: true, expectedWorkstreams: 1 })).status, 200);
    await post("/api/projects/update", { id: "live", githubRepo: "owner/live" });
    assert.equal((await store.project("live")).githubRepo, "owner/live");
    await post("/api/projects/update", { id: "live", githubRepo: "" });
    assert.equal((await store.project("live")).githubRepo, null, "an emptied field clears the repo");
    assert.deepEqual((await store.projects()).map((project) => project.id), ["live"]);
    await assert.rejects(store.workstream("stale-work"), /Unknown workstream/);
    assert.equal((await fetch(`${url}/api/projects/remove`, { method: "POST", headers: { "content-type": "text/plain", origin: url }, body: "{\"id\":\"live\"}" })).status, 403);
  } finally { server.close(); }
});

test("model suggestions combine the account's Cursor models with configured ones", async () => {
  const { modelSuggestions } = await import("../src/server.mjs");
  const probe = { run: async () => ({ code: 0, stdout: "Available models\n\nauto - Auto\ngrok-4.6-high - Grok 4.6 High\nclaude-opus-5-5 - Opus\n" }) };
  const config = { seats: { intent: { models: [{ id: "claude-fable-5-1", launch: "claude" }] } } };
  const result = await modelSuggestions({ probe, configs: [config] });
  assert.deepEqual(result.byLaunch.claude, [{ id: "claude-fable-5-1", cliModel: null }]);
  assert.deepEqual(result.byLaunch.cursor, [{ id: "auto", cliModel: null }, { id: "grok-4.6", cliModel: "grok-4.6-high" }, { id: "claude-opus-5-5", cliModel: null }]);
  assert.equal(result.cursorError, null);
  const missing = await modelSuggestions({ probe: { run: async () => ({ code: "ENOENT", stdout: "" }) }, configs: [] });
  assert.equal(missing.cursorError, "cursor-agent is not installed");
});
