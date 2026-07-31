import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { evaluateGate, miniEligibility, publicationReasons, validateReview } from "../src/policy.mjs";

const head = "a".repeat(40), baseHead = "b".repeat(40), tree = "c".repeat(40);
const project = { commitGate: "required", miniReview: { maxFiles: 5, maxChangedLines: 120, riskyPaths: ["migrations/"] } };
const delegation = (role, kind = "commit", id = randomUUID()) => ({ id, role, kind, head, baseHead, ...(kind === "commit" ? { tree } : {}) });
const envelope = (d, reviewerTaskId) => ({ reviewComplete: true, independent: true, delegationId: d.id, reviewerTaskId, kind: d.kind, role: d.role, head, baseHead, ...(d.tree ? { tree } : {}), provider: d.role === "fable-challenge" ? "anthropic" : "openai", model: d.role === "fable-challenge" ? "anthropic.claude-fable-5" : "gpt-5.6-sol", ...(d.role === "fable-challenge" ? { route: "claude-aws" } : { miniEligible: true }), verdict: "GO", findings: [], unresolved: [], summary: "Complete review", scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 88, evidenceConfidence: 92 }, scoreRationale: { mergeReadiness: "Ready", structuralRisk: "Low risk", implementationQuality: "Strong", evidenceConfidence: "Direct evidence" } });

test("commit gate requires distinct exact-target Sol reviewers", () => {
  const deep = delegation("deep-code-review");
  const structural = delegation("structural-challenge");
  const reviews = [validateReview(envelope(deep, "reviewer-a"), deep), validateReview(envelope(structural, "reviewer-b"), structural)];
  assert.equal(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { reviewClass: "full" }, project, reviews }).ready, true);
  reviews[1].reviewerTaskId = "reviewer-a";
  assert.match(evaluateGate({ kind: "commit", target: { head, baseHead, tree }, workstream: { reviewClass: "full" }, project, reviews }).reasons.join(" "), /distinct/);
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
