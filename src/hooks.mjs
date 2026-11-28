import { copyFile, rm } from "node:fs/promises";
import path from "node:path";

// Legacy Field Report git pre-commit hook detection and cleanup.
// Branch-keyed Field Report no longer uses a git pre-commit registration hook;
// legacy managed hooks are cleanly uninstalled (restoring any preserved user hook).

export const marker = "# field-report-commit-gate:v4";

export function quote(value) { return `'${String(value).replaceAll("'", "'\"'\"'")}'`; }

export function isManagedHook(text) {
  return Boolean(text) && /field-report-(?:commit-gate|managed-pre-commit):/.test(text);
}

export function hookState(text) {
  if (!text) return "absent";
  if (isManagedHook(text)) return "legacy-managed";
  if (/\bfr\b.*\bgate (?:checkout|commit)\b/.test(text)) return "legacy-manual";
  return "absent";
}

export function hookManagerPath({ hook, hooksPath, commonDir }) {
  if (!hooksPath) return null;
  return commonDir && path.resolve(path.dirname(hook)) === path.resolve(commonDir, "hooks") ? null : hooksPath;
}

export async function removeLegacyPreCommitHook(hookPath, { readFileFn, existsFn } = {}) {
  const text = await readFileFn(hookPath);
  if (!isManagedHook(text)) return { removed: false, restoredPreserved: false };
  const preserved = `${hookPath}.field-report-preserved`;
  if (await existsFn(preserved)) {
    await copyFile(preserved, hookPath);
    await rm(preserved, { force: true });
    return { removed: true, restoredPreserved: true };
  }
  await rm(hookPath, { force: true });
  return { removed: true, restoredPreserved: false };
}
