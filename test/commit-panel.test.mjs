import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCommitPanel } from "../src/commit-panel.mjs";

const tree = "abcdef1234567890abcdef1234567890abcdef12";
const baseHead = "1234567890abcdef1234567890abcdef12345678";
const reviewerIds = {
  deep: "019f0000-0000-7000-8000-000000000010",
  structural: "019f0000-0000-7000-8000-000000000011",
  same: "019f0000-0000-7000-8000-000000000012"
};
function review(role, reviewerId) {
  return { type: "commit_review", metadata: { tree, baseHead, reviewRole: role, reviewerId: reviewerIds[reviewerId] || reviewerId, reviewerIdentityVerified: true, orchestratorAtReview: "implementer", provider: "openai", model: "gpt-5.6-sol", verdict: "GO", reviewComplete: true } };
}

test("commit panel requires two distinct local reviewers for the staged tree", () => {
  const ready = evaluateCommitPanel({ tree, baseHead, events: [review("deep-code-review", "deep"), review("structural-challenge", "structural")], orchestrator: "owner" });
  assert.equal(ready.ready, true);
  const duplicate = evaluateCommitPanel({ tree, baseHead, events: [review("deep-code-review", "same"), review("structural-challenge", "same")], orchestrator: "owner" });
  assert.equal(duplicate.ready, false);
  assert.match(duplicate.reasons.join(" "), /distinct reviewers/);
});

test("commit panel is invalidated by any staged-tree change", () => {
  const result = evaluateCommitPanel({ tree: "fedcba0987654321fedcba0987654321fedcba09", baseHead, events: [review("deep-code-review", "deep"), review("structural-challenge", "structural")] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /missing local deep-code-review/);
});

test("commit panel is invalidated by a base-head change", () => {
  const result = evaluateCommitPanel({ tree, baseHead: "fedcba0987654321fedcba0987654321fedcba09", events: [review("deep-code-review", "deep"), review("structural-challenge", "structural")] });
  assert.equal(result.ready, false);
});

test("commit panel rejects a non-Sol reviewer", () => {
  const structural = review("structural-challenge", "structural");
  structural.metadata.model = "gpt-5.6-terra";
  const result = evaluateCommitPanel({ tree, baseHead, events: [review("deep-code-review", "deep"), structural] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /must come from a Sol agent/);
});

test("commit panel rejects a fabricated Sol-like model name", () => {
  const structural = review("structural-challenge", "structural");
  structural.metadata.model = "gpt-fake-sol";
  const result = evaluateCommitPanel({ tree, baseHead, events: [review("deep-code-review", "deep"), structural] });
  assert.equal(result.ready, false);
});
