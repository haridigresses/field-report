import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildUserContract, capturePromptFromHook, formatCappedPrompts } from "../src/prompts.mjs";
import { detectRepoBrr, verifyBrrAtBaseHead } from "../src/repository.mjs";
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
    brr: { source: "docs/plans/x.md", text: "Approved BRR plan", authoritative: true }
  });
  assert.equal(contract.sessionId, "s1");
  assert.equal(contract.promptCount, 2);
  assert.match(contract.text, /AUTHORITATIVE BRR PLAN \(docs\/plans\/x\.md\) — DOMINATES/);
  assert.match(contract.text, /Actually drop Y, keep X simple/);
  assert.doesNotMatch(contract.text, /Unrelated refactor Z/);

  // F26: passing --session <bogus> when captured sessions exist throws rather than falling through to --intent-file!
  await assert.rejects(
    buildUserContract({ store, project, sessionId: "bogus", intentFileText: "Builder self-serving story" }),
    /No captured prompts found for --session 'bogus'/
  );
  // Without --session or FR_SESSION_ID, buildUserContract NEVER guesses (even for 1 or 2 sessions) — asks for --session <id>!
  await assert.rejects(
    buildUserContract({ store, project, env: {} }),
    /Captured prompt session\(s\) exist.*pass --session <id>/
  );
  // Exported env session (e.g. FR_SESSION_ID on SessionStart) with 0 prompts degrades gracefully instead of throwing against historical sessions, and ignores --intent-file when historical sessions exist.
  const emptyEnvContract = await buildUserContract({
    store,
    project,
    env: { FR_SESSION_ID: "fresh-session-no-prompts" },
    intentFileText: "Should not inject when sessions exist"
  });
  assert.equal(emptyEnvContract.promptCount, 0);
  assert.match(emptyEnvContract.text, /NO CAPTURED USER PROMPTS OR BRR/);
  assert.doesNotMatch(emptyEnvContract.text, /Should not inject/);

  // F26 + detectRepoBrr: single signed-off plan on baseHead auto-loads even if untouched in diff;
  // verifyBrrAtBaseHead marks only blobs matching baseHead as authoritative.
  await mkdir(path.join(repo, "docs", "plans"), { recursive: true });
  const planFile = path.join(repo, "docs", "plans", "spec.md");
  await writeFile(planFile, "Signed-off plan\n");
  await exec("git", ["-C", repo, "add", "docs/plans/spec.md"]);
  await exec("git", ["-C", repo, "commit", "-m", "add plan"]);
  const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();

  const autoDetected = await detectRepoBrr(repo, baseSha, ["docs/plans/new-decoy-not-on-base.md"]);
  assert.equal(autoDetected?.authoritative, true);
  assert.equal(autoDetected?.text, "Signed-off plan");

  const brrOnlyContract = await buildUserContract({
    store,
    project,
    env: { FR_SESSION_ID: "fresh-session-no-prompts" },
    brr: autoDetected
  });
  assert.match(brrOnlyContract.text, /AUTHORITATIVE BRR PLAN/);
  assert.doesNotMatch(brrOnlyContract.text, /NO CAPTURED USER PROMPTS OR BRR/);

  const authCheck = await verifyBrrAtBaseHead(repo, baseSha, planFile, "Signed-off plan\n");
  assert.equal(authCheck.authoritative, true);
  const tamperedCheck = await verifyBrrAtBaseHead(repo, baseSha, planFile, "Builder altered plan\n");
  assert.equal(tamperedCheck.authoritative, false);
  const externalCheck = await verifyBrrAtBaseHead(repo, baseSha, path.join(root, "fake.md"), "Signed-off plan\n");
  assert.equal(externalCheck.authoritative, false);

  const nonAuthContract = await buildUserContract({
    store,
    project,
    sessionId: "s1",
    brr: { source: "/tmp/fake.md", text: "Fake plan", authoritative: false }
  });
  assert.equal(nonAuthContract.hasBrr, false);
  assert.match(nonAuthContract.text, /BUILDER-SUPPLIED PLAN CONTEXT.*NOT verified on baseHead/);
  assert.doesNotMatch(nonAuthContract.text, /DOMINATES/);
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
