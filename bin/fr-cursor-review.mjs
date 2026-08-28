#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Preserve HOME so cursor-agent can use the caller's Keychain-backed login.
// Point only CURSOR_CONFIG_DIR at a temp directory with an empty mcp.json.
// This removes ambient user MCP servers without hiding repository-scoped MCP.

const EMPTY = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
export function userMcpPath(configDir = path.join(os.homedir(), ".cursor")) {
  return path.join(configDir, "mcp.json");
}

export function isolatedCursorConfig() {
  const config = mkdtempSync(path.join(os.tmpdir(), "fr-cursor-review-"));
  mkdirSync(config, { recursive: true });
  writeFileSync(userMcpPath(config), EMPTY, { mode: 0o600 });
  return config;
}

export async function runWithEmptyUserMcp(command, args, { home = os.homedir(), env = process.env, spawnFn = spawn } = {}) {
  const isolated = isolatedCursorConfig();
  const childEnv = { ...env, HOME: home, CURSOR_CONFIG_DIR: isolated };
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
