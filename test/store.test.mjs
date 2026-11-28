import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { branchKey, createStore, decodeBranchKey, describePlans, describeTodos } from "../src/store.mjs";

const exec = promisify(execFile);

test("branchKey and decodeBranchKey form a collision-free bijection for slash and dot branches", () => {
  const names = ["feat/a_b", "feat_a/b", "fix/v1.2.3/bug", "..weird.."];
  const encoded = names.map(branchKey);
  assert.equal(new Set(encoded).size, names.length);
  for (const raw of encoded) assert.equal(raw.includes("/"), false);
  assert.deepEqual(encoded.map(decodeBranchKey), names);
});

test("store rejects duplicate registrations of the same repository or its worktrees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-store-dedup-"));
  const repo = path.join(root, "repo");
  const wt = path.join(root, "repo-wt");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "fr@example.invalid"]);
  await exec("git", ["-C", repo, "config", "user.name", "FR"]);
  await exec("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
  await exec("git", ["-C", repo, "worktree", "add", "-b", "feat/wt", wt]);

  const store = createStore(path.join(root, "state"));
  await store.saveProject({ id: "first", repoPath: repo });
  await assert.rejects(store.saveProject({ id: "dup-same", repoPath: repo }), /already registered under project first/);
  await assert.rejects(store.saveProject({ id: "dup-wt", repoPath: wt }), /already registered under project first/);
});

test("store records branch-keyed MRR reviews once per runId and assigns atomic finding IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-store-reviews-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", repoPath: root });

  const crr = await store.addReview("sample", "feat/login", { runId: "run-crr", kind: "crr", findings: ["minor"], unresolved: [] });
  assert.deepEqual(crr.assignedFindingIds, []);

  const [r1, r2] = await Promise.all([
    store.addReview("sample", "feat/login", { runId: "run-1", kind: "mrr", findings: ["Bug A"], unresolved: [] }),
    store.addReview("sample", "feat/login", { runId: "run-2", kind: "mrr", findings: ["Bug B"], unresolved: [] })
  ]);
  assert.deepEqual(new Set([...r1.assignedFindingIds, ...r2.assignedFindingIds]), new Set(["F1", "F2"]));

  await assert.rejects(store.addReview("sample", "feat/login", { runId: "run-1", kind: "mrr", findings: [] }), /recorded only once/);
  assert.deepEqual(await store.trackedBranches("sample"), ["feat/login"]);
});

test("store validates finding dispositions, session prompts, reports, and project destinations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-store-meta-"));
  const store = createStore(root);
  const p = await store.saveProject({ id: "sample", repoPath: root, githubRepo: "owner/sample" });
  assert.equal(describeTodos(p.todos, p), "GitHub issues in owner/sample (gh issue create)");
  assert.equal(describePlans(p.plans), "docs/plans/ in this repository");

  await store.appendPrompt("sample", { sessionId: "sess-1", prompt: "First ask" });
  await store.appendPrompt("sample", { sessionId: "sess-2", prompt: "Other session" });
  assert.equal((await store.prompts("sample", "sess-1")).length, 1);
  assert.equal((await store.promptSessions("sample")).length, 2);

  await store.saveReport("sample", "feat/x", "# Report\n\nClean");
  assert.match(await store.readReport("sample", "feat/x"), /# Report/);

  await assert.rejects(
    store.addDisposition("sample", "feat/x", { findingId: "F9", reason: "ok" }, { validFindingIds: new Set(["F1"]) }),
    /Unknown MRR finding F9/
  );
  await store.addDisposition("sample", "feat/x", { findingId: "F1", reason: "ok", actor: "hari" }, { validFindingIds: new Set(["F1"]) });
  assert.equal((await store.dispositions("sample", "feat/x")).length, 1);

  await store.removeProject("sample");
  assert.equal((await store.projects()).length, 0);
});
