import { execFile } from "node:child_process";
import { access, constants, readdir, readFile, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRealGh } from "../bin/fr-gh.mjs";
import { hasInstalledHostHooks } from "./host-hooks.mjs";
import { hookState } from "./hooks.mjs";
import { REMOVED_SKILL_NAMES, skillHostDirs, SKILL_NAMES } from "./install.mjs";
import { normalizeId, REVIEW_ROLES } from "./seats.mjs";

export const BINARIES = { codex: "codex", claude: "claude", cursor: "cursor-agent", agy: "agy", devin: "devin" };
const WRAPPERS = { cursor: "fr-cursor-review", devin: "fr-devin-review" };

export function defaultProbe() {
  return {
    run: (command, args, options = {}) => new Promise((resolve) => {
      execFile(command, args, { timeout: 30_000, ...options }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") }));
    }),
    exists: async (file) => { try { await access(file); return true; } catch { return false; } },
    readlink: async (file) => { try { return await readlink(file); } catch { return null; } },
    read: async (file) => { try { return await readFile(file, "utf8"); } catch { return null; } },
    executable: async (file) => { try { await access(file, constants.X_OK); return true; } catch { return false; } },
    list: async (dir) => { try { return await readdir(dir); } catch { return null; } }
  };
}

export function cursorModelIds(text) {
  return new Set(String(text).split("\n").map((line) => line.split(" - ")[0].trim()).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)));
}

export function agyModelIds(text) {
  return new Set(String(text).split("\n").filter((line) => line.includes("\t")).map((line) => line.split("\t")[0].trim()).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)));
}

export function devinModelIds(text) {
  let families;
  try { families = JSON.parse(text).families; } catch { return new Set(); }
  if (!Array.isArray(families)) return new Set();
  const names = families.flatMap((family) => [family?.slug, ...(Array.isArray(family?.aliases) ? family.aliases : []), ...(Array.isArray(family?.variants) ? family.variants.map((variant) => variant?.model_uid) : [])]);
  return new Set(names.filter((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)));
}

export const MODEL_LISTS = {
  cursor: { args: ["--list-models"], parse: cursorModelIds },
  agy: { args: ["models"], parse: agyModelIds, bareIds: true },
  devin: { args: ["models", "list", "--format", "json"], parse: devinModelIds }
};

export function listedModel(launch, ids, cliModel) {
  return ids.has(cliModel) || Boolean(MODEL_LISTS[launch]?.bareIds && [...ids].some((id) => normalizeId(id) === cliModel));
}

export async function doctor({ runtimeRoot, stateRoot, home = os.homedir(), env = process.env, nodeVersion = process.versions.node, loadConfig, projects = null, probe = defaultProbe() }) {
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail });

  const major = Number(String(nodeVersion).split(".")[0]);
  if (major >= 20) add("ok", "node", `v${nodeVersion}`);
  else add("fail", "node", `v${nodeVersion}; Field Report needs Node 20 or newer`);

  const git = await probe.run("git", ["--version"]);
  if (git.code === 0) add("ok", "git", git.stdout.trim());
  else add("fail", "git", "git is not on PATH");

  const binDir = path.join(home, ".local", "bin");
  if (await probe.executable(path.join(binDir, "fr"))) add("ok", "fr launcher", path.join(binDir, "fr"));
  else add("fail", "fr launcher", `missing or non-executable ${path.join(binDir, "fr")}; run node scripts/install.mjs`);

  const ghShim = path.join(binDir, "gh");
  if (await probe.executable(ghShim)) add("ok", "gh gate wrapper", ghShim);
  else add("fail", "gh gate wrapper", `missing or non-executable ${ghShim}; run node scripts/install.mjs`);

  const pathDirs = String(env.PATH || "").split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry));
  const binIdx = pathDirs.indexOf(path.resolve(binDir));
  if (binIdx < 0) {
    add("warn", "PATH", `${binDir} is not on PATH; add it ahead of system bin dirs so 'fr' and the 'gh' PR gate run automatically`);
  } else {
    const realGh = findRealGh({ envPath: env.PATH, selfPath: ghShim });
    const realDirIdx = realGh ? pathDirs.indexOf(path.resolve(path.dirname(realGh))) : -1;
    if (realDirIdx >= 0 && realDirIdx < binIdx) {
      add("warn", "PATH precedence", `${path.dirname(realGh)} precedes ${binDir} on PATH, shadowing the 'gh' PR gate wrapper; move ${binDir} first`);
    } else {
      add("ok", "PATH", `${binDir} is on PATH${realGh ? ` ahead of ${realGh}` : ""}`);
    }
  }

  for (const host of skillHostDirs(home)) {
    const missing = [];
    const elsewhere = [];
    const stale = [];
    for (const name of SKILL_NAMES) {
      const target = await probe.readlink(path.join(host, name));
      if (!target) missing.push(name);
      else if (path.resolve(host, target) !== path.join(runtimeRoot, "skills", name)) elsewhere.push(`${name} -> ${target}`);
    }
    for (const removed of REMOVED_SKILL_NAMES) {
      if (await probe.readlink(path.join(host, removed))) stale.push(removed);
    }
    if (missing.length) add("fail", `skills ${host}`, `missing ${missing.join(", ")}; run node scripts/install.mjs`);
    else if (stale.length) add("warn", `skills ${host}`, `legacy skill link(s) still present (${stale.join(", ")}); run node scripts/install.mjs`);
    else if (elsewhere.length) add("warn", `skills ${host}`, `linked to another checkout: ${elsewhere.join("; ")}`);
    else add("ok", `skills ${host}`, "linked to this checkout");
  }

  const claudeSettings = await probe.read(path.join(home, ".claude", "settings.json"));
  if (hasInstalledHostHooks(claudeSettings, "claude")) add("ok", "claude hooks", "SessionStart, UserPromptSubmit, and PreToolUse installed");
  else add("warn", "claude hooks", `Field Report hooks missing in ${path.join(home, ".claude", "settings.json")}; run fr init or node scripts/install.mjs`);

  const cursorHooks = await probe.read(path.join(home, ".cursor", "hooks.json"));
  if (hasInstalledHostHooks(cursorHooks, "cursor")) add("ok", "cursor hooks", "beforeSubmitPrompt, beforeShellExecution, and beforeMCPExecution installed");
  else add("warn", "cursor hooks", `Field Report hooks missing in ${path.join(home, ".cursor", "hooks.json")}; run fr init or node scripts/install.mjs`);

  const initialized = await probe.exists(path.join(stateRoot, "config.json"));
  if (initialized) add("ok", "state", stateRoot);
  else add("fail", "state", `${stateRoot} is not initialized; run fr init`);

  if (projects == null) {
    projects = [];
    for (const file of initialized ? ((await probe.list(path.join(stateRoot, "projects"))) || []).filter((name) => name.endsWith(".json")).sort() : []) {
      try {
        const project = JSON.parse(await probe.read(path.join(stateRoot, "projects", file)));
        if (!project?.id || !project?.repoPath) throw new Error("missing id or repoPath");
        projects.push(project);
      } catch (error) { add("fail", `project file ${file}`, `unreadable: ${error.message}`); }
    }
  }

  let config = null;
  try { config = loadConfig(); add("ok", "seat config", "parsed"); }
  catch (error) { add("fail", "seat config", error.message); }

  if (config) {
    const models = [];
    for (const role of REVIEW_ROLES) config.seats[role].models.forEach((model, index) => models.push({ ...model, role, isDefault: index === 0 }));
    const cliLaunches = [...new Set(models.map((model) => model.launch).filter((launch) => launch !== "native"))];
    const available = { native: true };
    for (const launch of cliLaunches) {
      const binary = BINARIES[launch];
      const result = await probe.run(binary, ["--version"]);
      available[launch] = result.code === 0;
      const needed = models.some((model) => model.launch === launch && model.isDefault);
      if (available[launch]) add("ok", `${binary} CLI`, result.stdout.trim().split("\n")[0] || "found");
      else add(needed ? "fail" : "warn", `${binary} CLI`, `not found or not runnable; needed for ${models.filter((model) => model.launch === launch).map((model) => `${model.role}: ${model.id}`).join(", ")}`);
    }
    for (const launch of Object.keys(WRAPPERS).filter((item) => cliLaunches.includes(item))) {
      const wrapper = path.join(binDir, WRAPPERS[launch]);
      if (await probe.executable(wrapper)) add("ok", WRAPPERS[launch], wrapper);
      else add("fail", WRAPPERS[launch], `missing or non-executable ${wrapper}; run node scripts/install.mjs`);
    }
    if (cliLaunches.length) {
      if ((await probe.run("zsh", ["--version"])).code === 0) add("ok", "zsh", `found (${cliLaunches.join(", ")} launches use zsh -ic)`);
      else add("fail", "zsh", `not found; ${cliLaunches.join(", ")} launch commands run through zsh -ic`);
    }
    const listed = {};
    for (const launch of Object.keys(MODEL_LISTS).filter((item) => available[item])) {
      const { args, parse } = MODEL_LISTS[launch];
      const list = await probe.run(BINARIES[launch], args);
      listed[launch] = list.code === 0 ? parse(list.stdout) : null;
      if (!listed[launch]) add("warn", `${launch} models`, `${BINARIES[launch]} ${args.join(" ")} failed; sign in to ${BINARIES[launch]}`);
    }
    for (const model of models) {
      const label = `${model.role} ${model.isDefault ? "default" : "fallback"} ${model.id}`;
      if (model.launch === "native") {
        add("ok", label, "uses isolated host native subagent (--brief / --record)");
        continue;
      }
      if (!available[model.launch]) continue;
      if (MODEL_LISTS[model.launch]) {
        const ids = listed[model.launch];
        if (!ids) continue;
        const command = `${BINARIES[model.launch]} ${MODEL_LISTS[model.launch].args.join(" ")}`;
        if (listedModel(model.launch, ids, model.cliModel)) add("ok", label, `${model.launch} model ${model.cliModel} is available`);
        else add(model.isDefault ? "fail" : "warn", label, `${model.launch} model ${model.cliModel} is not in ${command}; edit the config to a model you have`);
      } else {
        add("ok", label, `${BINARIES[model.launch]} found; ${model.launch} cannot list models, so availability is checked at first launch`);
      }
    }
  }

  const realGh = findRealGh({ envPath: env.PATH, selfPath: ghShim }) || "gh";
  const gh = await probe.run(realGh, ["auth", "status"]);
  if (gh.code === 0) add("ok", "gh", `signed in (${realGh})`);
  else add("warn", "gh", gh.code === "ENOENT" ? "gh is not installed; PR creation and fr gate bots need it" : "gh is not signed in; run gh auth login");

  const seenCommonDirs = new Map();
  for (const project of projects) {
    const label = `project ${project.id}`;
    if (!(await probe.exists(project.repoPath))) {
      add("warn", label, `repo path ${project.repoPath} does not exist; remove with 'fr project remove ${project.id}' or update with 'fr project update ${project.id} --repo <path>'`);
      continue;
    }
    const commonRes = await probe.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: project.repoPath });
    if (commonRes.code !== 0) {
      add("warn", label, `${project.repoPath} is not a git repository`);
      continue;
    }
    const commonDir = commonRes.stdout.trim();
    if (seenCommonDirs.has(commonDir)) {
      add("warn", label, `shares repository with project '${seenCommonDirs.get(commonDir)}'; remove the duplicate with 'fr project remove ${project.id}'`);
      continue;
    }
    seenCommonDirs.set(commonDir, project.id);

    const hookRes = await probe.run("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: project.repoPath });
    const hook = hookRes.code === 0 ? hookRes.stdout.trim() : null;
    const state = hook ? hookState(await probe.read(hook)) : "absent";
    if (state === "legacy-managed") add("warn", label, `legacy Field Report pre-commit hook at ${hook}; run 'fr init' to remove it`);
    else if (state === "legacy-manual") add("warn", label, `${hook} still invokes 'fr gate checkout|commit'; remove that line from your hook manager`);
    else add("ok", label, `enabled (${project.repoPath})`);
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
