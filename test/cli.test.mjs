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
  assert.match(briefReview.prompt, /run `af-onboard-safe`/);
  assert.match(briefReview.prompt, /Agent Fixes for session context and issue lineage/);
  assert.match(briefReview.prompt, /retry `af onboard` once with normal escalation/);
  assert.match(briefReview.prompt, /Attempt to falsify the candidate/);
  assert.match(briefReview.prompt, /more code is not evidence of necessity or quality/);
  assert.match(briefReview.prompt, /findings as a string array/);
  assert.match(briefReview.prompt, /scoreRationale as an object/);
  assert.match(briefReview.prompt, /necessity=necessary\|questionable_roi/);
  assert.match(briefReview.prompt, /simplerPath as a concise explanation/);
  assert.match(briefReview.prompt, /No prose or Markdown fences/);
  await run(["review", "bind", "outcome", "--delegation", briefReview.delegation.id, "--task-id", "review-task-1"], repo, state);
  const reviewFile = path.join(root, "review.json");
  const review = { reviewComplete: true, independent: true, delegationId: briefReview.delegation.id, reviewerTaskId: "review-task-1", kind: "commit", role: "deep-code-review", head: briefReview.delegation.head, baseHead: briefReview.delegation.baseHead, tree: briefReview.delegation.tree, provider: "openai", model: "gpt-5.6-sol", verdict: "NO_GO", findings: ["Finding one"], unresolved: ["Question one"], summary: "Reviewed", miniEligible: true, scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 90, evidenceConfidence: 90, outcomeConfidence: 91 }, scoreRationale: { mergeReadiness: "Ready", structuralRisk: "Low", implementationQuality: "Strong", evidenceConfidence: "Direct", outcomeConfidence: "Outcome supported" }, necessity: "necessary", simplerPath: "No simpler reliable path was found.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong" };
  await writeFile(reviewFile, JSON.stringify(review));
  await run(["review", "record", "outcome", "--file", reviewFile], repo, state);
  const recorded = JSON.parse((await readFile(path.join(state, "reviews", "outcome.jsonl"), "utf8")).trim());
  assert.equal(recorded.reviewerTaskId, "review-task-1");
  assert.equal(recorded.ownerTaskIdAtBrief, "owner-1");
  const status = await run(["review", "status", "outcome", "--kind", "commit"], repo, state);
  assert.match(status, /readiness 90%/);
  assert.match(status, /necessity necessary/);
  assert.match(status, /Simpler path: No simpler reliable path was found/);
  assert.match(status, /Findings: Finding one/);
  assert.match(status, /Unresolved: Question one/);

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
  assert.doesNotMatch(fableBrief.prompt, /af-onboard-safe/);
});
