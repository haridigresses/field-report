import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMrr } from "../src/mrr.mjs";

const head = "abcdef1234567890abcdef1234567890abcdef12";

function pass(model, verdict = "GO", unresolved = [], reasoning = null, reviewRole = null, reviewScope = "full", baseHead = null) {
  return {
    at: "2026-07-12T18:00:00.000Z",
    actor: model,
    metadata: { head, model, reviewer: model, verdict, unresolved, reasoning, reviewRole, reviewScope, baseHead, reviewComplete: true, independent: true }
  };
}

test("MRR requires both exact-head review lanes", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "GO", [], "high")] });
  assert.equal(result.ready, false);
  assert.equal(result.lanes.deepCode.verdict, "GO");
  assert.equal(result.lanes.structuralChallenge, null);
  assert.match(result.reasons.join(" "), /structural-challenge/);
});

test("MRR accepts completed Codex sol and Fable passes", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "GO", [], "high"), pass("anthropic.claude-fable-5")] });
  assert.equal(result.ready, true);
  assert.equal(result.reasons.length, 0);
});

test("MRR remains blocked by current-head NO-GO or unresolved findings", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "NO_GO", [], "high"), pass("anthropic.claude-fable-5", "GO", ["contract gap"])] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /NO-GO/);
  assert.match(result.reasons.join(" "), /unresolved/);
});

test("latest completed pass supersedes an earlier same-lane verdict", () => {
  const earlier = pass("anthropic.claude-fable-5", "NO_GO");
  earlier.at = "2026-07-12T17:00:00.000Z";
  const later = pass("anthropic.claude-fable-5", "GO");
  later.at = "2026-07-12T18:00:00.000Z";
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "GO", [], "high"), earlier, later] });
  assert.equal(result.ready, true);
});

test("explicit reviewer roles avoid coupling policy to model vendors", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [
    pass("future-model-a", "GO", [], null, "deep-code-review"),
    pass("future-model-b", "GO", [], null, "structural-challenge")
  ] });
  assert.equal(result.ready, true);
});

test("single-independent policy requires a reason and one accepted pass", () => {
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "single-independent", reason: "Low-risk docs-adjacent change" }, assessment: { currentHead: head }, reviewPasses: [pass("independent-reviewer")] });
  assert.equal(result.ready, true);
  assert.equal(result.policy.mode, "single-independent");
});

test("delta policy requires an exact-base delta pass", () => {
  const baseHead = "1234567890abcdef1234567890abcdef12345678";
  const missing = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "delta", reason: "Only a bounded fix changed" }, assessment: { currentHead: head }, reviewPasses: [pass("independent-reviewer")] });
  assert.equal(missing.ready, false);
  const ready = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "delta", reason: "Only a bounded fix changed" }, assessment: { currentHead: head }, reviewPasses: [pass("independent-reviewer", "GO", [], null, null, "delta", baseHead)] });
  assert.equal(ready.ready, true);
});

test("none policy records the explicit exception and skips review passes", () => {
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none", reason: "Generated metadata-only branch" }, assessment: { currentHead: head }, reviewPasses: [] });
  assert.equal(result.ready, true);
});

test("non-full policy without a reason cannot bypass the gate", () => {
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none" }, assessment: { currentHead: head }, reviewPasses: [] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /explicit reason/);
});
