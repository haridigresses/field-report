import { createHash } from "node:crypto";

export const managedPreCommitMarker = "# field-report-managed-pre-commit:v2";
const legacyManagedPreCommitMarker = "# field-report-managed-pre-commit:v1";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function contentDigest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function preCommitHookText(launcher, preservedHook = null, preservedDigest = null) {
  const lines = [
    "#!/bin/sh",
    managedPreCommitMarker,
    "unset FIELD_REPORT_URL",
    "unset FIELD_REPORT_CWD"
  ];
  if (preservedHook) {
    if (!/^[0-9a-f]{64}$/i.test(preservedDigest || "")) throw new Error("A composed Field Report hook requires the preserved hook digest");
    lines.push(
      `# preserved-hook-sha256:${preservedDigest.toLowerCase()}`,
      `[ -x ${shellQuote(preservedHook)} ] || { echo 'Field Report: preserved pre-commit hook is missing or non-executable' >&2; exit 1; }`,
      `${shellQuote(preservedHook)} || exit $?`
    );
  }
  lines.push(`exec ${shellQuote(launcher)} hook pre-commit`, "");
  return lines.join("\n");
}

export function releaseLauncherText({ stateRoot, runtimeRoot, revision, nodeExecutable }) {
  return [
    "#!/bin/sh",
    `export FIELD_REPORT_ROOT=${shellQuote(stateRoot)}`,
    `export FIELD_REPORT_RUNTIME_ROOT=${shellQuote(runtimeRoot)}`,
    `export FIELD_REPORT_RELEASE_REVISION=${shellQuote(revision)}`,
    `exec ${shellQuote(nodeExecutable)} ${shellQuote(`${runtimeRoot}/bin/fr.mjs`)} "$@"`,
    ""
  ].join("\n");
}

export function isExclusivelyManagedPreCommitHook(contents, expectedLauncher, preservedHook = null, preservedDigest = null, allowLegacy = false) {
  if (String(contents) === preCommitHookText(expectedLauncher, preservedHook, preservedDigest)) return true;
  return allowLegacy && String(contents) === preCommitHookText(expectedLauncher).replace(managedPreCommitMarker, legacyManagedPreCommitMarker);
}
