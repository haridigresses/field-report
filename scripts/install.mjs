#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  readlink,
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
import { contentDigest, isExclusivelyManagedPreCommitHook, managedPreCommitMarker, preCommitHookText, releaseLauncherText, shellQuote } from "../src/hooks.mjs";
import { assertInstalledRelease, materializeGitRelease, releasePayloadDigest, releasePayloadEntries } from "../src/release-integrity.mjs";

const exec = promisify(execFile);
const scriptFile = fileURLToPath(import.meta.url);
const defaultSourceRoot = path.resolve(path.dirname(scriptFile), "..");
const releaseEntries = releasePayloadEntries;
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

async function snapshotSurface(destination) {
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) return { kind: "symlink", target: await readlink(destination) };
    if (existing.isFile()) return { kind: "file", contents: await readFile(destination), mode: existing.mode & 0o777 };
    throw new Error(`Cannot snapshot unsupported Field Report surface: ${destination}`);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

async function restoreSurface(destination, snapshot) {
  if (snapshot.kind === "missing") return rm(destination, { force: true });
  if (snapshot.kind === "symlink") return replaceSymlink(snapshot.target, destination);
  return atomicReplace(destination, (temporary) => writeFile(temporary, snapshot.contents, { mode: snapshot.mode }));
}

export async function activateSurfaces(steps) {
  const snapshots = new Map();
  for (const { destination } of steps) {
    if (!snapshots.has(destination)) snapshots.set(destination, await snapshotSurface(destination));
  }
  const attempted = [];
  try {
    for (const step of steps) {
      attempted.push(step.destination);
      await step.write();
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const destination of [...new Set(attempted)].reverse()) {
      try { await restoreSurface(destination, snapshots.get(destination)); }
      catch (rollbackError) { rollbackErrors.push(`${destination}: ${rollbackError.message}`); }
    }
    if (rollbackErrors.length) throw new Error(`${error.message}; Field Report activation rollback also failed: ${rollbackErrors.join("; ")}`, { cause: error });
    throw error;
  }
}

async function planClaudeHooks(home, launcher) {
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
  return { file, text: `${JSON.stringify(settings, null, 2)}\n` };
}

async function installClaudeHooks(plan) {
  await atomicReplace(plan.file, (temporary) => writeFile(temporary, plan.text, { mode: 0o600 }));
}

async function writableAncestor(destination) {
  let candidate = path.dirname(destination);
  while (candidate !== path.dirname(candidate)) {
    try {
      const existing = await lstat(candidate);
      if (!existing.isDirectory()) throw new Error(`Expected a directory while preflighting ${destination}: ${candidate}`);
      await access(candidate, fsConstants.W_OK | fsConstants.X_OK);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Cannot install Field Report surface at ${destination}: ${error.message}`);
      candidate = path.dirname(candidate);
    }
  }
  throw new Error(`Cannot resolve a writable parent for ${destination}`);
}

async function preflightFileDestination(destination) {
  try {
    const existing = await lstat(destination);
    if (!(existing.isFile() || existing.isSymbolicLink())) throw new Error(`Refusing to replace unsupported Field Report surface: ${destination}`);
  } catch (error) {
    if (error.code === "ENOTDIR") throw new Error(`Expected a directory while preflighting ${destination}`);
    if (error.code !== "ENOENT") throw error;
  }
  await writableAncestor(destination);
}

async function preflightSymlinks(destinations) {
  for (const destination of destinations) {
    try {
      const existing = await lstat(destination);
      if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink Field Report surface: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writableAncestor(destination);
  }
}

async function managedReleaseLaunchers(releasesRoot, stateRoot) {
  const launchers = [];
  try {
    for (const entry of await readdir(releasesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{40}$/i.test(entry.name)) continue;
      const revision = entry.name.toLowerCase();
      const runtimeRoot = path.join(releasesRoot, entry.name);
      try {
        await assertInstalledRelease({ runtimeRoot, stateRoot, revision, allowLegacySchema1: true });
        launchers.push(path.join(runtimeRoot, "fr"));
      } catch {
        // An invalid directory cannot establish ownership of a repository hook.
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return launchers;
}

async function configuredPreCommitHooks(stateRoot, expectedLaunchers) {
  const config = JSON.parse(await readFile(path.join(stateRoot, "config", "projects.json"), "utf8"));
  const hooks = [];
  for (const project of config.projects || []) {
    if (!project.repoPath) continue;
    const hook = await git(project.repoPath, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"]);
    const preservedHook = `${hook}.field-report-preserved`;
    let preserve = null;
    let composed = false;
    let preservedDigest = null;
    try {
      const preservedStat = await lstat(preservedHook);
      if (!(preservedStat.isFile() || preservedStat.isSymbolicLink())) throw new Error(`Unsupported preserved pre-commit hook: ${preservedHook}`);
      await access(preservedHook, fsConstants.X_OK);
      preservedDigest = contentDigest(await readFile(preservedHook));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      const existing = await readFile(hook, "utf8");
      const managedPlain = expectedLaunchers.some((launcher) => isExclusivelyManagedPreCommitHook(existing, launcher, null, null, true));
      const managedComposed = preservedDigest && expectedLaunchers.some((launcher) => isExclusivelyManagedPreCommitHook(existing, launcher, preservedHook, preservedDigest));
      if (existing.includes(managedPreCommitMarker) && !managedPlain && !managedComposed) throw new Error(`Managed composed pre-commit hook is incomplete or drifted: ${hook}`);
      if (!managedPlain && !managedComposed) {
        try {
          await lstat(preservedHook);
          throw new Error(`Cannot preserve the existing pre-commit hook because ${preservedHook} already exists`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        preserve = await snapshotSurface(hook);
        await access(hook, fsConstants.X_OK);
        preservedDigest = contentDigest(existing);
        composed = true;
      } else composed = managedComposed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (preservedDigest && !composed) throw new Error(`Managed pre-commit wrapper is missing while its preserved hook remains: ${hook}`);
    hooks.push({ hook, preserve, preservedDigest: composed ? preservedDigest : null, preservedHook: composed ? preservedHook : null, project: project.id || project.repoPath });
  }
  return hooks;
}

async function copyRelease(sourceRoot, releasesRoot, revision, stateRoot, nodeExecutable) {
  const releaseRoot = path.join(releasesRoot, revision);
  const sourceDigest = await releasePayloadDigest(sourceRoot);
  let replaceExisting = false;
  try {
    const manifest = JSON.parse(await readFile(path.join(releaseRoot, "install-manifest.json"), "utf8"));
    if (manifest.revision !== revision || manifest.stateRoot !== stateRoot || manifest.nodeExecutable !== nodeExecutable) {
      throw new Error(`Existing Field Report release ${revision} has different runtime metadata`);
    }
    replaceExisting = manifest.schemaVersion !== 2 || manifest.payloadDigest !== sourceDigest || await releasePayloadDigest(releaseRoot) !== sourceDigest;
    if (!replaceExisting) {
      for (const entry of releaseEntries) {
        try { await exec("git", ["diff", "--no-index", "--quiet", "--", path.join(sourceRoot, entry), path.join(releaseRoot, entry)], { timeout: 30_000, maxBuffer: 1024 * 1024 }); }
        catch { replaceExisting = true; break; }
      }
    }
    if (!replaceExisting) return { finalize: async () => {}, rollback: async () => {}, root: releaseRoot };
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
      schemaVersion: 2,
      revision,
      stateRoot,
      nodeExecutable,
      payloadDigest: sourceDigest
    }, null, 2)}\n`);
    await writeFile(path.join(temporary, "fr"), releaseLauncherText({ stateRoot, runtimeRoot: releaseRoot, revision, nodeExecutable }), { mode: 0o755 });
    let displaced = null;
    if (!replaceExisting) await rename(temporary, releaseRoot);
    else {
      displaced = `${releaseRoot}.${process.pid}.${Date.now()}.replaced`;
      await rename(releaseRoot, displaced);
      try { await rename(temporary, releaseRoot); }
      catch (error) { await rename(displaced, releaseRoot); throw error; }
    }
    return {
      root: releaseRoot,
      finalize: async () => { if (displaced) await rm(displaced, { recursive: true, force: true }); },
      rollback: async () => {
        await rm(releaseRoot, { recursive: true, force: true });
        if (displaced) await rename(displaced, releaseRoot);
      }
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function installFieldReport(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || defaultSourceRoot);
  const home = path.resolve(options.home || os.homedir());
  const nodeExecutable = path.resolve(options.nodeExecutable || process.execPath);
  await access(nodeExecutable);
  const { revision, stateRoot } = await sourceIdentity(sourceRoot);
  const installRoot = path.resolve(options.installRoot || path.join(home, ".local", "share", "field-report"));
  const releasesRoot = path.join(installRoot, "releases");
  const releaseSource = await materializeGitRelease(sourceRoot, revision);
  let releaseTransaction;
  try { releaseTransaction = await copyRelease(releaseSource, releasesRoot, revision, stateRoot, nodeExecutable); }
  finally { await rm(releaseSource, { recursive: true, force: true }); }
  const releaseRoot = releaseTransaction.root;
  try {
  const preCommitHooks = await configuredPreCommitHooks(stateRoot, await managedReleaseLaunchers(releasesRoot, stateRoot));
  const launcher = path.join(home, ".local", "bin", "fr");
  const releaseLauncher = path.join(releaseRoot, "fr");
  const skillLinks = ["field-report", "repo-coordinator", "workstream-orchestrator"].flatMap((skill) => [
    { target: path.join(releaseRoot, "skills", skill), destination: path.join(home, ".codex", "skills", skill) },
    { target: path.join(releaseRoot, "skills", skill), destination: path.join(home, ".claude", "skills", skill) }
  ]);
  skillLinks.push({ target: path.join(releaseRoot, "integrations", "claude", "commands", "fr.md"), destination: path.join(home, ".claude", "commands", "fr.md") });
  const claudeHooks = await planClaudeHooks(home, releaseLauncher);
  await preflightSymlinks(skillLinks.map((link) => link.destination));
  await preflightFileDestination(launcher);
  await preflightFileDestination(releaseLauncher);
  await Promise.all([claudeHooks.file, ...preCommitHooks.flatMap(({ hook, preserve, preservedHook }) => [hook, ...(preserve ? [preservedHook] : [])])].map(writableAncestor));
  const launcherText = releaseLauncherText({ stateRoot, runtimeRoot: releaseRoot, revision, nodeExecutable });
  await activateSurfaces([
    { destination: releaseLauncher, write: () => atomicReplace(releaseLauncher, (temporary) => writeFile(temporary, launcherText, { mode: 0o755 })) },
    { destination: claudeHooks.file, write: () => installClaudeHooks(claudeHooks) },
    ...preCommitHooks.flatMap(({ hook, preserve, preservedDigest, preservedHook }) => [
      ...(preserve ? [{ destination: preservedHook, write: () => restoreSurface(preservedHook, preserve) }] : []),
      { destination: hook, write: () => atomicReplace(hook, (temporary) => writeFile(temporary, preCommitHookText(releaseLauncher, preservedHook, preservedDigest), { mode: 0o755 })) }
    ]),
    ...skillLinks.map((link) => ({ destination: link.destination, write: () => replaceSymlink(link.target, link.destination) })),
    { destination: launcher, write: () => atomicReplace(launcher, (temporary) => writeFile(temporary, launcherText, { mode: 0o755 })) }
  ]);
  await releaseTransaction.finalize();
  return { launcher, nodeExecutable, preCommitHooks, releaseLauncher, releaseRoot, revision, stateRoot };
  } catch (error) {
    await releaseTransaction.rollback();
    throw error;
  }
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
