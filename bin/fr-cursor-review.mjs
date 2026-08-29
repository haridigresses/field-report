#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// cursor-agent loads user MCP from $HOME/.cursor/mcp.json and ignores CURSOR_CONFIG_DIR.
// Keep Keychain login by pointing HOME at a temp tree that symlinks ~/Library and
// Cursor auth files, with an empty user mcp.json. Repository-scoped MCP is unchanged.

const EMPTY = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
const AUTH_FILES = ["cli-config.json", "agent-cli-state.json"];

export function userMcpPath(home = os.homedir()) {
  return path.join(home, ".cursor", "mcp.json");
}

export function isolatedReviewHome(realHome = os.homedir()) {
  const home = mkdtempSync(path.join(os.tmpdir(), "fr-cursor-review-"));
  const cursor = path.join(home, ".cursor");
  mkdirSync(cursor, { recursive: true });
  writeFileSync(path.join(cursor, "mcp.json"), EMPTY, { mode: 0o600 });
  for (const name of AUTH_FILES) {
    const source = path.join(realHome, ".cursor", name);
    if (existsSync(source)) symlinkSync(source, path.join(cursor, name));
  }
  const library = path.join(realHome, "Library");
  if (existsSync(library)) symlinkSync(library, path.join(home, "Library"));
  return home;
}

export async function runWithEmptyUserMcp(command, args, { home = os.homedir(), env = process.env, spawnFn = spawn } = {}) {
  const isolated = isolatedReviewHome(home);
  const childEnv = { ...env, HOME: isolated };
  const cleanup = () => { try { rmSync(isolated, { recursive: true, force: true }); } catch {} };
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: "inherit", env: childEnv });
    const onSigint = () => { try { child.kill("SIGINT"); } catch {} };
    const onSigterm = () => { try { child.kill("SIGTERM"); } catch {} };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const finish = (next) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      cleanup();
      next();
    };
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => finish(() => resolve(signal ? 1 : code ?? 1)));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWithEmptyUserMcp("cursor-agent", process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`fr-cursor-review: ${error.message}`);
    process.exitCode = 1;
  });
}
