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
  conditional: "019f0000-0000-7000-8000-000000000106"
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
  Object.assign(result.metadata, { reviewerId, reviewerIdentityVerified: true, provenanceVerified: true, evidenceDigest: "b".repeat(64), provider: "openai" });
  return result;
}

function fablePass() {
  const result = pass("anthropic.claude-fable-5", "GO", [], null, "structural-challenge");
  Object.assign(result.metadata, { reviewerId: ids.fable, provider: "anthropic", route: "claude-aws", provenanceVerified: true, evidenceDigest: "a".repeat(64) });
  return result;
}

function fullFleet(...extra) {
  return [solPass(ids.solDeep, "deep-code-review"), solPass(ids.solStructural, "structural-challenge"), fablePass(), ...extra];
}

test("MRR requires both exact-head review lanes", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "GO", [], "high")] });
  assert.equal(result.ready, false);
  assert.equal(result.lanes.deepCode, null);
  assert.equal(result.lanes.structuralChallenge, null);
  assert.match(result.reasons.join(" "), /structural-challenge/);
});

test("MRR accepts completed Codex sol and Fable passes", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: fullFleet() });
  assert.equal(result.ready, true);
  assert.equal(result.reasons.length, 0);
});

test("MRR remains blocked by current-head NO-GO or unresolved findings", () => {
  const fleet = fullFleet();
  fleet[0].metadata.verdict = "NO_GO";
  fleet[2].metadata.unresolved = ["contract gap"];
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: fleet });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /not GO/);
  assert.match(result.reasons.join(" "), /unresolved/);
});

test("MRR rejects GO until every reported finding is reconciled", () => {
  const fleet = fullFleet();
  fleet[0].metadata.findings = ["material defect"];
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: fleet });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /unreconciled/);
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

test("explicit reviewer roles do not bypass the global fleet floor", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [
    pass("future-model-a", "GO", [], null, "deep-code-review"),
    pass("future-model-b", "GO", [], null, "structural-challenge")
  ] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /2 distinct Sol reviewers/);
});

test("single-independent policy cannot waive the full code fleet", () => {
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "single-independent", reason: "Low-risk docs-adjacent change", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [pass("independent-reviewer")] });
  assert.equal(result.ready, false);
  assert.equal(result.policy.mode, "full");
  assert.match(result.reasons.join(" "), /2 distinct Sol reviewers/);
});

test("delta policy cannot waive the full code fleet", () => {
  const baseHead = "1234567890abcdef1234567890abcdef12345678";
  const missing = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "delta", reason: "Only a bounded fix changed", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [pass("independent-reviewer")] });
  assert.equal(missing.ready, false);
  const ready = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "delta", reason: "Only a bounded fix changed", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [pass("independent-reviewer", "GO", [], null, null, "delta", baseHead)] });
  assert.equal(ready.ready, false);
  assert.equal(ready.policy.mode, "full");
});

test("none policy cannot waive the full code fleet", () => {
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none", reason: "Generated metadata-only branch", userAuthorized: true }, assessment: { currentHead: head }, reviewPasses: [] });
  assert.equal(result.ready, false);
  assert.equal(result.policy.mode, "full");
});

test("non-full policy is normalized to the full code fleet", () => {
  const result = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none" }, assessment: { currentHead: head }, reviewPasses: [] });
  assert.equal(result.ready, false);
  assert.equal(result.policy.mode, "full");
  assert.match(result.reasons.join(" "), /Fable review through claude-aws/);
});

test("CONDITIONAL_GO does not satisfy readiness", () => {
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [pass("gpt-5.6-sol", "CONDITIONAL_GO", [], "high"), pass("anthropic.claude-fable-5")] });
  assert.equal(result.ready, false);
});

test("configured review provenance requires distinct reviewer IDs and providers", () => {
  const [deep, structural, fable] = fullFleet();
  const ready = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", minProviderFamilies: 2 }, assessment: { currentHead: head }, reviewPasses: [deep, structural, fable] });
  assert.equal(ready.ready, true);
  structural.metadata.reviewerId = ids.solDeep;
  const duplicate = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", minProviderFamilies: 2 }, assessment: { currentHead: head }, reviewPasses: [deep, structural, fable] });
  assert.equal(duplicate.ready, false);
  assert.match(duplicate.reasons.join(" "), /2 distinct Sol reviewers/);
});

test("provider diversity rejects arbitrary labels and reduced policies remain blocked", () => {
  const deep = pass("future-model-a", "GO", [], null, "deep-code-review");
  const structural = pass("future-model-b", "GO", [], null, "structural-challenge");
  deep.metadata.provider = "vendor-a";
  structural.metadata.provider = "vendor-b";
  deep.metadata.reviewerId = ids.solDeep;
  structural.metadata.reviewerId = ids.solStructural;
  const forged = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", minProviderFamilies: 2 }, assessment: { currentHead: head }, reviewPasses: [deep, structural] });
  assert.equal(forged.ready, false);
  const one = pass("gpt-5.6-sol", "GO", [], null, "deep-code-review");
  one.metadata.reviewerId = ids.solDeep;
  const reduced = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "single-independent", reason: "bounded exception", userAuthorized: true, minProviderFamilies: 2, requireReviewerIds: true }, assessment: { currentHead: head }, reviewPasses: [one] });
  assert.equal(reduced.ready, false);
  const none = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "none", reason: "retrospective", userAuthorized: true, minProviderFamilies: 2, requireReviewerIds: true }, assessment: { currentHead: head }, reviewPasses: [] });
  assert.equal(none.ready, false);
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

test("full MRR binds witnessed Sol reviewers to both required roles", () => {
  const deepOne = solPass(ids.solDeep, "deep-code-review");
  const deepTwo = solPass(ids.solStructural, "deep-code-review");
  const result = evaluateMrr({ branch: "codex/sample", assessment: { currentHead: head }, reviewPasses: [deepOne, deepTwo, fablePass()] });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /Sol structural-challenge lane/);
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

test("unverified advisory evidence cannot veto the witnessed full fleet", () => {
  const deep = solPass(ids.solDeep, "deep-code-review");
  const secondSol = solPass(ids.solStructural, "structural-challenge");
  const fable = pass("anthropic.claude-fable-5", "GO", [], null, "structural-challenge");
  Object.assign(fable.metadata, { reviewerId: ids.fable, provider: "anthropic", route: "claude-aws", provenanceVerified: true, evidenceDigest: "d".repeat(64) });
  const conditional = pass("gpt-5.6-terra", "CONDITIONAL_GO", [], null, "structural-challenge");
  conditional.metadata.reviewerId = ids.conditional;
  const full = evaluateMrr({ branch: "codex/sample", reviewPolicy: { mode: "full", requireReviewerIds: true, minSolReviewers: 2, requireFableViaClaudeAws: true }, assessment: { currentHead: head }, reviewPasses: [deep, secondSol, fable, conditional] });
  assert.equal(full.ready, true);
});
