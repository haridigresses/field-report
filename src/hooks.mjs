import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Managed git pre-commit hook (v5) enforcing recorded staged-tree CRR (`fr gate commit`)
// in enabled repositories with zero branch/workstream registration, chaining any
// pre-existing user hook cleanly via `<hook>.field-report-preserved`.

export const CURRENT_HOOK_MARKER = "# field-report-commit-gate:v5";

export function quote(value) { return `'${String(value).replaceAll("'", "'\"'\"'")}'`; }

export function isManagedHook(text) {
  return Boolean(text) && /field-report-(?:commit-gate|managed-pre-commit):/.test(text);
}

export function hookState(text) {
  if (!text) return "absent";
  if (String(text).includes(CURRENT_HOOK_MARKER)) return "current";
  if (isManagedHook(text)) return "legacy-managed";
  if (/\bfr\b.*\bgate commit\b/.test(text) && !/\bgate checkout\b/.test(text)) return "manual-current";
  if (/\bfr\b.*\bgate checkout\b/.test(text)) return "legacy-manual";
  return "unmanaged";
}

export function renderPreCommitHook(frBin) {
  return [
    "#!/bin/sh",
    CURRENT_HOOK_MARKER,
    "set -e",
    "HOOK_SELF=\"$0\"",
    "if [ -x \"${HOOK_SELF}.field-report-preserved\" ]; then",
    "  \"${HOOK_SELF}.field-report-preserved\" \"$@\"",
    "fi",
    `exec ${quote(frBin)} gate commit`,
    ""
  ].join("\n");
}

async function defaultExists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function defaultRead(file) {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

export async function installPreCommitHook(hookPath, frBin, { readFileFn = defaultRead, existsFn = defaultExists } = {}) {
  const existing = await readFileFn(hookPath);
  const preserved = `${hookPath}.field-report-preserved`;
  if (existing && !isManagedHook(existing)) {
    if (!(await existsFn(preserved))) {
      await mkdir(path.dirname(preserved), { recursive: true });
      await copyFile(hookPath, preserved);
      await chmod(preserved, 0o755).catch(() => {});
    }
  }
  await mkdir(path.dirname(hookPath), { recursive: true });
  const temp = `${hookPath}.${process.pid}.next`;
  await writeFile(temp, renderPreCommitHook(frBin), { mode: 0o755 });
  await rename(temp, hookPath);
  return { installed: true, preservedExisting: Boolean(existing && !isManagedHook(existing)) };
}

export async function installProjectPreCommitHook(repoPath, frBin) {
  try {
    const [commonRes, hookRes] = await Promise.all([
      exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoPath, timeout: 5_000 }),
      exec("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: repoPath, timeout: 5_000 })
    ]);
    const commonDir = path.resolve(commonRes.stdout.trim());
    const hookPath = path.resolve(hookRes.stdout.trim());
    // Never dirty tracked hook directories outside `.git` (e.g. `.husky/`); doctor warns if core.hooksPath lacks `fr gate commit`.
    const relToCommon = path.relative(commonDir, hookPath);
    if (relToCommon.startsWith("..") || path.isAbsolute(relToCommon)) {
      const current = await defaultRead(hookPath);
      return { installed: false, externalHooksPath: hookPath, alreadyCallsFr: hookState(current) === "manual-current" };
    }
    const res = await installPreCommitHook(hookPath, frBin);
    return { ...res, hookPath };
  } catch (error) {
    return { installed: false, error: error.message };
  }
}

export async function removePreCommitHook(hookPath, { readFileFn = defaultRead, existsFn = defaultExists } = {}) {
  const text = await readFileFn(hookPath);
  if (!isManagedHook(text)) return { removed: false, restoredPreserved: false };
  const preserved = `${hookPath}.field-report-preserved`;
  if (await existsFn(preserved)) {
    await copyFile(preserved, hookPath);
    await chmod(hookPath, 0o755).catch(() => {});
    await rm(preserved, { force: true });
    return { removed: true, restoredPreserved: true };
  }
  await rm(hookPath, { force: true });
  return { removed: true, restoredPreserved: false };
}

export const removeLegacyPreCommitHook = removePreCommitHook;
