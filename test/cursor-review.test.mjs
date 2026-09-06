import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
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

test("Cursor review helper writes empty user-level MCP and does not replace the live file", async () => {
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

test("isolated Cursor home preserves only the macOS login keychain and cleanup preserves its target", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-cursor-library-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const keychains = path.join(home, "Library", "Keychains");
  await mkdir(keychains, { recursive: true });
  await mkdir(path.join(home, "Library", "Application Support"));
  const login = path.join(keychains, "login.keychain-db");
  await writeFile(login, "fake login keychain");
  await writeFile(path.join(keychains, "other.keychain-db"), "unrelated");
  const isolated = isolatedCursorHome(home, "darwin");
  t.after(() => rm(isolated, { recursive: true, force: true }));
  assert.equal(await readlink(path.join(isolated, "Library", "Keychains", "login.keychain-db")), login);
  assert.equal(existsSync(path.join(isolated, "Library", "Application Support")), false);
  assert.equal(existsSync(path.join(isolated, "Library", "Keychains", "other.keychain-db")), false);
  assert.deepEqual(JSON.parse(await readFile(userMcpPath(isolated), "utf8")), { mcpServers: {} });
  await rm(isolated, { recursive: true, force: true });
  assert.equal(await readFile(login, "utf8"), "fake login keychain");
});

test("isolated Cursor home tolerates a missing keychain and leaves non-macOS homes alone", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-cursor-no-keychain-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const platform of ["darwin", "linux"]) {
    const isolated = isolatedCursorHome(home, platform);
    t.after(() => rm(isolated, { recursive: true, force: true }));
    assert.equal(existsSync(path.join(isolated, "Library")), false);
  }
  await mkdir(path.join(home, "Library", "Keychains"), { recursive: true });
  await writeFile(path.join(home, "Library", "Keychains", "login.keychain-db"), "fake");
  const isolated = isolatedCursorHome(home, "linux");
  t.after(() => rm(isolated, { recursive: true, force: true }));
  assert.equal(existsSync(path.join(isolated, "Library")), false);
});
