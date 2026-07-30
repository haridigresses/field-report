import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMrr } from "../src/mrr.mjs";

const head = "abcdef1234567890abcdef1234567890abcdef12";
const ids = {
  solDeep: "019f0000-0000-7000-8000-000000000101",
  solStructural: "019f0000-0000-7000-8000-000000000102",
  fable: "019f0000-0000-7000-8000-000000000103",
  owner: "019f0000-0000-7000-8000-000000000104",
  dissent: "019f0000-0000-7000-8000-000000000105",
  conditional: "019f0000-0000-7000-8000-000000000106",
  independent: "019f0000-0000-7000-8000-000000000107"
};

function pass(model, verdict = "GO", unresolved = [], reasoning = null, reviewRole = null, reviewScope = "full", baseHead = null) {
  return {
    at: "2026-07-12T18:00:00.000Z",
    actor: model,
    metadata: { head, model, reviewer: model, verdict, unresolved, reasoning, reviewRole, reviewScope, baseHead, reviewComplete: true, independent: true, orchestratorAtReview: null }
  };
}

function solPass(reviewerId, reviewRole) {
  const result = pass("gpt-5.6-sol", "GO", [], "high", reviewRole);
  Object.assign(result.metadata, { reviewerId, reviewerIdentityVerified: true, provider: "openai" });
  return result;
}

function fablePass(reviewerId = ids.fable) {
  const result = pass("anthropic.claude-fable-5", "GO", [], null, "structural-challenge");
  Object.assign(result.metadata, { reviewerId, provider: "anthropic", route: "claude-aws", provenanceVerified: true, evidenceDigest: "a".repeat(64) });
  return result;
}

function fullFleet(...extra) {
  return [solPass(ids.solDeep, "deep-code-review"), solPass(ids.solStructural, "structural-challenge"), fablePass(), ...extra];
}

test("MRR requires both exact-head review lanes", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "GO", [], "high")] });
  assert.equal(result.ready, false);
  assert.equal(result.lanes.deepCode.verdict, "GO");
  assert.equal(result.lanes.structuralChallenge, null);
  assert.match(result.reasons.join(" "), /structural-challenge/);
});

test("global full MRR rejects role-complete reviews without the verified fleet", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "GO", [], "high"), pass("anthropic.claude-fable-5")] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /2 distinct Sol reviewers/);
  assert.match(result.reasons.join(" "), /Fable review through claude-aws/);
});

test("global full MRR accepts the verified Sol and Fable fleet without repository configuration", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: fullFleet() });
  assert.equal(result.ready, true);
  assert.equal(result.reasons.length, 0);
  assert.deepEqual(result.fleet, { accepted: 3, solReviewers: 2, fableViaClaudeAws: true });
});

test("full-policy configuration cannot weaken or corrupt the global fleet floor", () => {
  const roleComplete = [pass("gpt-5.6-sol", "GO", [], "high", "deep-code-review"), pass("future-model", "GO", [], null, "structural-challenge")];
  const weakened = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", requireReviewerIds: false, minSolReviewers: 0, requireFableViaClaudeAws: false }, assessment: { currentHead: head }, reviewPasses: roleComplete });
  assert.equal(weakened.ready, false);
  assert.deepEqual({ requireReviewerIds: weakened.policy.requireReviewerIds, minSolReviewers: weakened.policy.minSolReviewers, requireFableViaClaudeAws: weakened.policy.requireFableViaClaudeAws }, { requireReviewerIds: true, minSolReviewers: 2, requireFableViaClaudeAws: true });
  const malformed = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", minSolReviewers: "not-a-number" }, assessment: { currentHead: head }, reviewPasses: roleComplete });
  assert.equal(malformed.ready, false);
  assert.equal(malformed.policy.minSolReviewers, 2);
  assert.match(malformed.reasons.join(" "), /2 distinct Sol reviewers/);
  assert.match(malformed.reasons.join(" "), /Fable review through claude-aws/);
});

test("MRR remains blocked by current-head NO-GO or unresolved findings", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "NO_GO", [], "high"), pass("anthropic.claude-fable-5", "GO", ["contract gap"])] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /not GO/);
  assert.match(result.reasons.join(" "), /unresolved/);
});

test("latest completed pass supersedes an earlier same-lane verdict", () => {
  const earlier = fablePass();
  earlier.metadata.verdict = "NO_GO";
  earlier.at = "2026-07-12T17:00:00.000Z";
  const later = fablePass();
  later.at = "2026-07-12T18:00:00.000Z";
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [...fullFleet().slice(0, 2), earlier, later] });
  assert.equal(result.ready, true);
});

test("explicit reviewer roles cannot bypass the global model-provenance fleet", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [
    pass("future-model-a", "GO", [], null, "deep-code-review"),
    pass("future-model-b", "GO", [], null, "structural-challenge")
  ] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /2 distinct Sol reviewers/);
  assert.match(result.reasons.join(" "), /Fable review through claude-aws/);
});

test("single-independent policy requires a reason and one accepted pass", () => {
  const review = pass("independent-reviewer");
  review.metadata.reviewerId = ids.independent;
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "single-independent", reason: "Low-risk docs-adjacent change", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [review] });
  assert.equal(result.ready, true);
  assert.equal(result.policy.mode, "single-independent");
});

test("delta policy requires an exact-base delta pass", () => {
  const baseHead = "1234567890abcdef1234567890abcdef12345678";
  const missing = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "delta", reason: "Only a bounded fix changed", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [pass("independent-reviewer")] });
  assert.equal(missing.ready, false);
  const delta = pass("independent-reviewer", "GO", [], null, null, "delta", baseHead);
  delta.metadata.reviewerId = ids.independent;
  const ready = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "delta", reason: "Only a bounded fix changed", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [delta] });
  assert.equal(ready.ready, true);
});

test("none policy records the explicit exception and skips review passes", () => {
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none", reason: "Generated metadata-only branch", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [] });
  assert.equal(result.ready, true);
});

test("non-full policy without a reason cannot bypass the gate", () => {
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /explicit reason/);
});

test("a reason without durable user authorization cannot weaken full MRR", () => {
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none", reason: "repository-configured shortcut" }, assessment: { currentHead: head }, reviewPasses: [] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /durable user authorization/);
});

test("CONDITIONAL_GO does not satisfy readiness", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "CONDITIONAL_GO", [], "high"), pass("anthropic.claude-fable-5")] });
  assert.equal(result.ready, false);
});

test("configured review provenance requires distinct reviewer IDs and providers", () => {
  const deep = solPass(ids.solDeep, "deep-code-review");
  const structural = solPass(ids.solStructural, "structural-challenge");
  const fable = fablePass(ids.fable);
  const ready = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", minProviderFamilies: 2 }, assessment: { currentHead: head }, reviewPasses: [deep, structural, fable] });
  assert.equal(ready.ready, true);
  structural.metadata.reviewerId = ids.solDeep;
  const duplicate = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", minProviderFamilies: 2 }, assessment: { currentHead: head }, reviewPasses: [deep, structural, fable] });
  assert.equal(duplicate.ready, false);
  assert.match(duplicate.reasons.join(" "), /2 distinct Sol reviewers/);
});

test("provider diversity rejects arbitrary labels and remains satisfiable for reduced policies", () => {
  const deep = pass("future-model-a", "GO", [], null, "deep-code-review");
  const structural = pass("future-model-b", "GO", [], null, "structural-challenge");
  deep.metadata.provider = "vendor-a";
  structural.metadata.provider = "vendor-b";
  deep.metadata.reviewerId = "deep";
  structural.metadata.reviewerId = "structural";
  const forged = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", minProviderFamilies: 2 }, assessment: { currentHead: head }, reviewPasses: [deep, structural] });
  assert.equal(forged.ready, false);
  const one = solPass(ids.independent, "deep-code-review");
  const reduced = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "single-independent", reason: "bounded exception", userAuthorized: true, minProviderFamilies: 2, requireReviewerIds: true }, assessment: { currentHead: head }, reviewPasses: [one] });
  assert.equal(reduced.ready, true);
  const none = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none", reason: "retrospective", userAuthorized: true, minProviderFamilies: 2, requireReviewerIds: true }, assessment: { currentHead: head }, reviewPasses: [] });
  assert.equal(none.ready, true);
});

test("full MRR fleet requires multiple Sol reviewers and Fable through claude-aws", () => {
  const deep = solPass(ids.solDeep, "deep-code-review");
  const secondSol = solPass(ids.solStructural, "structural-challenge");
  const fable = pass("anthropic.claude-fable-5", "GO", [], null, "structural-challenge");
  fable.metadata.reviewerId = ids.fable;
  fable.metadata.provider = "anthropic";
  fable.metadata.route = "claude-aws";
  fable.metadata.provenanceVerified = true;
  fable.metadata.evidenceDigest = "a".repeat(64);
  const policy = { mode: "full", requireReviewerIds: true, minSolReviewers: 2, requireFableViaClaudeAws: true };
  const ready = evaluateMrr({ branch: "codex/sample", reviewPolicy: policy, assessment: { currentHead: head }, reviewPasses: [deep, secondSol, fable] });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.fleet, { accepted: 3, solReviewers: 2, fableViaClaudeAws: true });
  const wrongRoute = structuredClone(fable);
  wrongRoute.metadata.route = "claude-direct";
  const blocked = evaluateMrr({ branch: "codex/sample", reviewPolicy: policy, assessment: { currentHead: head }, reviewPasses: [deep, secondSol, wrongRoute] });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join(" "), /Fable review through claude-aws/);
});

test("full MRR fleet does not accept another Anthropic model as Fable", () => {
  const deep = solPass(ids.solDeep, "deep-code-review");
  const secondSol = solPass(ids.solStructural, "structural-challenge");
  const opus = pass("anthropic.claude-opus-4", "GO", [], null, "structural-challenge");
  opus.metadata.reviewerId = ids.fable;
  opus.metadata.provider = "anthropic";
  opus.metadata.route = "claude-aws";
  opus.metadata.provenanceVerified = true;
  opus.metadata.evidenceDigest = "b".repeat(64);
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", requireReviewerIds: true, minSolReviewers: 2, requireFableViaClaudeAws: true }, assessment: { currentHead: head }, reviewPasses: [deep, secondSol, opus] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /Fable review through claude-aws/);
});

test("full MRR rejects spoofed Sol providers and invented reviewer labels", () => {
  const wrongProviderDeep = solPass(ids.solDeep, "deep-code-review");
  const wrongProviderStructural = solPass(ids.solStructural, "structural-challenge");
  wrongProviderDeep.metadata.provider = "anthropic";
  wrongProviderStructural.metadata.provider = "anthropic";
  const wrongProvider = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [wrongProviderDeep, wrongProviderStructural, fablePass()] });
  assert.equal(wrongProvider.ready, false);
  assert.equal(wrongProvider.fleet.solReviewers, 0);

  const inventedDeep = solPass("invented-reviewer-one", "deep-code-review");
  const inventedStructural = solPass("invented-reviewer-two", "structural-challenge");
  inventedDeep.metadata.reviewerIdentityVerified = false;
  inventedStructural.metadata.reviewerIdentityVerified = false;
  const invented = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [inventedDeep, inventedStructural, fablePass()] });
  assert.equal(invented.ready, false);
  assert.match(invented.reasons.join(" "), /durable reviewer IDs/);
  assert.equal(invented.fleet.solReviewers, 0);
});

test("full MRR reconciles every fleet reviewer and excludes the orchestrator", () => {
  const deep = solPass(ids.owner, "deep-code-review");
  const secondSol = solPass(ids.solStructural, "structural-challenge");
  const fable = pass("anthropic.claude-fable-5", "GO", [], null, "structural-challenge");
  Object.assign(fable.metadata, { reviewerId: ids.fable, provider: "anthropic", route: "claude-aws", provenanceVerified: true, evidenceDigest: "c".repeat(64) });
  const dissent = solPass(ids.dissent, "deep-code-review");
  dissent.metadata.verdict = "NO_GO";
  const policy = { mode: "full", requireReviewerIds: true, minSolReviewers: 2, requireFableViaClaudeAws: true };
  const orchestrated = evaluateMrr({ branch: "codex/sample", orchestrator: ids.owner, reviewPolicy: policy, assessment: { currentHead: head }, reviewPasses: [deep, secondSol, fable] });
  assert.equal(orchestrated.ready, false);
  assert.match(orchestrated.reasons.join(" "), /orchestrator cannot count/);
  deep.metadata.reviewerId = ids.solDeep;
  const noGo = evaluateMrr({ branch: "codex/sample", reviewPolicy: policy, assessment: { currentHead: head }, reviewPasses: [deep, secondSol, fable, dissent] });
  assert.equal(noGo.ready, false);
  assert.match(noGo.reasons.join(" "), /not GO/);
});

test("full fleet blocks every non-GO while reduced policies ignore unrelated fleet passes", () => {
  const deep = solPass(ids.solDeep, "deep-code-review");
  const secondSol = solPass(ids.solStructural, "structural-challenge");
  const fable = pass("anthropic.claude-fable-5", "GO", [], null, "structural-challenge");
  Object.assign(fable.metadata, { reviewerId: ids.fable, provider: "anthropic", route: "claude-aws", provenanceVerified: true, evidenceDigest: "d".repeat(64) });
  const conditional = pass("gpt-5.6-terra", "CONDITIONAL_GO", [], null, "structural-challenge");
  conditional.metadata.reviewerId = ids.conditional;
  const full = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", requireReviewerIds: true, minSolReviewers: 2, requireFableViaClaudeAws: true }, assessment: { currentHead: head }, reviewPasses: [deep, secondSol, fable, conditional] });
  assert.equal(full.ready, false);
  assert.match(full.reasons.join(" "), /not GO/);
  const reduced = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "single-independent", reason: "bounded exception", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [conditional, deep] });
  assert.equal(reduced.ready, true);
  const none = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none", reason: "retrospective", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [conditional] });
  assert.equal(none.ready, true);
});
