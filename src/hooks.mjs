import path from "node:path";

export const marker = "# field-report-commit-gate:v4";

export function quote(value) { return `'${String(value).replaceAll("'", "'\"'\"'")}'`; }

export function isManagedHook(text) {
  return Boolean(text) && /field-report-(?:commit-gate|managed-pre-commit):/.test(text);
}

// One reading of a pre-commit hook for fr hook status and fr doctor: our current
// hook, an older Field Report hook, a hook manager's file that runs the gate, or none.
export function hookState(text) {
  if (!text) return "missing";
  if (text.includes(marker)) return "installed";
  if (isManagedHook(text)) return "outdated";
  if (/\bfr\b.*\bgate checkout\b/.test(text)) return "gate";
  return "missing";
}

// core.hooksPath names a hook manager (husky, lefthook) unless it is git's own
// hooks folder. Returns the managing path or null.
export function hookManagerPath({ hook, hooksPath, commonDir }) {
  if (!hooksPath) return null;
  return commonDir && path.resolve(path.dirname(hook)) === path.resolve(commonDir, "hooks") ? null : hooksPath;
}

export function shouldRunPreserved(existing, preservedExists) {
  if (existing == null) return false;
  if (isManagedHook(existing)) {
    if (existing.includes(".field-report-preserved")) return preservedExists;
    return preservedExists && /field-report-managed-pre-commit:/.test(existing);
  }
  return true;
}

export function hookText(launcher, preserved = null) {
  return [
    "#!/bin/sh",
    marker,
    ...(preserved ? [`${quote(preserved)} || exit $?`] : []),
    "worktree_admin=${GIT_INDEX_FILE%/index}",
    "if [ -n \"${GIT_INDEX_FILE:-}\" ] && [ -f \"$worktree_admin/gitdir\" ]; then",
    "  worktree_gitdir=$(sed -n '1p' \"$worktree_admin/gitdir\")",
    "  cd \"$(dirname \"$worktree_gitdir\")\" || exit 1",
    "  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE",
    "fi",
    `exec ${quote(launcher)} gate checkout`,
    ""
  ].join("\n");
}
