#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptFile = fileURLToPath(import.meta.url);
const defaultSourceRoot = path.resolve(path.dirname(scriptFile), "..");
const releaseEntries = ["bin", "docs", "integrations", "scripts", "skills", "src", "package.json"];
const managedPreCommitMarker = "# field-report-managed-pre-commit:v1";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

async function git(sourceRoot, args) {
  try {
    return (await exec("git", args, { cwd: sourceRoot, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message);
  }
}

async function sourceIdentity(sourceRoot) {
  const [revision, remoteMain, commonDir, dirty] = await Promise.all([
    git(sourceRoot, ["rev-parse", "--verify", "HEAD"]),
    git(sourceRoot, ["rev-parse", "--verify", "refs/remotes/origin/main"]),
    git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...releaseEntries])
  ]);
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("Cannot identify an exact Field Report source commit");
  if (revision.toLowerCase() !== remoteMain.toLowerCase()) throw new Error("Refusing to install anything except the exact local origin/main Field Report commit");
  if (dirty) throw new Error("Refusing to install a release with uncommitted runtime, workflow, or skill changes");
  const canonicalGitDir = await realpath(commonDir).catch(() => path.resolve(commonDir));
  if (path.basename(canonicalGitDir) !== ".git") throw new Error("Cannot resolve the canonical Field Report data checkout");
  return { revision: revision.toLowerCase(), stateRoot: path.dirname(canonicalGitDir) };
}

async function atomicReplace(destination, writer) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.next`;
  await writer(temporary);
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function replaceSymlink(target, destination) {
  await atomicReplace(destination, (temporary) => symlink(target, temporary));
}

async function prepareClaudeHooks(home, launcher) {
  const file = path.join(home, ".claude", "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot preserve Claude settings at ${file}: ${error.message}`);
  }
  settings.hooks ||= {};
  const additions = {
    SessionStart: { action: "session-start", timeout: 15 },
    Stop: { action: "stop", timeout: 15 }
  };
  for (const [event, addition] of Object.entries(additions)) {
    settings.hooks[event] = (settings.hooks[event] || []).map((entry) => ({
      ...entry,
      hooks: (entry.hooks || []).filter((hook) => {
        const command = String(hook.command || "");
        return !(command === `fr hook ${addition.action}` || (command.includes("/fr") && command.endsWith(` hook ${addition.action}`)));
      })
    })).filter((entry) => entry.hooks.length);
    settings.hooks[event].push({
      matcher: "",
      hooks: [{ type: "command", command: `${shellQuote(launcher)} hook ${addition.action}`, timeout: addition.timeout }]
    });
  }
  await atomicReplace(file, (temporary) => writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 }));
}

async function configuredPreCommitHooks(stateRoot) {
  const config = JSON.parse(await readFile(path.join(stateRoot, "config", "projects.json"), "utf8"));
  const hooks = [];
  for (const project of config.projects || []) {
    if (!project.repoPath) continue;
    const hook = await git(project.repoPath, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"]);
    try {
      const existing = await readFile(hook, "utf8");
      if (!existing.includes(managedPreCommitMarker)) {
        throw new Error(`Refusing to overwrite the existing pre-commit hook for ${project.id || project.repoPath}: ${hook}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    hooks.push({ hook, project: project.id || project.repoPath });
  }
  return hooks;
}

async function installPreCommitHooks(hooks, launcher) {
  const contents = [
    "#!/bin/sh",
    managedPreCommitMarker,
    "unset FIELD_REPORT_URL",
    `exec ${shellQuote(launcher)} hook pre-commit`,
    ""
  ].join("\n");
  for (const { hook } of hooks) {
    await atomicReplace(hook, (temporary) => writeFile(temporary, contents, { mode: 0o755 }));
  }
}

async function copyRelease(sourceRoot, releasesRoot, revision, stateRoot, nodeExecutable) {
  const releaseRoot = path.join(releasesRoot, revision);
  try {
    const manifest = JSON.parse(await readFile(path.join(releaseRoot, "install-manifest.json"), "utf8"));
    if (manifest.revision !== revision || manifest.stateRoot !== stateRoot || manifest.nodeExecutable !== nodeExecutable) {
      throw new Error(`Existing Field Report release ${revision} has different runtime metadata`);
    }
    return releaseRoot;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await mkdir(releasesRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(releasesRoot, `.release-${revision.slice(0, 12)}-`));
  try {
    for (const entry of releaseEntries) {
      await cp(path.join(sourceRoot, entry), path.join(temporary, entry), {
        recursive: true,
        errorOnExist: true,
        preserveTimestamps: true
      });
    }
    await writeFile(path.join(temporary, "install-manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      revision,
      stateRoot,
      nodeExecutable
    }, null, 2)}\n`);
    await rename(temporary, releaseRoot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return releaseRoot;
}

export async function installFieldReport(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || defaultSourceRoot);
  const home = path.resolve(options.home || os.homedir());
  const nodeExecutable = path.resolve(options.nodeExecutable || process.execPath);
  await access(nodeExecutable);
  const { revision, stateRoot } = await sourceIdentity(sourceRoot);
  const preCommitHooks = await configuredPreCommitHooks(stateRoot);
  const installRoot = path.resolve(options.installRoot || path.join(home, ".local", "share", "field-report"));
  const releaseRoot = await copyRelease(sourceRoot, path.join(installRoot, "releases"), revision, stateRoot, nodeExecutable);
  const launcher = path.join(home, ".local", "bin", "fr");
  const launcherText = [
    "#!/bin/sh",
    `export FIELD_REPORT_ROOT=${shellQuote(stateRoot)}`,
    `export FIELD_REPORT_RUNTIME_ROOT=${shellQuote(releaseRoot)}`,
    `export FIELD_REPORT_RELEASE_REVISION=${shellQuote(revision)}`,
    `exec ${shellQuote(nodeExecutable)} ${shellQuote(path.join(releaseRoot, "bin", "fr.mjs"))} "$@"`,
    ""
  ].join("\n");
  await atomicReplace(launcher, (temporary) => writeFile(temporary, launcherText, { mode: 0o755 }));

  for (const skill of ["field-report", "repo-coordinator", "workstream-orchestrator"]) {
    await replaceSymlink(path.join(releaseRoot, "skills", skill), path.join(home, ".codex", "skills", skill));
    await replaceSymlink(path.join(releaseRoot, "skills", skill), path.join(home, ".claude", "skills", skill));
  }
  await replaceSymlink(path.join(releaseRoot, "integrations", "claude", "commands", "fr.md"), path.join(home, ".claude", "commands", "fr.md"));
  await prepareClaudeHooks(home, launcher);
  await installPreCommitHooks(preCommitHooks, launcher);

  return { launcher, nodeExecutable, preCommitHooks, releaseRoot, revision, stateRoot };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const installed = await installFieldReport();
  process.stdout.write([
    `Installed Field Report ${installed.revision.slice(0, 12)}.`,
    `Runtime: ${installed.releaseRoot}`,
    `Canonical data: ${installed.stateRoot}`,
    `Launcher: ${installed.launcher} (Node ${installed.nodeExecutable})`,
    "`fr doctor` is available for diagnostics; it is not an onboarding prerequisite.",
    ""
  ].join("\n"));
}
