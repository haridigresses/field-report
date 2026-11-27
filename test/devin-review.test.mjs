import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs, reviewConfig, runReview } from "../bin/fr-devin-review.mjs";

const base = "a".repeat(40);
const head = "b".repeat(40);

test("review config keeps only the user's account and sets everything else", () => {
  const user = { version: 1, devin: { org_id: "org" }, shell: { setup_complete: true }, mcpServers: { linear: { url: "x" } }, hooks: { PreToolUse: [] }, permissions: { allow: ["edit", "Exec(rm)"] }, sandbox: { enabled: true }, permission_mode: "dangerous", future_key: 1 };
  const config = reviewConfig(user, base, head);
  assert.deepEqual(Object.keys(config).sort(), ["devin", "hooks", "mcpServers", "permissions", "read_config_from", "shell", "version"]);
  assert.deepEqual(config.devin, { org_id: "org" });
  assert.deepEqual(config.mcpServers, {});
  assert.deepEqual(config.hooks, {});
  assert.ok(Object.values(config.read_config_from).every((value) => value === false));
  assert.equal(config.read_config_from.cloud, false);
  assert.deepEqual(config.permissions, { allow: ["read", "grep", "glob", `Exec(git diff --no-ext-diff --no-textconv ${base} ${head} --)`], deny: ["edit", "mcp__*"], ask: [] });
  assert.throws(() => reviewConfig({}, "main", head), /40-character SHAs/);
});

test("arguments are exactly base, head, model, and prompt file", () => {
  assert.deepEqual(parseArgs(["--base", base, "--head", head, "--model", "swe-2", "--prompt-file", "/tmp/p"]), { base, head, model: "swe-2", "prompt-file": "/tmp/p" });
  assert.throws(() => parseArgs(["--base", base, "--head", head, "--model", "swe-2"]), /missing --prompt-file/);
  assert.throws(() => parseArgs(["--base", base, "--sandbox", "x"]), /usage/);
});

test("runs devin headless with the review config, then deletes it", async () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "fr-devin-xdg-"));
  mkdirSync(path.join(xdg, "devin"));
  writeFileSync(path.join(xdg, "devin", "config.json"), JSON.stringify({ devin: { org_id: "org" } }));
  let seen;
  const spawnFn = (command, args) => {
    const config = args[args.indexOf("--config") + 1];
    seen = { command, args, config, written: JSON.parse(readFileSync(config, "utf8")) };
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };
  const repo = mkdtempSync(path.join(os.tmpdir(), "fr-devin-repo-"));
  const code = await runReview(["--base", base, "--head", head, "--model", "swe-2", "--prompt-file", "/tmp/p"], { env: { XDG_CONFIG_HOME: xdg }, spawnFn, cwd: repo });
  assert.equal(code, 0);
  assert.equal(seen.command, "devin");
  assert.deepEqual(seen.args.filter((arg) => arg !== seen.config), ["--config", "--permission-mode", "auto", "--respect-workspace-trust", "false", "--model", "swe-2", "--prompt-file", "/tmp/p", "-p"]);
  assert.deepEqual(seen.written.devin, { org_id: "org" });
  assert.equal(existsSync(seen.config), false);
});

test("refuses a checkout with Devin project config", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "fr-devin-repo-"));
  mkdirSync(path.join(repo, ".devin"));
  writeFileSync(path.join(repo, ".devin", "config.json"), "{}");
  let spawned = false;
  await assert.rejects(runReview(["--base", base, "--head", head, "--model", "swe-2", "--prompt-file", "/tmp/p"], { env: {}, cwd: repo, spawnFn: () => { spawned = true; } }), /Devin project config \(\.devin\/config\.json\)/);
  assert.equal(spawned, false);
});
