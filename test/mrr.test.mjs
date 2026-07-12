import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMrr } from "../src/mrr.mjs";

const head = "abcdef1234567890abcdef1234567890abcdef12";

function pass(model, verdict = "GO", unresolved = [], reasoning = null) {
  return {
    at: "2026-07-12T18:00:00.000Z",
    actor: model,
    metadata: { head, model, reviewer: model, verdict, unresolved, reasoning, reviewComplete: true, independent: true }
  };
}

test("MRR requires both exact-head review lanes", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "GO", [], "high")] });
  assert.equal(result.ready, false);
  assert.equal(result.lanes.codexSol.verdict, "GO");
  assert.equal(result.lanes.fable, null);
  assert.match(result.reasons.join(" "), /Fable review/);
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
