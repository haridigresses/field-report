#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkBranchOpenGate, classifyGhArgs } from "../src/host-hooks.mjs";
import { createStore } from "../src/store.mjs";

// ~/.local/bin/gh wrapper: passes every command straight to the real gh binary
// EXCEPT non-draft 'gh pr create' and 'gh pr ready' in Field Report-enabled
// repositories when MRR is not READY. Evaluates process.cwd() (the actual
// folder where gh runs) against the canonical user state root — no environment
// variable can redirect the production shim to an empty state folder.

const SYSTEM_HOME = (() => {
  try { return os.userInfo().homedir; } catch { return os.homedir(); }
})();
const SYSTEM_FALLBACK_GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

export function findRealGh({ envPath = process.env.PATH || "", selfPath = process.argv[1], home = SYSTEM_HOME, includeSystemFallbacks = true } = {}) {
  let selfReal = null;
  try { selfReal = realpathSync(selfPath); } catch { selfReal = path.resolve(selfPath || ""); }
  const backupDirs = [
    selfPath ? path.dirname(path.resolve(selfPath)) : null,
    home ? path.join(home, ".local", "bin") : null
  ].filter(Boolean);
  const candidates = [
    ...backupDirs.map((dir) => path.join(dir, "gh.real")),
    ...String(envPath).split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "gh")),
    ...(includeSystemFallbacks ? SYSTEM_FALLBACK_GH : [])
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (resolved === selfReal || path.resolve(candidate) === path.resolve(selfPath || "")) continue;
      if (resolved.endsWith("fr-gh.mjs") || (resolved.endsWith("/.local/bin/gh") && !candidate.endsWith("gh.real"))) continue;
      return candidate;
    } catch {}
  }
  return null;
}

function execRealGh(realGh, args, { env = process.env, cwd = process.cwd(), spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(realGh, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
}

export function canonicalStateRoot({ homeDir = SYSTEM_HOME } = {}) {
  return path.join(homeDir, ".local", "state", "field-report");
}

export async function runGhWrapper(argv, {
  env = process.env,
  cwd = process.cwd(),
  selfPath = process.argv[1],
  store = null,
  homeDir = SYSTEM_HOME,
  spawnFn = spawn,
  stderr = process.stderr
} = {}) {
  const activeStore = store || createStore(canonicalStateRoot({ homeDir }));
  const realGh = env.FIELD_REPORT_REAL_GH || findRealGh({ envPath: env.PATH, selfPath, home: homeDir });
  if (!realGh) {
    stderr.write("fr-gh: real 'gh' binary not found on PATH (install GitHub CLI)\n");
    return 127;
  }

  const classified = classifyGhArgs(argv);
  if (classified.action === "allow") {
    return execRealGh(realGh, classified.cleanedArgs, { env, cwd, spawnFn });
  }

  const check = await checkBranchOpenGate({
    store: activeStore,
    cwd,
    explicitRepo: classified.explicitRepo,
    explicitBranch: classified.explicitHead,
    selector: classified.selector,
    ghBin: realGh
  });
  if (!check.managed || check.ready) {
    return execRealGh(realGh, classified.cleanedArgs, { env, cwd, spawnFn });
  }

  if (classified.action === "draft-pr") {
    stderr.write(`[Field Report] Note: opening Draft PR on ${check.project.id}${check.branch ? `/${check.branch}` : ""} before MRR is READY (${check.reasons.join("; ")}). Tell the user explicitly that MRR has not been run yet.\n`);
    return execRealGh(realGh, classified.cleanedArgs, { env, cwd, spawnFn });
  }

  stderr.write(`Field Report BLOCKED '${classified.action === "ready-pr" ? "gh pr ready" : "gh pr create"}' on ${check.project.id}${check.branch ? `/${check.branch}` : ""}:\n- ${check.reasons.join("\n- ")}\nRun 'fr mrr' on this branch until READY before opening or readying a PR.\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGhWrapper(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`fr-gh: ${error.message}\n`);
    process.exitCode = 1;
  });
}
