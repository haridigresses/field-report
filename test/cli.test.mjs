import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");

async function run(args, cwd, state) {
  return (await exec(process.execPath, [cli, ...args], { cwd, env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout;
}

test("CLI records a native delegation lifecycle without launching an agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-cli-"));
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["config", "user.email", "fr-test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Field Report Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "test\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });

  await run(["project", "add", "sample", "--label", "Sample", "--repo", repo], repo, state);
  await exec("git", ["branch", "-m", "unsafe'quote"], { cwd: repo });
  await assert.rejects(run(["gate", "commit"], repo, state), (error) => /Self-register without coordinator approval/.test(error.stderr || "") && (error.stderr || "").includes(`--branch 'unsafe'"'"'quote'`));
  await exec("git", ["branch", "-m", "main"], { cwd: repo });
  await run(["create", "outcome", "--project", "sample", "--title", "Outcome", "--outcome", "Ship bounded change", "--branch", "main", "--owner-task", "owner-1"], repo, state);
  const brief = JSON.parse(await run(["delegate", "brief", "outcome", "--role", "executor", "--slice", "Implement one bounded change"], repo, state));
  assert.equal(brief.delegation.type, "work");
  assert.deepEqual(brief.execution, { fork_turns: "none" });
  assert.match(brief.prompt, /run `af-onboard-safe`/);
  assert.match(brief.prompt, /Agent Fixes for session context and issue lineage/);
  assert.match(brief.prompt, /retry `af onboard` once with normal escalation/);
  await run(["delegate", "bind", "outcome", "--delegation", brief.delegation.id, "--task-id", "native-task-7"], repo, state);
  const completion = path.join(root, "completion.json");
  await writeFile(completion, JSON.stringify({ delegationId: brief.delegation.id, taskId: "native-task-7", completed: true, checksRun: ["npm test"], unresolved: [], summary: "Incomplete evidence" }));
  await assert.rejects(run(["delegate", "complete", "outcome", "--delegation", brief.delegation.id, "--file", completion], repo, state), /skippedChecks/);
  await writeFile(completion, JSON.stringify({ delegationId: brief.delegation.id, taskId: "native-task-7", completed: true, checksRun: ["npm test"], skippedChecks: [], scopeDeviations: [], changedPremises: [], acceptanceEvidence: ["Expected file changed"], unresolved: [], summary: "Done" }));
  await run(["delegate", "complete", "outcome", "--delegation", brief.delegation.id, "--file", completion], repo, state);
  const events = (await readFile(path.join(state, "delegations", "outcome.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((item) => item.event), ["created", "bound", "completed"]);
  assert.equal(events[2].taskId, "native-task-7");

  await writeFile(path.join(repo, "README.md"), "review me\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  const briefReview = JSON.parse(await run(["review", "brief", "outcome", "--kind", "commit", "--role", "deep-code-review"], repo, state));
  assert.equal(briefReview.delegation.ownerTaskIdAtBrief, "owner-1");
  assert.equal(briefReview.delegation.claim, "Ship bounded change");
  assert.deepEqual(briefReview.execution, { fork_turns: "none" });
  assert.doesNotMatch(briefReview.prompt, /af-onboard-safe/);
  assert.match(briefReview.prompt, /claim describes the intended outcome; it does not limit review scope/);
  assert.match(briefReview.prompt, /complete changed authority boundary/);
  assert.match(briefReview.prompt, /behavioral state space/);
  assert.match(briefReview.prompt, /Attempt to falsify the candidate; do not defer to the owner's framing, passing tests, implementation effort, or other reviewers/);
  assert.doesNotMatch(briefReview.prompt, /Outstanding findings/);
  assert.match(briefReview.prompt, /A GO with observations is valid/);
  assert.match(briefReview.prompt, /findings as a string array/);
  assert.match(briefReview.prompt, /scoreRationale with one concise string/);
  assert.match(briefReview.prompt, /necessity=necessary\|questionable_roi/);
  assert.match(briefReview.prompt, /simplerPath explaining considered alternatives/);
  assert.match(briefReview.prompt, /No prose or Markdown fences/);
  await run(["review", "bind", "outcome", "--delegation", briefReview.delegation.id, "--task-id", "review-task-1"], repo, state);
  const reviewFile = path.join(root, "review.json");
  const review = { reviewComplete: true, independent: true, delegationId: briefReview.delegation.id, reviewerTaskId: "review-task-1", claim: briefReview.delegation.claim, kind: "commit", role: "deep-code-review", head: briefReview.delegation.head, baseHead: briefReview.delegation.baseHead, tree: briefReview.delegation.tree, provider: "openai", model: "gpt-5.6-sol", verdict: "NO_GO", findings: ["Finding one"], unresolved: ["Question one"], summary: "Reviewed", miniEligible: true, scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 90, evidenceConfidence: 90, outcomeConfidence: 91 }, scoreRationale: { mergeReadiness: "Ready", structuralRisk: "Low", implementationQuality: "Strong", evidenceConfidence: "Direct", outcomeConfidence: "Outcome supported" }, necessity: "necessary", simplerPath: "No simpler reliable path was found.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong" };
  await writeFile(reviewFile, JSON.stringify(review));
  const recordedOutput = await run(["review", "record", "outcome", "--file", reviewFile], repo, state);
  assert.match(recordedOutput, /Assigned finding IDs: F1/);
  const recorded = JSON.parse((await readFile(path.join(state, "reviews", "outcome.jsonl"), "utf8")).trim());
  assert.equal(recorded.reviewerTaskId, "review-task-1");
  assert.equal(recorded.ownerTaskIdAtBrief, "owner-1");
  const status = await run(["review", "status", "outcome", "--kind", "commit"], repo, state);
  assert.match(status, /readiness 90%/);
  assert.match(status, /necessity necessary/);
  assert.match(status, /Simpler path: No simpler reliable path was found/);
  assert.match(status, /Findings: Finding one/);
  assert.match(status, /Unresolved: Question one/);
  assert.match(status, /unreconciled deep-code-review finding F1: Finding one/);

  // Summary edits do not change the delivery claim or stale review evidence.
  await run(["update", "outcome", "--summary", "Status prose changed mid-flight"], repo, state);
  const reconcileBrief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "commit", "--role", "deep-code-review"], repo, state));
  assert.equal(reconcileBrief.delegation.claim, "Ship bounded change");
  assert.deepEqual(reconcileBrief.delegation.outstanding, [{ id: "F1", text: "Finding one" }]);
  assert.match(reconcileBrief.prompt, /Outstanding findings requiring explicit reconciliation/);
  assert.match(reconcileBrief.prompt, /- F1: Finding one/);
  assert.match(reconcileBrief.prompt, /reconciled as an array of \{findingId, disposition, rationale\} objects/);
  // The structural lane stays fresh: no outstanding findings in its brief.
  const freshBrief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "commit", "--role", "structural-challenge"], repo, state));
  assert.equal(freshBrief.delegation.outstanding, undefined);
  assert.doesNotMatch(freshBrief.prompt, /Outstanding findings/);
  await run(["review", "bind", "outcome", "--delegation", reconcileBrief.delegation.id, "--task-id", "review-task-2"], repo, state);
  const reconciling = { ...review, delegationId: reconcileBrief.delegation.id, reviewerTaskId: "review-task-2", head: reconcileBrief.delegation.head, baseHead: reconcileBrief.delegation.baseHead, tree: reconcileBrief.delegation.tree, verdict: "GO", findings: [], unresolved: [], reconciled: [{ findingId: "F9", disposition: "resolved", rationale: "Wrong ID" }] };
  await writeFile(reviewFile, JSON.stringify(reconciling));
  await assert.rejects(run(["review", "record", "outcome", "--file", reviewFile], repo, state), /unknown finding ID: F9/);
  reconciling.reconciled = [{ findingId: "F1", disposition: "resolved", rationale: "Fixed at this target with a regression test." }];
  await writeFile(reviewFile, JSON.stringify(reconciling));
  await run(["review", "record", "outcome", "--file", reviewFile], repo, state);
  const reconciledStatus = await run(["review", "status", "outcome", "--kind", "commit"], repo, state);
  assert.doesNotMatch(reconciledStatus, /unreconciled/);
  assert.match(reconciledStatus, /Reconciled: F1 resolved — Fixed at this target with a regression test/);

  const remote = path.join(root, "remote.git");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
  await exec("git", ["commit", "-m", "candidate"], { cwd: repo });
  await exec("git", ["push", "-u", "origin", "main"], { cwd: repo });
  await exec("git", ["switch", "-c", "feature"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "final candidate\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "final candidate"], { cwd: repo });
  await run(["update", "outcome", "--branch", "feature"], repo, state);
  const fableBrief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "final", "--role", "fable-challenge"], repo, state));
  assert.deepEqual(fableBrief.execution, { provider: "claude-aws" });
  assert.doesNotMatch(fableBrief.prompt, /af-onboard-safe/);
  assert.match(fableBrief.prompt, /claim describes the intended outcome; it does not limit review scope/);
  assert.match(fableBrief.prompt, /complete changed authority boundary/);
  assert.match(fableBrief.prompt, /behavioral state space/);
  assert.match(fableBrief.prompt, /accumulated mechanism/);
  assert.match(fableBrief.prompt, /Attempt to falsify the candidate/);
  assert.equal(fableBrief.delegation.claim, "Ship bounded change");
});
