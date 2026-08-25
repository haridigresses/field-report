import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedCursorHome, runWithEmptyUserMcp, userMcpPath } from "../bin/fr-cursor-review.mjs";

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
      assert.deepEqual(JSON.parse(await readFile(path.join(childHome, ".cursor", "mcp.json"), "utf8")).mcpServers, {});
      assert.equal(await readFile(mcp, "utf8"), original);
      child.emit("exit", 0, null);
    });
    return child;
  };
  const code = await runWithEmptyUserMcp("cursor-agent", ["--version"], { home, spawnFn });
  assert.equal(code, 0);
  assert.equal(await readFile(mcp, "utf8"), original);
});

test("isolated Cursor home is empty MCP and does not replace the live file", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-cursor-home-"));
  const mcp = userMcpPath(home);
  await mkdir(path.dirname(mcp), { recursive: true });
  await writeFile(mcp, `${JSON.stringify({ mcpServers: { keep: { command: "keep" } } })}\n`);
  const isolated = isolatedCursorHome(home);
  assert.notEqual(isolated, home);
  assert.deepEqual(JSON.parse(await readFile(path.join(isolated, ".cursor", "mcp.json"), "utf8")).mcpServers, {});
  assert.match(JSON.parse(await readFile(mcp, "utf8")).mcpServers.keep.command, /keep/);
  await rm(isolated, { recursive: true, force: true });
});
