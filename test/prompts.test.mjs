import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildUserContract, capturePromptFromHook, formatCappedPrompts } from "../src/prompts.mjs";
import { createStore } from "../src/store.mjs";

const exec = promisify(execFile);

test("session-keyed prompt capture works across main checkout and git worktrees without branch guessing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-prompts-wt-"));
  const repo = path.join(root, "repo");
  const wt = path.join(root, "repo-wt");
  const other = path.join(root, "unregistered");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "fr@example.invalid"]);
  await exec("git", ["-C", repo, "config", "user.name", "FR"]);
  await exec("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
  await exec("git", ["-C", repo, "worktree", "add", "-b", "feat/wt", wt]);
  await exec("git", ["init", "-b", "main", other]);

  const store = createStore(path.join(root, "state"));
  const project = await store.saveProject({ id: "app", repoPath: repo });

  // Unregistered repo is silently ignored.
  const skipped = await capturePromptFromHook(JSON.stringify({ session_id: "s1", cwd: other, prompt: "ignore me" }), { store });
  assert.equal(skipped.captured, false);

  // User chats in `repo` (on `main`) while agent later runs MRR inside `wt` (`feat/wt`).
  await capturePromptFromHook(JSON.stringify({ session_id: "s1", cwd: repo, prompt: "Build feature X" }), { store });
  await capturePromptFromHook(JSON.stringify({ session_id: "s1", cwd: repo, prompt: "Actually drop Y, keep X simple" }), { store });
  // Concurrent second session in the same repo does not leak into s1.
  await capturePromptFromHook(JSON.stringify({ session_id: "s2", cwd: repo, prompt: "Unrelated refactor Z" }), { store });

  const contract = await buildUserContract({
    store,
    project,
    env: { FR_SESSION_ID: "s1" },
    brr: { source: "docs/plans/x.md", text: "Approved BRR plan" }
  });
  assert.equal(contract.sessionId, "s1");
  assert.equal(contract.promptCount, 2);
  assert.match(contract.text, /AUTHORITATIVE BRR PLAN \(docs\/plans\/x\.md\) — DOMINATES/);
  assert.match(contract.text, /Actually drop Y, keep X simple/);
  assert.doesNotMatch(contract.text, /Unrelated refactor Z/);
});

test("formatCappedPrompts preserves initial framing and newest pivots within byte budget", () => {
  const entries = [
    { ts: "2026-11-27T01:00:00Z", prompt: "Initial goal: build safe gate" },
    { ts: "2026-11-27T01:05:00Z", prompt: "middle ".repeat(400) },
    { ts: "2026-11-27T01:10:00Z", prompt: "Final pivot: allow draft PRs" }
  ];
  const capped = formatCappedPrompts(entries, 600);
  assert.ok(Buffer.byteLength(capped, "utf8") <= 600);
  assert.match(capped, /Initial goal: build safe gate/);
  assert.match(capped, /Final pivot: allow draft PRs/);
});
