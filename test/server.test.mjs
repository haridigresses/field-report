import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer, fromThisPage, modelSuggestions } from "../src/server.mjs";
import { createStore } from "../src/store.mjs";
import { EXAMPLE_SEATS } from "./support/seats.mjs";

// In-process HTTP dispatch helper so every route and CSRF/DNS-rebinding check
// runs deterministically even inside sandboxes that forbid TCP connect().
function dispatch(server, port, { method = "GET", url = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host: `127.0.0.1:${port}`, ...headers };
    req.destroy = () => {};

    let status = 200;
    let resHeaders = {};
    const chunks = [];
    const res = {
      writeHead(code, hdrs = {}) {
        status = code;
        resHeaders = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]));
      },
      end(data) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status,
          headers: resHeaders,
          text,
          json: () => JSON.parse(text)
        });
      }
    };

    try {
      server.emit("request", req, res);
      queueMicrotask(() => {
        if (body != null) req.emit("data", Buffer.from(body));
        req.emit("end");
      });
    } catch (err) {
      reject(err);
    }
  });
}

test("fromThisPage blocks cross-origin and DNS-rebound requests", () => {
  assert.equal(fromThisPage({ headers: { host: "127.0.0.1:4177", origin: "http://127.0.0.1:4177", "content-type": "application/json" } }, 4177), true);
  assert.equal(fromThisPage({ headers: { host: "attacker.example", origin: "http://127.0.0.1:4177", "content-type": "application/json" } }, 4177), false);
  assert.equal(fromThisPage({ headers: { host: "127.0.0.1:4177", origin: "https://evil.example", "content-type": "application/json" } }, 4177), false);
  assert.equal(fromThisPage({ headers: { host: "127.0.0.1:4177", "content-type": "text/plain" } }, 4177), false);
});

test("modelSuggestions combines cursor, agy, and devin CLI model lists with configured models", async () => {
  const probe = {
    run: async (bin) => {
      if (bin === "cursor-agent") return { code: 0, stdout: "grok-4.6-high - Grok 4.6\n" };
      if (bin === "agy") return { code: 0, stdout: "gemini-4-neon-high\tGemini 4 Neon\n" };
      if (bin === "devin") return { code: 0, stdout: JSON.stringify({ families: [{ slug: "swe-1.6", aliases: [], variants: [] }] }) };
      return { code: "ENOENT", stdout: "" };
    }
  };
  const config = { seats: { intent: { models: [{ id: "claude-fable-5-1", launch: "claude" }] } } };
  const result = await modelSuggestions({ probe, configs: [config] });
  assert.deepEqual(result.byLaunch.claude, [{ id: "claude-fable-5-1", cliModel: null }]);
  assert.deepEqual(result.byLaunch.cursor, [{ id: "grok-4.6", cliModel: "grok-4.6-high" }]);
  assert.deepEqual(result.byLaunch.agy, [{ id: "gemini-4-neon", cliModel: "gemini-4-neon-high" }]);
  assert.deepEqual(result.byLaunch.devin, [{ id: "swe-1.6", cliModel: null }]);
});

test("saving writes through a symlinked config instead of replacing the link", async () => {
  const { symlink, lstat } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(os.tmpdir(), "fr-settings-link-"));
  const real = path.join(dir, "dotfiles-config.json");
  const link = path.join(dir, "config.json");
  await writeFile(real, await readFile(EXAMPLE_SEATS, "utf8"));
  await symlink(real, link);
  const { saveSeatConfig } = await import("../src/seats.mjs");
  const example = JSON.parse(await readFile(EXAMPLE_SEATS, "utf8"));
  const raw = { ...example, seats: { ...example.seats, design: { models: [{ id: "gemini-4-neon", launch: "agy" }] } } };
  await saveSeatConfig(raw, link);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(real, "utf8")).seats.design.models[0].id, "gemini-4-neon");
});

test("settings HTTP endpoints serve defaults, validate config saves, block CSRF/rebinding, redirect / to /settings, and edit/remove projects", async () => {
  const port = 4177;
  const dir = await mkdtemp(path.join(os.tmpdir(), "fr-settings-http-"));
  const previousConfig = process.env.FIELD_REPORT_CONFIG;
  process.env.FIELD_REPORT_CONFIG = path.join(dir, "config.json");
  const store = createStore(path.join(dir, "state"));
  await store.saveProject({ id: "live", label: "Live", repoPath: dir });
  const server = createServer({ port, store });

  try {
    const redirect = await dispatch(server, port, { url: "/" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, "/settings");
    assert.equal((await dispatch(server, port, { url: "/settings" })).status, 200);

    const initial = (await dispatch(server, port, { url: "/api/config" })).json();
    assert.equal(initial.exists, false);
    assert.deepEqual(initial.roles, ["correctness", "design", "intent"]);

    const rebound = await dispatch(server, port, { url: "/api/config", headers: { host: "attacker.example" } });
    assert.equal(rebound.status, 403);

    const badOrigin = await dispatch(server, port, {
      method: "POST",
      url: "/api/config",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify(initial.raw)
    });
    assert.equal(badOrigin.status, 403);

    const saved = await dispatch(server, port, {
      method: "POST",
      url: "/api/config",
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify(initial.raw)
    });
    assert.equal(saved.status, 200);

    const broken = { ...initial.raw, seats: { ...initial.raw.seats, intent: { models: [] } } };
    const rejected = await dispatch(server, port, {
      method: "POST",
      url: "/api/config",
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify(broken)
    });
    assert.equal(rejected.status, 400);

    const updated = await dispatch(server, port, {
      method: "POST",
      url: "/api/projects/update",
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "live", baseBranch: "develop", todos: { service: "linear", reference: "ENG" } })
    });
    assert.equal(updated.status, 200);
    assert.equal((await store.project("live")).baseBranch, "develop");

    const removed = await dispatch(server, port, {
      method: "POST",
      url: "/api/projects/remove",
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "live" })
    });
    assert.equal(removed.status, 200);
    assert.equal((await store.projects()).length, 0);
  } finally {
    process.env.FIELD_REPORT_CONFIG = previousConfig;
  }
});
