import { execFile } from "node:child_process";
import { access, readFile, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skillHostDirs, SKILL_NAMES } from "./install.mjs";
import { marker } from "./hooks.mjs";
import { REVIEW_ROLES } from "./seats.mjs";

// fr doctor checks that this machine can run the loop: launchers, skills,
// state, the seat config, the CLIs each configured model needs, gh, and each
// project's hook. It only reads; it never installs or edits anything.

const BINARIES = { codex: "codex", claude: "claude", cursor: "cursor-agent" };

export function defaultProbe() {
  return {
    run: (command, args, options = {}) => new Promise((resolve) => {
      execFile(command, args, { timeout: 30_000, ...options }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") }));
    }),
    exists: async (file) => { try { await access(file); return true; } catch { return false; } },
    readlink: async (file) => { try { return await readlink(file); } catch { return null; } },
    read: async (file) => { try { return await readFile(file, "utf8"); } catch { return null; } }
  };
}

// Cursor prints "id - Display Name" lines.
export function cursorModelIds(text) {
  return new Set(String(text).split("\n").map((line) => line.split(" - ")[0].trim()).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)));
}

export async function doctor({ runtimeRoot, stateRoot, home = os.homedir(), env = process.env, nodeVersion = process.versions.node, loadConfig, projects = [], probe = defaultProbe() }) {
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail });

  const major = Number(String(nodeVersion).split(".")[0]);
  if (major >= 20) add("ok", "node", `v${nodeVersion}`); else add("fail", "node", `v${nodeVersion}; Field Report needs Node 20 or newer`);

  const git = await probe.run("git", ["--version"]);
  if (git.code === 0) add("ok", "git", git.stdout.trim()); else add("fail", "git", "git is not on PATH");

  const binDir = path.join(home, ".local", "bin");
  if (await probe.exists(path.join(binDir, "fr"))) add("ok", "fr launcher", path.join(binDir, "fr"));
  else add("fail", "fr launcher", `missing ${path.join(binDir, "fr")}; run node scripts/install.mjs from the Field Report checkout`);
  const onPath = String(env.PATH || "").split(path.delimiter).map((entry) => path.resolve(entry)).includes(path.resolve(binDir));
  if (onPath) add("ok", "PATH", `${binDir} is on PATH`); else add("warn", "PATH", `${binDir} is not on PATH; add it so agents can run fr`);

  for (const host of skillHostDirs(home)) {
    const missing = [];
    const elsewhere = [];
    for (const name of SKILL_NAMES) {
      const target = await probe.readlink(path.join(host, name));
      if (!target) missing.push(name);
      else if (path.resolve(host, target) !== path.join(runtimeRoot, "skills", name)) elsewhere.push(`${name} -> ${target}`);
    }
    if (missing.length) add("fail", `skills ${host}`, `missing ${missing.join(", ")}; run node scripts/install.mjs`);
    else if (elsewhere.length) add("warn", `skills ${host}`, `linked to another checkout: ${elsewhere.join("; ")}`);
    else add("ok", `skills ${host}`, "linked to this checkout");
  }

  if (await probe.exists(path.join(stateRoot, "config.json"))) add("ok", "state", stateRoot);
  else add("fail", "state", `${stateRoot} is not initialized; run fr init`);

  let config = null;
  try { config = loadConfig(); add("ok", "seat config", "parsed"); }
  catch (error) { add("fail", "seat config", error.message); }

  if (config) {
    // A seat's default model must work; later models are fallbacks.
    const models = [];
    for (const role of REVIEW_ROLES) config.seats[role].models.forEach((model, index) => models.push({ ...model, role, isDefault: index === 0 }));
    const launches = [...new Set(models.map((model) => model.launch))];
    const available = {};
    for (const launch of launches) {
      const binary = BINARIES[launch];
      const result = await probe.run(binary, ["--version"]);
      available[launch] = result.code === 0;
      const needed = models.some((model) => model.launch === launch && model.isDefault);
      if (available[launch]) add("ok", `${binary} CLI`, result.stdout.trim().split("\n")[0] || "found");
      else add(needed ? "fail" : "warn", `${binary} CLI`, `not found or not runnable; needed for ${models.filter((model) => model.launch === launch).map((model) => `${model.role}: ${model.id}`).join(", ")}`);
    }
    let cursorIds = null;
    if (available.cursor) {
      const list = await probe.run(BINARIES.cursor, ["--list-models"]);
      cursorIds = list.code === 0 ? cursorModelIds(list.stdout) : null;
      if (!cursorIds) add("warn", "cursor models", "cursor-agent --list-models failed; sign in with cursor-agent login");
    }
    for (const model of models) {
      const label = `${model.role} ${model.isDefault ? "default" : "fallback"} ${model.id}`;
      if (!available[model.launch]) continue;
      if (model.launch === "cursor") {
        if (!cursorIds) continue;
        if (cursorIds.has(model.cliModel)) add("ok", label, `cursor model ${model.cliModel} is available`);
        else add(model.isDefault ? "fail" : "warn", label, `cursor model ${model.cliModel} is not in cursor-agent --list-models; edit the config to a model you have`);
      } else {
        add("ok", label, `${BINARIES[model.launch]} found; ${model.launch} cannot list models, so availability is checked at first launch`);
      }
    }
  }

  const gh = await probe.run("gh", ["auth", "status"]);
  if (gh.code === 0) add("ok", "gh", "signed in");
  else add("warn", "gh", gh.code === "ENOENT" ? "gh is not installed; fr gate bots needs it" : "gh is not signed in; run gh auth login (fr gate bots needs it)");

  for (const project of projects) {
    const label = `project ${project.id}`;
    if (!(await probe.exists(project.repoPath))) { add("fail", label, `repo path ${project.repoPath} does not exist; fix it with fr project update ${project.id} --repo <path>`); continue; }
    const hookResult = await probe.run("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: project.repoPath });
    if (hookResult.code !== 0) { add("fail", label, `${project.repoPath} is not a git repository`); continue; }
    const hook = hookResult.stdout.trim();
    const hooksPath = (await probe.run("git", ["config", "--get", "core.hooksPath"], { cwd: project.repoPath })).stdout.trim();
    const tracked = (await probe.run("git", ["ls-files", "--error-unmatch", "--", hook], { cwd: project.repoPath })).code === 0;
    const text = (await probe.read(hook)) || "";
    // A hook manager's file counts once it runs the gate, with or without our marker.
    const installed = text.includes(marker) || /\bfr\b.*\bgate checkout\b/.test(text);
    if (installed) add("ok", label, `checkout gate runs from ${hook}`);
    else if (tracked) add("warn", label, `pre-commit hook ${hook} is a tracked file (core.hooksPath=${hooksPath}); fr hook install would overwrite it. Add \`fr gate checkout\` to that hook manager instead`);
    else if (hooksPath) add("warn", label, `core.hooksPath=${hooksPath} (a hook manager such as husky or lefthook); it may regenerate ${hook}. Prefer adding \`fr gate checkout\` to that manager over fr hook install`);
    else add("warn", label, `checkout hook not installed; run fr hook install ${project.id}`);
  }

  return results;
}

export function formatDoctor(results) {
  const tag = { ok: "ok  ", warn: "WARN", fail: "FAIL" };
  const lines = results.map((item) => `${tag[item.level]} ${item.label}: ${item.detail}`);
  const fails = results.filter((item) => item.level === "fail").length;
  const warns = results.filter((item) => item.level === "warn").length;
  lines.push(fails ? `${fails} problem(s) to fix, ${warns} warning(s).` : `Ready${warns ? ` with ${warns} warning(s)` : ""}.`);
  return lines.join("\n");
}
