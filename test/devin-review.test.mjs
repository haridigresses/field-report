import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs, projectConfigs, reviewConfig, runReview } from "../bin/fr-devin-review.mjs";

const base = "a".repeat(40);
const head = "b".repeat(40);

test("reviewConfig preserves only account/shell keys, tolerates non-object user config, and locks permissions", () => {
  const cfg = reviewConfig({ version: 2, devin: { token: "t" }, shell: { zsh: true }, mcpServers: { bad: {} }, permissions: { allow: ["*"] } }, base, head);
  assert.deepEqual(cfg.devin, { token: "t" });
  assert.deepEqual(cfg.mcpServers, {});
  assert.deepEqual(cfg.hooks, {});
  assert.deepEqual(cfg.permissions.allow, ["read", "grep", "glob", `Exec(git diff --no-ext-diff --no-textconv ${base} ${head} --)`]);
  assert.deepEqual(cfg.permissions.deny, ["edit", "mcp__*"]);
  assert.equal(Object.values(cfg.read_config_from).every((v) => v === false), true);
  assert.doesNotThrow(() => reviewConfig(null, base, head));
  assert.doesNotThrow(() => reviewConfig("string", base, head));
  assert.throws(() => reviewConfig({}, base, head, { treeSha: "not-a-sha" }), /--tree must be a 40-character SHA/);
  assert.deepEqual(
    reviewConfig({}, base, head, { working: true }).permissions.allow,
    ["read", "grep", "glob", "Exec(git diff --no-ext-diff --no-textconv HEAD --)"]
  );
});

test("projectConfigs detects .devin and .mcp.json in cwd and parent monorepo directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-devin-proj-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sub = path.join(root, "packages", "sub");
  await mkdir(sub, { recursive: true });
  assert.deepEqual(projectConfigs(sub), []);
  await mkdir(path.join(root, ".devin"), { recursive: true });
  await writeFile(path.join(root, ".devin", "config.local.json"), "{}");
  const found = projectConfigs(sub);
  assert.equal(found.length, 1);
  assert.match(found[0], /\.devin\/config\.local\.json$/);
});

test("runReview writes temporary config, omits --sandbox, and cleans up after exit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-devin-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = path.join(root, "prompt.txt");
  await writeFile(prompt, "review prompt");
  let tempConfigPath = null;
  const spawnFn = (cmd, args) => {
    assert.equal(cmd, "devin");
    assert.equal(args.includes("--sandbox"), false);
    tempConfigPath = args[args.indexOf("--config") + 1];
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(async () => {
      const written = JSON.parse(await readFile(tempConfigPath, "utf8"));
      assert.deepEqual(written.mcpServers, {});
      child.emit("exit", 0, null);
    });
    return child;
  };
  const code = await runReview(["--base", base, "--head", head, "--model", "swe-1.6", "--prompt-file", prompt], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: root },
    spawnFn
  });
  assert.equal(code, 0);
  assert.equal(existsSync(tempConfigPath), false);
});

test("parseArgs validates required flags", () => {
  assert.throws(() => parseArgs(["--base", base]), /missing --head/);
});
