import test from "node:test";
import assert from "node:assert/strict";
import { hookText, isManagedHook, marker, shouldRunPreserved } from "../src/hooks.mjs";

test("managed hook is a small evidence query and preserves an existing hook", () => {
  const text = hookText("/opt/fr", "/repo/.git/hooks/pre-commit.field-report-preserved");
  assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /CODEX_THREAD_ID/);
  assert.match(text, /GIT_INDEX_FILE/);
  assert.match(text, /worktree_admin\/gitdir/);
  assert.match(text, /unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE/);
  assert.match(text, /gate checkout/);
  assert.doesNotMatch(text, /claude|codex exec|sha256|manifest/);
});

test("managed Field Report hooks are replaced; a user hook is preserved", () => {
  assert.equal(isManagedHook("# field-report-managed-pre-commit:v2"), true);
  assert.equal(isManagedHook("# field-report-commit-gate:v3"), true);
  assert.equal(isManagedHook("#!/bin/sh\nnpm test"), false);
  assert.equal(shouldRunPreserved("# field-report-managed-pre-commit:v2", true), true);
  assert.equal(shouldRunPreserved("# field-report-managed-pre-commit:v2", false), false);
  assert.equal(shouldRunPreserved("#!/bin/sh\nnpm test", false), true);
  assert.equal(shouldRunPreserved(`${marker}\n'/repo/.git/hooks/pre-commit.field-report-preserved' || exit $?`, true), true);
});
