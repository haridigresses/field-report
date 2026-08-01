export const marker = "# field-report-commit-gate:v3";
export const legacyMarker = "# field-report-managed-pre-commit:v2";

export function quote(value) { return `'${String(value).replaceAll("'", "'\"'\"'")}'`; }

export function shouldRunPreserved(existing, preservedExists) {
  if (existing == null) return false;
  if (existing.includes(marker)) return preservedExists && existing.includes(".field-report-preserved");
  return !existing.includes(legacyMarker) || preservedExists;
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
    `exec ${quote(launcher)} gate commit`,
    ""
  ].join("\n");
}
