import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { isolatedReviewHome, runWithEmptyUserMcp, userMcpPath } from "../bin/fr-cursor-review.mjs";

const exec = promisify(execFile);

test("Cursor review helper does not write the live user MCP file", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-cursor-review-"));
  const mcp = userMcpPath(home);
  await mkdir(path.dirname(mcp), { recursive: true });
  const original = `${JSON.stringify({ mcpServers: { "agent-fixes": { command: "agent-fixes", args: ["mcp"] } } }, null, 2)}\n`;
  await writeFile(mcp, original, { mode: 0o600 });
  let childHome = null;
  const spawnFn = (_command, _args, options) => {
    childHome = options.env.HOME;
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(async () => {
      assert.notEqual(childHome, home);
      assert.deepEqual(JSON.parse(await readFile(userMcpPath(childHome), "utf8")).mcpServers, {});
      assert.equal(await readFile(mcp, "utf8"), original);
      child.emit("exit", 0, null);
    });
    return child;
  };
  const code = await runWithEmptyUserMcp("cursor-agent", ["--version"], { home, spawnFn });
  assert.equal(code, 0);
  assert.equal(await readFile(mcp, "utf8"), original);
});

test("Cursor review helper writes empty user-level MCP and preserves Keychain paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-cursor-home-"));
  const mcp = userMcpPath(home);
  await mkdir(path.dirname(mcp), { recursive: true });
  await mkdir(path.join(home, "Library", "Keychains"), { recursive: true });
  await writeFile(mcp, `${JSON.stringify({ mcpServers: { keep: { command: "keep" } } })}\n`);
  await writeFile(path.join(home, ".cursor", "cli-config.json"), "{}\n");
  const isolated = isolatedReviewHome(home);
  assert.deepEqual(JSON.parse(await readFile(userMcpPath(isolated), "utf8")).mcpServers, {});
  assert.match(JSON.parse(await readFile(mcp, "utf8")).mcpServers.keep.command, /keep/);
  assert.equal(await readFile(path.join(isolated, ".cursor", "cli-config.json"), "utf8"), "{}\n");
  assert.equal(realpathSync(path.join(isolated, "Library")), realpathSync(path.join(home, "Library")));
  await rm(isolated, { recursive: true, force: true });
});

test("cursor-agent mcp list ignores a poisoned user MCP when launched through the wrapper", async (t) => {
  const agent = process.env.CURSOR_AGENT || path.join(os.homedir(), ".local/bin/cursor-agent");
  try {
    await exec(agent, ["--version"], { timeout: 15000 });
  } catch {
    t.skip("cursor-agent is not installed");
    return;
  }
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-cursor-poison-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "fr-cursor-ws-"));
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await writeFile(userMcpPath(home), `${JSON.stringify({ mcpServers: { "fr-poison-probe": { command: "false", args: ["fr-poison-probe"] } } })}\n`);
  const control = await exec(agent, ["mcp", "list"], { cwd: workspace, env: { ...process.env, HOME: home }, timeout: 45000 });
  assert.match(`${control.stdout}\n${control.stderr}`, /fr-poison-probe/);
  const isolated = isolatedReviewHome(home);
  try {
    const isolatedRun = await exec(agent, ["mcp", "list"], { cwd: workspace, env: { ...process.env, HOME: isolated }, timeout: 45000 });
    assert.doesNotMatch(`${isolatedRun.stdout}\n${isolatedRun.stderr}`, /fr-poison-probe/);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});
