import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { evaluateGate, miniEligibility, outstandingFindings, publicationReasons, validateReview, workstreamPublicationReasons } from "../src/policy.mjs";

const head = "a".repeat(40), baseHead = "b".repeat(40), tree = "c".repeat(40);
const project = { commitGate: "required", miniReview: { maxFiles: 5, maxChangedLines: 120, riskyPaths: ["migrations/"] } };
const claim = "Ship the stated delivery unit";
const fullWorkstream = { reviewClass: "full", claim, summary: "Ordinary status prose that differs from the claim" };
const delegation = (role, kind = "commit", id = randomUUID()) => ({ id, role, kind, claim, head, baseHead, ...(kind === "commit" ? { tree } : {}) });
const envelope = (d, reviewerTaskId) => ({ reviewComplete: true, independent: true, delegationId: d.id, reviewerTaskId, claim: d.claim, kind: d.kind, role: d.role, head, baseHead, ...(d.tree ? { tree } : {}), provider: d.role === "fable-challenge" ? "anthropic" : "openai", model: d.role === "fable-challenge" ? "anthropic.claude-fable-5" : "gpt-5.6-sol", ...(d.role === "fable-challenge" ? { route: "claude-aws" } : { miniEligible: true }), verdict: "GO", findings: [], unresolved: [], summary: "Complete review", scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 88, evidenceConfidence: 92, outcomeConfidence: 91 }, scoreRationale: { mergeReadiness: "Ready", structuralRisk: "Low risk", implementationQuality: "Strong", evidenceConfidence: "Direct evidence", outcomeConfidence: "Outcome is well supported" }, necessity: "necessary", simplerPath: "No simpler reliable path was found.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong" });

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
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: fullWorkstream, project, reviews }).ready, true);
  reviews[1].reviewerTaskId = "reviewer-a";
  assert.match(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: fullWorkstream, project, reviews }).reasons.join(" "), /distinct/);
});

test("commit gate rejects persisted evidence with an out-of-range score", () => {
  const deep = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const reviews = [validateReview(envelope(deep, "reviewer-a"), deep), validateReview(envelope(structural, "reviewer-b"), structural)];
  reviews[0].scores.mergeReadiness = 101;
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: fullWorkstream, project, reviews }).ready, false);
});

test("a later GO by a different reviewer does not silently clear a recorded finding", () => {
  const first = delegation("deep-code-review");
  const replacement = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const adverse = { ...envelope(first, "reviewer-a"), verdict: "NO_GO", findings: ["Fix the bug"] };
  const reviews = [validateReview(adverse, first), validateReview(envelope(replacement, "reviewer-c"), replacement), validateReview(envelope(structural, "reviewer-b"), structural)];
  const blocked = evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: fullWorkstream, project, reviews });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join(" "), /unreconciled deep-code-review finding F1: Fix the bug/);
});

test("an explicit evidence-based reconciliation clears an outstanding finding", () => {
  const first = delegation("deep-code-review");
  const replacement = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const adverse = { ...envelope(first, "reviewer-a"), verdict: "NO_GO", findings: ["Fix the bug"] };
  const reconciling = { ...envelope(replacement, "reviewer-c"), reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "The bug is fixed at this target and covered by a regression test." }] };
  const reviews = [validateReview(adverse, first), validateReview(reconciling, replacement), validateReview(envelope(structural, "reviewer-b"), structural)];
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: fullWorkstream, project, reviews }).ready, true);
});

test("a finding survives candidate evolution", () => {
  const oldTree = "e".repeat(40);
  const oldTarget = delegation("deep-code-review");
  oldTarget.tree = oldTree;
  const adverse = { ...envelope(oldTarget, "reviewer-a"), tree: oldTree, verdict: "NO_GO", findings: ["Fix the bug"] };
  const deep = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const reviews = [validateReview(adverse, oldTarget), validateReview(envelope(deep, "reviewer-c"), deep), validateReview(envelope(structural, "reviewer-b"), structural)];
  const blocked = evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: fullWorkstream, project, reviews });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join(" "), /unreconciled deep-code-review finding F1/);
  assert.deepEqual(outstandingFindings(reviews, claim).map((finding) => finding.id), ["F1"]);
});

test("changing the delivery claim does not launder outstanding adverse evidence", () => {
  const first = delegation("deep-code-review");
  const adverse = { ...envelope(first, "reviewer-a"), verdict: "NO_GO", findings: ["Fix the bug"] };
  const reviews = [validateReview(adverse, first)];
  const blocked = evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { ...fullWorkstream, claim: "A revised claim" }, project, reviews });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join(" "), /unreconciled deep-code-review finding F1: Fix the bug/);
});

test("unresolved questions are durable adverse evidence", () => {
  const first = delegation("deep-code-review");
  const replacement = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const adverse = { ...envelope(first, "reviewer-a"), verdict: "NO_GO", unresolved: ["Is the migration reversible?"] };
  const reviews = [validateReview(adverse, first), validateReview(envelope(replacement, "reviewer-c"), replacement), validateReview(envelope(structural, "reviewer-b"), structural)];
  const blocked = evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: fullWorkstream, project, reviews });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join(" "), /unreconciled deep-code-review unresolved F1: Is the migration reversible\?/);
});

test("a rejection is scoped to the claim against which applicability was judged", () => {
  const original = delegation("deep-code-review");
  const adverse = { ...envelope(original, "reviewer-a"), verdict: "NO_GO", findings: ["Claim-specific defect"] };
  const revisedClaim = "A revised delivery claim";
  const rejectionDelegation = { ...delegation("deep-code-review"), claim: revisedClaim };
  const rejection = { ...envelope(rejectionDelegation, "reviewer-b"), claim: revisedClaim, reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "This defect is inapplicable to the revised claim." }] };
  const reviews = [validateReview(adverse, original), validateReview(rejection, rejectionDelegation)];
  assert.deepEqual(outstandingFindings(reviews, revisedClaim), []);
  assert.deepEqual(outstandingFindings(reviews, claim).map((finding) => finding.id), ["F1"]);
});

test("a later still-present disposition reopens previously cleared evidence", () => {
  const original = delegation("deep-code-review");
  const adverse = { ...envelope(original, "reviewer-a"), verdict: "NO_GO", findings: ["Claim-specific defect"] };
  const rejectedDelegation = delegation("deep-code-review");
  const rejected = { ...envelope(rejectedDelegation, "reviewer-b"), reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Not applicable at this target." }] };
  const confirmedDelegation = delegation("deep-code-review");
  const confirmed = { ...envelope(confirmedDelegation, "reviewer-c"), reconciled: [{ findingId: "F1", disposition: "still_present", rationale: "The defect remains reproducible." }] };
  const reviews = [validateReview(adverse, original), validateReview(rejected, rejectedDelegation), validateReview(confirmed, confirmedDelegation)];
  assert.deepEqual(outstandingFindings(reviews, claim).map((finding) => finding.id), ["F1"]);
});

test("claim-scoped rejections do not erase other claim clearances", () => {
  const original = delegation("deep-code-review");
  const adverse = { ...envelope(original, "reviewer-a"), verdict: "NO_GO", findings: ["Claim-specific defect"] };
  const claimA = "Claim A";
  const claimB = "Claim B";
  const rejectionADelegation = { ...delegation("deep-code-review"), claim: claimA };
  const rejectionBDelegation = { ...delegation("deep-code-review"), claim: claimB };
  const rejectionA = { ...envelope(rejectionADelegation, "reviewer-b"), claim: claimA, reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable to A." }] };
  const rejectionB = { ...envelope(rejectionBDelegation, "reviewer-c"), claim: claimB, reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable to B." }] };
  const reviews = [validateReview(adverse, original), validateReview(rejectionA, rejectionADelegation), validateReview(rejectionB, rejectionBDelegation)];
  assert.deepEqual(outstandingFindings(reviews, claimA), []);
  assert.deepEqual(outstandingFindings(reviews, claimB), []);
  assert.deepEqual(outstandingFindings(reviews, claim).map((finding) => finding.id), ["F1"]);
});

test("reconciled entries require findingId, disposition, and rationale", () => {
  const deep = delegation("deep-code-review");
  const invalid = { ...envelope(deep, "reviewer-a"), reconciled: [{ findingId: "F1", disposition: "waived", rationale: "Trust me" }] };
  assert.throws(() => validateReview(invalid, deep), /disposition resolved\|rejected\|still_present/);
  const duplicate = { ...envelope(deep, "reviewer-a"), reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "Fixed" }, { findingId: "F1", disposition: "rejected", rationale: "Also this" }] };
  assert.throws(() => validateReview(duplicate, deep), /distinct finding IDs/);
});

test("findings and unresolved entries must be nonblank", () => {
  const deep = delegation("deep-code-review");
  assert.throws(() => validateReview({ ...envelope(deep, "reviewer-a"), findings: ["   "] }, deep), /nonblank string array/);
  assert.throws(() => validateReview({ ...envelope(deep, "reviewer-a"), unresolved: [""] }, deep), /nonblank string array/);
});

test("changing the delivery claim makes exact-target reviews stale, but summary edits do not", () => {
  const deep = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const reviews = [validateReview(envelope(deep, "reviewer-a"), deep), validateReview(envelope(structural, "reviewer-b"), structural)];
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { ...fullWorkstream, claim: "A different claim" }, project, reviews }).ready, false);
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { ...fullWorkstream, summary: "Another status edit" }, project, reviews }).ready, true);
});

test("a claim text round trip does not reactivate old review evidence", () => {
  const deep = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const reviews = [validateReview(envelope(deep, "reviewer-a"), deep), validateReview(envelope(structural, "reviewer-b"), structural)].map((review) => ({ ...review, claimRevision: 1 }));
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { ...fullWorkstream, claimRevision: 1 }, project, reviews }).ready, true);
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { ...fullWorkstream, claimRevision: 3 }, project, reviews }).ready, false);
});

test("owner identity at review time remains disqualifying after reassignment", () => {
  const deep = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const reviews = [
    { ...validateReview(envelope(deep, "original-owner"), deep), ownerTaskIdAtBrief: "original-owner" },
    { ...validateReview(envelope(structural, "reviewer-b"), structural), ownerTaskIdAtBrief: "original-owner" }
  ];
  assert.match(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { ...fullWorkstream, ownerTaskId: "new-owner" }, project, reviews }).reasons.join(" "), /owner when its review brief was created/);
});

test("full final gate requires exact Fable route", () => {
  const roles = [delegation("deep-code-review", "final"), delegation("structural-challenge", "final"), delegation("fable-challenge", "final")];
  const reviews = roles.map((item, index) => validateReview(envelope(item, `reviewer-${index}`), item));
  assert.equal(evaluateGate({ kind: "final", target: { head, baseHead }, workstream: fullWorkstream, project, reviews }).ready, true);
  reviews.pop();
  assert.match(evaluateGate({ kind: "final", target: { head, baseHead }, workstream: fullWorkstream, project, reviews }).reasons.join(" "), /Fable/);
});

test("mini waives only Fable after deterministic and reviewer agreement", () => {
  const roles = [delegation("deep-code-review", "final"), delegation("structural-challenge", "final")];
  const reviews = roles.map((item, index) => validateReview(envelope(item, `reviewer-${index}`), item));
  const workstream = { reviewClass: "mini", claim, summary: claim, miniClassification: { eligible: true, head, baseHead } };
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
