import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { evaluateGate, outstandingFindings, publicationReasons, validateReview, workstreamPublicationReasons } from "../src/policy.mjs";

const head = "a".repeat(40), baseHead = "b".repeat(40), tree = "c".repeat(40);
const claim = "Ship the stated delivery unit";
const workstream = { claim, claimRevision: 1, ownerTaskId: "owner" };
const target = { head, baseHead, tree };
const delegation = (reviewerFamily, id = randomUUID()) => ({ id, event: "created", type: "review", role: "comprehensive-review", reviewerFamily, route: "cli", kind: "commit", claim, claimRevision: 1, head, baseHead, tree, ownerTaskIdAtBrief: "owner" });
const envelope = (d, reviewerTaskId) => ({ reviewComplete: true, independent: true, delegationId: d.id, reviewerTaskId, claim, kind: "commit", role: "comprehensive-review", reviewerFamily: d.reviewerFamily, head, baseHead, tree, provider: { codex: "openai", cursor: "cursor", claude: "anthropic" }[d.reviewerFamily], model: `${d.reviewerFamily}-current`, route: "cli", verdict: "GO", findings: [], unresolved: [], summary: "Complete adversarial review", scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 88, evidenceConfidence: 92, outcomeConfidence: 91 }, scoreRationale: { mergeReadiness: "Ready", structuralRisk: "Low risk", implementationQuality: "Strong", evidenceConfidence: "Direct evidence", outcomeConfidence: "Outcome supported" }, necessity: "necessary", simplerPath: "No simpler reliable path was found.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong" });
const complete = (d, id) => validateReview(envelope(d, id), d);
const failed = (d, id) => ({ id: d.id, event: "failed", taskId: id, reason: "provider failed" });

test("review contract is comprehensive, family-bound, and model-agnostic", () => {
  const d = delegation("claude");
  const review = envelope(d, "claude-run");
  review.model = "any-claude-model";
  assert.equal(validateReview(review, d).model, "any-claude-model");
  assert.throws(() => validateReview({ ...review, reviewerFamily: "codex" }, d), /exact reviewer family/);
  assert.throws(() => validateReview({ ...review, necessity: "unnecessary" }, d), /necessity must be one of/);
});

test("gate commissions all three families and accepts two completed GOs after all attempts terminate", () => {
  const codex = delegation("codex"), cursor = delegation("cursor"), claude = delegation("claude");
  const delegations = [codex, cursor, claude, failed(claude, "claude-run")];
  const reviews = [complete(codex, "codex-run"), complete(cursor, "cursor-run")];
  assert.equal(evaluateGate({ kind: "commit", target, workstream, reviews, delegations }).ready, true);
});

test("gate does not pass while the third attempt is still running", () => {
  const codex = delegation("codex"), cursor = delegation("cursor"), claude = delegation("claude");
  const gate = evaluateGate({ kind: "commit", target, workstream, reviews: [complete(codex, "codex-run"), complete(cursor, "cursor-run")], delegations: [codex, cursor, claude] });
  assert.equal(gate.ready, false);
  assert.match(gate.reasons.join(" "), /claude review attempt .* is not terminal/);
});

test("one GO plus two failures does not meet the bar", () => {
  const codex = delegation("codex"), cursor = delegation("cursor"), claude = delegation("claude");
  const gate = evaluateGate({ kind: "commit", target, workstream, reviews: [complete(codex, "codex-run")], delegations: [codex, cursor, claude, failed(cursor, "cursor-run"), failed(claude, "claude-run")] });
  assert.equal(gate.ready, false);
  assert.match(gate.reasons.join(" "), /received 1/);
});

test("any completed adverse review blocks even when two other families GO", () => {
  const codex = delegation("codex"), cursor = delegation("cursor"), claude = delegation("claude");
  const adverse = validateReview({ ...envelope(claude, "claude-run"), verdict: "NO_GO", findings: ["Authority boundary is unsound"] }, claude);
  const gate = evaluateGate({ kind: "commit", target, workstream, reviews: [complete(codex, "codex-run"), complete(cursor, "cursor-run"), adverse], delegations: [codex, cursor, claude] });
  assert.equal(gate.ready, false);
  assert.match(gate.reasons.join(" "), /unreconciled comprehensive-review finding F1/);
});

test("a NO_GO must enter the durable finding ledger", () => {
  const claude = delegation("claude");
  assert.throws(() => validateReview({ ...envelope(claude, "claude-run"), verdict: "NO_GO" }, claude), /at least one durable finding or unresolved item/);
});

test("findings remain durable until explicitly reconciled", () => {
  const first = delegation("claude");
  const adverse = validateReview({ ...envelope(first, "claude-run"), verdict: "NO_GO", findings: ["Fix the bug"] }, first);
  assert.deepEqual(outstandingFindings([adverse], claim).map((item) => item.id), ["F1"]);
  const retry = delegation("claude");
  const reconciled = validateReview({ ...envelope(retry, "claude-retry"), reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "Fixed and regression-tested." }] }, retry);
  assert.deepEqual(outstandingFindings([adverse, reconciled], claim), []);
});

test("claim edits do not launder adverse evidence and rejections remain claim-scoped", () => {
  const first = delegation("claude");
  const adverse = validateReview({ ...envelope(first, "claude-run"), verdict: "NO_GO", findings: ["Claim-specific defect"] }, first);
  assert.deepEqual(outstandingFindings([adverse], "Revised claim").map((item) => item.id), ["F1"]);
  const revised = { ...delegation("codex"), claim: "Revised claim" };
  const rejection = validateReview({ ...envelope(revised, "codex-run"), claim: "Revised claim", reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable to the revised claim." }] }, revised);
  assert.deepEqual(outstandingFindings([adverse, rejection], "Revised claim"), []);
  assert.deepEqual(outstandingFindings([adverse, rejection], claim).map((item) => item.id), ["F1"]);
});

test("still_present reopens a previously cleared finding", () => {
  const first = delegation("claude");
  const adverse = validateReview({ ...envelope(first, "claude-run"), verdict: "NO_GO", findings: ["Defect"] }, first);
  const clearedDelegation = delegation("codex");
  const cleared = validateReview({ ...envelope(clearedDelegation, "codex-run"), reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "Fixed." }] }, clearedDelegation);
  const reopenedDelegation = delegation("cursor");
  const reopened = validateReview({ ...envelope(reopenedDelegation, "cursor-run"), reconciled: [{ findingId: "F1", disposition: "still_present", rationale: "Reproduced on the current target." }] }, reopenedDelegation);
  assert.deepEqual(outstandingFindings([adverse, cleared, reopened], claim).map((item) => item.id), ["F1"]);
});

test("publication rejects branch, base, and unsuccessful check mismatches", () => {
  const reasons = publicationReasons({
    project: { baseBranch: "main" }, checkout: { dirty: false },
    pr: { number: 7, state: "OPEN", isDraft: true, headRefOid: head, headRefName: "feature", baseRefName: "develop", statusCheckRollup: [{ conclusion: "CANCELLED", status: "COMPLETED" }] },
    target: { head, branch: "other" }
  });
  assert.match(reasons.join(" "), /configured base/);
  assert.match(reasons.join(" "), /unsuccessful conclusion/);
  assert.match(reasons.join(" "), /reviewed branch/);
});

test("publication blocks open questions and duplicate PR ownership", () => {
  const primary = { id: "primary", project: "sample", questions: [{ id: "Q1", status: "open" }], pullRequests: [7] };
  const reasons = workstreamPublicationReasons({ workstream: primary, workstreams: [primary, { id: "other", project: "sample", questions: [], pullRequests: [7] }], pr: { number: 7 } });
  assert.match(reasons.join(" "), /open workstream questions: Q1/);
  assert.match(reasons.join(" "), /also claimed by workstream other/);
});

test("reviewer task IDs are distinct and the owner cannot review", () => {
  const codex = delegation("codex"), cursor = delegation("cursor"), claude = delegation("claude");
  const delegations = [codex, cursor, claude, failed(claude, "claude-run")];
  const duplicate = evaluateGate({ kind: "commit", target, workstream, reviews: [complete(codex, "same"), complete(cursor, "same")], delegations });
  assert.match(duplicate.reasons.join(" "), /distinct reviewer task IDs/);
  const owner = evaluateGate({ kind: "commit", target, workstream, reviews: [complete(codex, "owner"), complete(cursor, "cursor-run")], delegations });
  assert.match(owner.reasons.join(" "), /owner cannot satisfy/);
});
