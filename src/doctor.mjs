import { execFile } from "node:child_process";
import { access, constants, readdir, readFile, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skillHostDirs, SKILL_NAMES } from "./install.mjs";
import { hookManagerPath, hookState } from "./hooks.mjs";
import { normalizeId, REVIEW_ROLES } from "./seats.mjs";

// fr doctor checks that this machine can run the loop: launchers, skills,
// state, the seat config, the CLIs each configured model needs, gh, and each
// project's hook. It only reads; it never installs or edits anything.

export const BINARIES = { codex: "codex", claude: "claude", cursor: "cursor-agent", agy: "agy", devin: "devin" };
// Launchers whose review runs through an installed fr-* wrapper.
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

// Cursor prints "id - Display Name" lines.
export function cursorModelIds(text) {
  return new Set(String(text).split("\n").map((line) => line.split(" - ")[0].trim()).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)));
}

// agy models prints "id<TAB>Display Name" lines.
export function agyModelIds(text) {
  return new Set(String(text).split("\n").filter((line) => line.includes("\t")).map((line) => line.split("\t")[0].trim()).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)));
}

// devin models list --format json: families, each with a slug, aliases, and
// variants. Any of those names works as --model.
export function devinModelIds(text) {
  let families;
  try { families = JSON.parse(text).families; } catch { return new Set(); }
  if (!Array.isArray(families)) return new Set();
  const names = families.flatMap((family) => [family?.slug, ...(Array.isArray(family?.aliases) ? family.aliases : []), ...(Array.isArray(family?.variants) ? family.variants.map((variant) => variant?.model_uid) : [])]);
  return new Set(names.filter((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)));
}

// Launchers that can list the account's models. agy also takes a bare model
// name and picks its default effort.
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

  const initialized = await probe.exists(path.join(stateRoot, "config.json"));
  if (initialized) add("ok", "state", stateRoot);
  else add("fail", "state", `${stateRoot} is not initialized; run fr init`);
  // Read project files directly: the store would initialize missing folders.
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
    for (const launch of launches.filter((launch) => WRAPPERS[launch])) {
      const wrapper = path.join(binDir, WRAPPERS[launch]);
      if (await probe.exists(wrapper)) add("ok", WRAPPERS[launch], wrapper);
      else add("fail", WRAPPERS[launch], `missing ${wrapper}; ${launch} seats launch through it. Run node scripts/install.mjs`);
    }
    // Every launch command except Cursor's runs through zsh -ic.
    const shellLaunches = launches.filter((launch) => launch !== "cursor");
    if (shellLaunches.length) {
      if ((await probe.run("zsh", ["--version"])).code === 0) add("ok", "zsh", `found (${shellLaunches.join(", ")} launches use zsh -ic)`);
      else add("fail", "zsh", `not found; ${shellLaunches.join(", ")} launch commands run through zsh -ic`);
    }
    const listed = {};
    for (const launch of Object.keys(MODEL_LISTS).filter((launch) => available[launch])) {
      const { args, parse } = MODEL_LISTS[launch];
      const list = await probe.run(BINARIES[launch], args);
      listed[launch] = list.code === 0 ? parse(list.stdout) : null;
      if (!listed[launch]) add("warn", `${launch} models`, `${BINARIES[launch]} ${args.join(" ")} failed; sign in to ${BINARIES[launch]}`);
    }
    for (const model of models) {
      const label = `${model.role} ${model.isDefault ? "default" : "fallback"} ${model.id}`;
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

  const gh = await probe.run("gh", ["auth", "status"]);
  if (gh.code === 0) add("ok", "gh", "signed in");
  else add("warn", "gh", gh.code === "ENOENT" ? "gh is not installed; fr gate bots needs it" : "gh is not signed in; run gh auth login (fr gate bots needs it)");

  for (const project of projects) {
    const label = `project ${project.id}`;
    if (!(await probe.exists(project.repoPath))) { add("warn", label, `repo path ${project.repoPath} does not exist; fix it with fr project update ${project.id} --repo <path>`); continue; }
    const hookResult = await probe.run("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: project.repoPath });
    if (hookResult.code !== 0) { add("warn", label, `${project.repoPath} is not a git repository`); continue; }
    const hook = hookResult.stdout.trim();
    const managedBy = await hookManager(probe, project.repoPath, hook);
    const tracked = (await probe.run("git", ["ls-files", "--error-unmatch", "--", hook], { cwd: project.repoPath })).code === 0;
    const state = hookState(await probe.read(hook));
    if ((state === "installed" || state === "gate") && !(await probe.executable(hook))) add("warn", label, `${hook} runs the gate but is not executable, so git skips it; chmod +x it`);
    else if (state === "installed" || state === "gate") add("ok", label, `checkout gate runs from ${hook}`);
    else if (state === "outdated") add("warn", label, `an older Field Report hook is at ${hook}; rerun fr hook install ${project.id}`);
    else if (tracked) add("warn", label, `pre-commit hook ${hook} is a tracked file; fr hook install refuses it. Add \`fr gate checkout\` to that hook instead`);
    else if (managedBy) add("warn", label, `core.hooksPath=${managedBy} (a hook manager such as husky or lefthook); fr hook install refuses it. Add \`fr gate checkout\` to that manager's pre-commit hook`);
    else add("warn", label, `checkout hook not installed; run fr hook install ${project.id}`);
  }

  return results;
}

async function hookManager(probe, repoPath, hook) {
  const hooksPath = (await probe.run("git", ["config", "--get", "core.hooksPath"], { cwd: repoPath })).stdout.trim();
  const commonDir = hooksPath ? (await probe.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoPath })).stdout.trim() : "";
  return hookManagerPath({ hook, hooksPath, commonDir });
}

export function formatDoctor(results) {
  const tag = { ok: "ok  ", warn: "WARN", fail: "FAIL" };
  const lines = results.map((item) => `${tag[item.level]} ${item.label}: ${item.detail}`);
  const fails = results.filter((item) => item.level === "fail").length;
  const warns = results.filter((item) => item.level === "warn").length;
  lines.push(fails ? `${fails} problem(s) to fix, ${warns} warning(s).` : `Ready${warns ? ` with ${warns} warning(s)` : ""}.`);
  return lines.join("\n");
}
