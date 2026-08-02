import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { evaluateGate, miniEligibility, publicationReasons, validateReview, workstreamPublicationReasons } from "../src/policy.mjs";

const head = "a".repeat(40), baseHead = "b".repeat(40), tree = "c".repeat(40);
const project = { commitGate: "required", miniReview: { maxFiles: 5, maxChangedLines: 120, riskyPaths: ["migrations/"] } };
const delegation = (role, kind = "commit", id = randomUUID()) => ({ id, role, kind, head, baseHead, ...(kind === "commit" ? { tree } : {}) });
const envelope = (d, reviewerTaskId) => ({ reviewComplete: true, independent: true, delegationId: d.id, reviewerTaskId, kind: d.kind, role: d.role, head, baseHead, ...(d.tree ? { tree } : {}), provider: d.role === "fable-challenge" ? "anthropic" : "openai", model: d.role === "fable-challenge" ? "anthropic.claude-fable-5" : "gpt-5.6-sol", ...(d.role === "fable-challenge" ? { route: "claude-aws" } : { miniEligible: true }), verdict: "GO", findings: [], unresolved: [], summary: "Complete review", scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 88, evidenceConfidence: 92, outcomeConfidence: 91 }, scoreRationale: { mergeReadiness: "Ready", structuralRisk: "Low risk", implementationQuality: "Strong", evidenceConfidence: "Direct evidence", outcomeConfidence: "Outcome is well supported" }, necessity: "necessary", simplerPath: "No simpler reliable path was found.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong" });

test("review requires the complete numeric and qualitative evidence contract", () => {
  const deep = delegation("deep-code-review");
  const missing = envelope(deep, "reviewer-a");
  delete missing.necessity;
  assert.throws(() => validateReview(missing, deep), /necessity must be one of/);
  const invalid = envelope(deep, "reviewer-a");
  invalid.necessity = "unnecessary";
  assert.throws(() => validateReview(invalid, deep), /necessity must be one of/);
});

test("commit gate requires distinct exact-target Sol reviewers", () => {
  const deep = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const reviews = [validateReview(envelope(deep, "reviewer-a"), deep), validateReview(envelope(structural, "reviewer-b"), structural)];
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { reviewClass: "full" }, project, reviews }).ready, true);
  reviews[1].reviewerTaskId = "reviewer-a";
  assert.match(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { reviewClass: "full" }, project, reviews }).reasons.join(" "), /distinct/);
});

test("commit gate rejects persisted evidence with an out-of-range score", () => {
  const deep = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const reviews = [validateReview(envelope(deep, "reviewer-a"), deep), validateReview(envelope(structural, "reviewer-b"), structural)];
  reviews[0].scores.mergeReadiness = 101;
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { reviewClass: "full" }, project, reviews }).ready, false);
});

test("a different reviewer cannot erase adverse evidence on the same exact target", () => {
  const first = delegation("deep-code-review");
  const replacement = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const adverse = { ...envelope(first, "reviewer-a"), verdict: "NO_GO", findings: ["Fix the bug"] };
  const reviews = [validateReview(adverse, first), validateReview(envelope(replacement, "reviewer-c"), replacement), validateReview(envelope(structural, "reviewer-b"), structural)];
  assert.match(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { reviewClass: "full" }, project, reviews }).reasons.join(" "), /reviewer-a has unreconciled adverse evidence/);
  reviews.push(validateReview(envelope(first, "reviewer-a"), first));
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { reviewClass: "full" }, project, reviews }).ready, true);
});

test("owner identity at review time remains disqualifying after reassignment", () => {
  const deep = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const reviews = [
    { ...validateReview(envelope(deep, "original-owner"), deep), ownerTaskIdAtBrief: "original-owner" },
    { ...validateReview(envelope(structural, "reviewer-b"), structural), ownerTaskIdAtBrief: "original-owner" }
  ];
  assert.match(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { reviewClass: "full", ownerTaskId: "new-owner" }, project, reviews }).reasons.join(" "), /owner when its review brief was created/);
});

test("full final gate requires exact Fable route", () => {
  const roles = [delegation("deep-code-review", "final"), delegation("structural-challenge", "final"), delegation("fable-challenge", "final")];
  const reviews = roles.map((item, index) => validateReview(envelope(item, `reviewer-${index}`), item));
  assert.equal(evaluateGate({ kind: "final", target: { head, baseHead }, workstream: { reviewClass: "full" }, project, reviews }).ready, true);
  reviews.pop();
  assert.match(evaluateGate({ kind: "final", target: { head, baseHead }, workstream: { reviewClass: "full" }, project, reviews }).reasons.join(" "), /Fable/);
});

test("mini waives only Fable after deterministic and reviewer agreement", () => {
  const roles = [delegation("deep-code-review", "final"), delegation("structural-challenge", "final")];
  const reviews = roles.map((item, index) => validateReview(envelope(item, `reviewer-${index}`), item));
  const workstream = { reviewClass: "mini", miniClassification: { eligible: true, head, baseHead } };
  assert.equal(evaluateGate({ kind: "final", target: { head, baseHead }, workstream, project, reviews }).ready, true);
  assert.equal(evaluateGate({ kind: "final", target: { head, baseHead: "d".repeat(40) }, workstream, project, reviews }).ready, false);
  reviews[0].miniEligible = false;
  assert.equal(evaluateGate({ kind: "final", target: { head, baseHead }, workstream, project, reviews }).ready, false);
});

test("mini classifier combines size and risky paths", () => {
  assert.equal(miniEligibility({ files: ["src/view.js"], additions: 10, deletions: 2, project }).eligible, true);
  assert.equal(miniEligibility({ files: ["migrations/001.sql"], additions: 1, deletions: 0, project }).eligible, false);
});

test("publication rejects wrong base and every non-success check conclusion", () => {
  const reasons = publicationReasons({
    project: { baseBranch: "main" }, checkout: { dirty: false },
    pr: { number: 7, state: "OPEN", isDraft: true, headRefOid: head, headRefName: "codex/change", baseRefName: "develop", statusCheckRollup: [{ conclusion: "CANCELLED", status: "COMPLETED" }] },
    target: { head, branch: "codex/other" }
  });
  assert.match(reasons.join(" "), /configured base/);
  assert.match(reasons.join(" "), /unsuccessful conclusion/);
  assert.match(reasons.join(" "), /reviewed branch/);
});

test("publication blocks open questions and duplicate PR ownership", () => {
  const workstream = { id: "primary", project: "sample", questions: [{ id: "Q1", status: "open" }], pullRequests: [7] };
  const reasons = workstreamPublicationReasons({ workstream, workstreams: [workstream, { id: "other", project: "sample", questions: [], pullRequests: [7] }], pr: { number: 7 } });
  assert.match(reasons.join(" "), /open workstream questions: Q1/);
  assert.match(reasons.join(" "), /also claimed by workstream other/);
});
