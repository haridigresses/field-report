import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedCursorConfig, runWithEmptyUserMcp, userMcpPath } from "../bin/fr-cursor-review.mjs";

test("Cursor review helper does not write the live user MCP file", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-cursor-review-"));
  const mcp = path.join(home, ".cursor", "mcp.json");
  await mkdir(path.dirname(mcp), { recursive: true });
  const original = `${JSON.stringify({ mcpServers: { "agent-fixes": { command: "agent-fixes", args: ["mcp"] } } }, null, 2)}\n`;
  await writeFile(mcp, original, { mode: 0o600 });
  let childHome = null;
  let childConfig = null;
  const spawnFn = (_command, _args, options) => {
    childHome = options.env.HOME;
    childConfig = options.env.CURSOR_CONFIG_DIR;
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(async () => {
      assert.equal(childHome, home);
      assert.notEqual(childConfig, path.join(home, ".cursor"));
      assert.deepEqual(JSON.parse(await readFile(userMcpPath(childConfig), "utf8")).mcpServers, {});
      assert.equal(await readFile(mcp, "utf8"), original);
      child.emit("exit", 0, null);
    });
    return child;
  };
  const code = await runWithEmptyUserMcp("cursor-agent", ["--version"], { home, spawnFn });
  assert.equal(code, 0);
  assert.equal(await readFile(mcp, "utf8"), original);
});

test("Cursor review helper writes an isolated empty MCP config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-cursor-home-"));
  const mcp = path.join(home, ".cursor", "mcp.json");
  await mkdir(path.dirname(mcp), { recursive: true });
  await writeFile(mcp, `${JSON.stringify({ mcpServers: { keep: { command: "keep" } } })}\n`);
  const isolated = isolatedCursorConfig();
  assert.deepEqual(JSON.parse(await readFile(userMcpPath(isolated), "utf8")).mcpServers, {});
  assert.match(JSON.parse(await readFile(mcp, "utf8")).mcpServers.keep.command, /keep/);
  await rm(isolated, { recursive: true, force: true });
});
