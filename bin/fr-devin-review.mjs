#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/i;
const IMPORTS = ["agents_standard", "cursor", "windsurf", "claude", "copilot", "codex", "kiro", "opencode", "zed", "cloud"];
const KEEP = ["version", "devin", "shell"];

export function userConfigPath(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "devin", "config.json");
}

export function reviewConfig(user, baseSha, headSha, { treeSha = null, working = false } = {}) {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) {
    throw new Error("--base and --head must be 40-character SHAs");
  }
  if (treeSha != null && !SHA.test(treeSha)) {
    throw new Error("--tree must be a 40-character SHA");
  }
  const safeUser = user && typeof user === "object" && !Array.isArray(user) ? user : {};
  const diff = treeSha
    ? `git diff --no-ext-diff --no-textconv ${baseSha} ${treeSha} --`
    : working
      ? "git diff --no-ext-diff --no-textconv HEAD --"
      : `git diff --no-ext-diff --no-textconv ${baseSha} ${headSha} --`;
  return {
    ...Object.fromEntries(KEEP.filter((key) => key in safeUser).map((key) => [key, safeUser[key]])),
    read_config_from: Object.fromEntries(IMPORTS.map((name) => [name, false])),
    mcpServers: {},
    hooks: {},
    permissions: {
      allow: ["read", "grep", "glob", `Exec(${diff})`],
      deny: ["edit", "mcp__*"],
      ask: []
    }
  };
}

const PROJECT_CONFIGS = [".devin/config.json", ".devin/config.local.json", ".devin/mcp.json", ".mcp.json"];

// Stop walking upward at os.homedir() (exclusive) so a user's personal ~/.mcp.json
// is not mistaken for repository-committed project config.
export function projectConfigs(startDir, home = os.homedir()) {
  const found = [];
  const stopAt = home ? path.resolve(home) : null;
  let dir = path.resolve(startDir);
  while (true) {
    if (stopAt && dir === stopAt) break;
    for (const rel of PROJECT_CONFIGS) {
      const candidate = path.join(dir, rel);
      if (existsSync(candidate)) found.push(path.relative(startDir, candidate) || rel);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--working") {
      flags.working = true;
      continue;
    }
    if (!["--base", "--head", "--tree", "--model", "--prompt-file"].includes(name) || argv[index + 1] == null) {
      throw new Error("usage: fr-devin-review --base <sha> --head <sha> [--tree <sha>|--working] --model <model> --prompt-file <file>");
    }
    flags[name.slice(2)] = argv[index + 1];
    index += 1;
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
  if (found.length) {
    throw new Error(`this checkout has project Devin/MCP config (${found.join(", ")}), which can widen a reviewer's permissions; review it with another launcher`);
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "fr-devin-review-"));
  const config = path.join(directory, "config.json");
  const cfg = reviewConfig(readUserConfig(userConfigPath(env)), flags.base, flags.head, {
    treeSha: flags.tree || null,
    working: Boolean(flags.working)
  });
  writeFileSync(config, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runReview(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`fr-devin-review: ${error.message}`);
    process.exitCode = 1;
  });
}
