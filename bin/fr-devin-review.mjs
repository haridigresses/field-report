#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Launch devin with a review-only config: the user's account kept, every
// import from other tools' configs and every MCP server removed, reads allowed,
// and the one review diff the only command allowed.
// Headless runs reject anything else. Do not add --sandbox: Devin auto-approves
// sandboxed commands, which would let a reviewer run commands outside the rule.

const SHA = /^[0-9a-f]{40}$/i;
const IMPORTS = ["agents_standard", "cursor", "windsurf", "claude", "copilot", "codex", "kiro", "opencode", "zed", "cloud"];

export function userConfigPath(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "devin", "config.json");
}

// Only these user keys carry over: the account, and shell setup (without it
// Devin reruns first-time setup). Every other setting (sandbox, permission
// mode, plugins, anything a later Devin adds) stays at Devin's default.
const KEEP = ["version", "devin", "shell"];

export function reviewConfig(user, baseSha, headSha) {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error("--base and --head must be 40-character SHAs");
  return {
    ...Object.fromEntries(KEEP.filter((key) => key in user).map((key) => [key, user[key]])),
    read_config_from: Object.fromEntries(IMPORTS.map((name) => [name, false])),
    mcpServers: {},
    hooks: {},
    permissions: {
      allow: ["read", "grep", "glob", `Exec(git diff --no-ext-diff --no-textconv ${baseSha} ${headSha} --)`],
      deny: ["edit", "mcp__*"],
      ask: []
    }
  };
}

// Devin merges a checkout's project config over --config, so a reviewed branch
// could allow itself more commands. Refuse to review such a checkout.
const PROJECT_CONFIGS = [".devin/config.json", ".devin/config.local.json"];

export function projectConfigs(repo) {
  return PROJECT_CONFIGS.filter((file) => existsSync(path.join(repo, file)));
}

export function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!["--base", "--head", "--model", "--prompt-file"].includes(name) || argv[index + 1] == null) throw new Error("usage: fr-devin-review --base <sha> --head <sha> --model <model> --prompt-file <file>");
    flags[name.slice(2)] = argv[index + 1];
  }
  for (const name of ["base", "head", "model", "prompt-file"]) if (!flags[name]) throw new Error(`missing --${name}`);
  return flags;
}

function readUserConfig(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw new Error(`cannot read ${file}: ${error.message}`); }
}

export async function runReview(argv, { env = process.env, spawnFn = spawn, cwd = process.cwd() } = {}) {
  const flags = parseArgs(argv);
  const found = projectConfigs(cwd);
  if (found.length) throw new Error(`this checkout has Devin project config (${found.join(", ")}), which can widen a reviewer's permissions; review it with another launcher`);
  const directory = mkdtempSync(path.join(os.tmpdir(), "fr-devin-review-"));
  const config = path.join(directory, "config.json");
  writeFileSync(config, `${JSON.stringify(reviewConfig(readUserConfig(userConfigPath(env)), flags.base, flags.head), null, 2)}\n`, { mode: 0o600 });
  const args = ["--config", config, "--permission-mode", "auto", "--respect-workspace-trust", "false", "--model", flags.model, "--prompt-file", flags["prompt-file"], "-p"];
  const cleanup = () => { try { rmSync(directory, { recursive: true, force: true }); } catch {} };
  return new Promise((resolve, reject) => {
    const child = spawnFn("devin", args, { stdio: "inherit", env });
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
  runReview(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`fr-devin-review: ${error.message}`);
    process.exitCode = 1;
  });
}
