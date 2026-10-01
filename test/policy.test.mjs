import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { botsReasons, canonicalReviewModel, CRR_ROLE, evaluateGate, evaluateMergeReady, identityKey, lastReadyMrr, latestClaimReviews, modelFamily, noGoHasEvidence, NO_GITHUB_CHECKS_REASON, occupyingReview, openReasons, outstandingFindings, providerForModel, seatingFor, satisfiesIntended, validateReview, workstreamBotsReasons } from "../src/policy.mjs";
import { normalizeReview } from "../src/envelope.mjs";

const head = "a".repeat(40), baseHead = "b".repeat(40), tree = "c".repeat(40);
const claim = "Ship the stated delivery unit";
const workstream = { claim, claimRevision: 1, ownerTaskId: "owner" };
const crrTarget = { head, baseHead, tree };
const mrrTarget = { head, baseHead };
const models = {
  "deep-code-review": { model: "gpt-6-astra", provider: "openai" },
  "structural-challenge": { model: "grok-4.6", provider: "cursor" },
  "fable-challenge": { model: "claude-fable-5", provider: "anthropic" }
};

const mrrDelegation = (role, id = randomUUID(), extras = {}) => ({
  id, event: "created", type: "review", role, kind: "mrr", claim, claimRevision: 1, head, baseHead,
  model: extras.model || models[role]?.model || extras.model, route: extras.route || "cli", ownerTaskIdAtBrief: "owner",
  ...(extras.substitutionReason ? { substitutionReason: extras.substitutionReason } : {}),
  ...(extras.reconciliationOnly ? { reconciliationOnly: true, jobRole: extras.jobRole } : {})
});

const crrDelegation = (id = randomUUID(), extras = {}) => ({
  id, event: "created", type: "review", role: CRR_ROLE, kind: "crr", claim, claimRevision: 1, head, baseHead, tree,
  model: extras.model || "composer-2", route: extras.route || "native", ownerTaskIdAtBrief: "owner"
});

function mrrEnvelope(d, reviewerTaskId, extras = {}) {
  const seated = models[d.role];
  return {
    reviewComplete: true, independent: true, delegationId: d.id, reviewerTaskId, claim, kind: "mrr", role: d.role,
    head, baseHead, provider: extras.provider || seated.provider, model: extras.model || d.model, route: d.route,
    verdict: extras.verdict || "GO", findings: extras.findings || [], unresolved: extras.unresolved || [],
    summary: extras.summary || "Complete adversarial review",
    scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 88, evidenceConfidence: 92, outcomeConfidence: 91 },
    scoreRationale: { mergeReadiness: "Ready", structuralRisk: "Low risk", implementationQuality: "Strong", evidenceConfidence: "Direct evidence", outcomeConfidence: "Outcome supported" },
    necessity: "necessary", simplerPath: "No simpler reliable path was found.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong",
    ...(extras.substitutionReason ? { substitutionReason: extras.substitutionReason } : {}),
    ...("reconciled" in extras ? { reconciled: extras.reconciled } : {})
  };
}

function crrEnvelope(d, reviewerTaskId, extras = {}) {
  return {
    reviewComplete: true, independent: true, delegationId: d.id, reviewerTaskId, claim, kind: "crr", role: CRR_ROLE,
    head, baseHead, tree, provider: extras.provider || "cursor", model: extras.model || d.model, route: d.route,
    verdict: extras.verdict || "GO", findings: extras.findings || [], unresolved: extras.unresolved || [],
    summary: extras.summary || "Looks competent",
    scores: { mergeReadiness: 80, structuralRisk: 20, implementationQuality: 80, evidenceConfidence: 80, outcomeConfidence: 80 },
    scoreRationale: { mergeReadiness: "n", structuralRisk: "n", implementationQuality: "n", evidenceConfidence: "n", outcomeConfidence: "n" }
  };
}

const mrrComplete = (role, id, extras = {}) => {
  const d = extras.delegation || mrrDelegation(role, undefined, extras);
  return validateReview(mrrEnvelope(d, id, extras), d);
};

const crrComplete = (id, extras = {}) => {
  const d = extras.delegation || crrDelegation(undefined, extras);
  return validateReview(crrEnvelope(d, id, extras), d);
};

test("provider is derived from the seated model and a supplied label does not fail the review", () => {
  assert.equal(providerForModel("gpt-6-astra"), "openai");
  assert.equal(providerForModel("gpt-5.6-sol"), "openai");
  assert.equal(providerForModel("claude-fable-5"), "anthropic");
  assert.equal(providerForModel("claude-opus-5-5"), "anthropic");
  assert.equal(providerForModel("claude-sonnet-5"), "anthropic");
  assert.equal(providerForModel("gpt-5.6-terra"), "openai");
  assert.equal(providerForModel("grok-4.6"), "xai");
  assert.equal(providerForModel("composer-2"), null);
  const astra = mrrDelegation("deep-code-review");
  const omitted = { ...mrrEnvelope(astra, "astra-omit") };
  delete omitted.provider;
  const recorded = validateReview(omitted, astra);
  assert.equal(recorded.provider, "openai");
  assert.equal(recorded.verdict, "GO");
  assert.equal(validateReview(mrrEnvelope(astra, "astra-label", { provider: "OpenAI" }), astra).provider, "openai");
  assert.equal(validateReview(mrrEnvelope(astra, "astra-other", { provider: "Codex" }), astra).provider, "openai");
  const grok = mrrDelegation("structural-challenge");
  assert.equal(validateReview(mrrEnvelope(grok, "grok-cursor", { provider: "cursor" }), grok).provider, "xai");
  assert.equal(validateReview(mrrEnvelope(grok, "grok-wrong", { provider: "OpenAI" }), grok).provider, "xai");
  const fable = mrrDelegation("fable-challenge");
  assert.equal(validateReview(mrrEnvelope(fable, "fable-label", { provider: "Claude" }), fable).provider, "anthropic");
  const crr = crrDelegation();
  const crrRecorded = validateReview(crrEnvelope(crr, "crr-free", { provider: "OpenAI/Codex" }), crr);
  assert.equal("provider" in crrRecorded, false);
  assert.equal(crrRecorded.model, "composer-2");
  const crrOmitted = { ...crrEnvelope(crr, "crr-omit") };
  delete crrOmitted.provider;
  assert.equal("provider" in validateReview(crrOmitted, crr), false);
});

test("canonical models accept Cursor Grok aliases and reject unknown ids", () => {
  assert.equal(canonicalReviewModel("cursor-grok-4.6-high"), "grok-4.6");
  assert.equal(canonicalReviewModel("grok-4.6"), "grok-4.6");
  assert.equal(canonicalReviewModel("gpt-6-astra"), "gpt-6-astra");
  assert.equal(canonicalReviewModel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(canonicalReviewModel("claude-fable-5"), "claude-fable-5");
  assert.equal(canonicalReviewModel("claude-opus-5-5-medium"), "claude-opus-5-5");
  assert.equal(canonicalReviewModel("claude-fable-5-1-thinking-high"), "claude-fable-5-1");
  assert.equal(canonicalReviewModel("claude-sonnet-5-5-high"), "claude-sonnet-5-5");
  assert.equal(canonicalReviewModel("gpt-5.6-sol-medium"), "gpt-5.6-sol");
  assert.equal(canonicalReviewModel("gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(canonicalReviewModel("codex-auto-review"), "codex-auto-review");
  assert.equal(modelFamily("claude-sonnet-5"), "anthropic");
  assert.equal(modelFamily("gpt-5.5"), "codex");
  assert.equal(canonicalReviewModel("anthropic.claude-fable-5"), null);
  assert.equal(canonicalReviewModel("composer-2"), null);
  assert.equal(canonicalReviewModel("grok-4.65"), null);
});

test("crr seating accepts local models; mrr seating is Astra/Grok/Fable", () => {
  assert.equal(seatingFor(CRR_ROLE).model, "local");
  assert.equal(seatingFor(CRR_ROLE, "composer-2").model, "composer-2");
  assert.equal(seatingFor("deep-code-review").model, "gpt-6-astra");
  assert.equal(seatingFor("structural-challenge").model, "grok-4.6");
  assert.equal(seatingFor("fable-challenge").model, "claude-opus-5-5");
  assert.equal(seatingFor("fable-challenge").intended, "claude-opus-5-5");
  assert.throws(() => seatingFor("fable-challenge", "anthropic.claude-fable-5"), /Unknown review model/);
  const sameFamily = seatingFor("fable-challenge", "claude-fable-5");
  assert.equal(sameFamily.model, "claude-fable-5");
  assert.equal(sameFamily.substituted, false);
  assert.equal(sameFamily.intended, "claude-opus-5-5");
  assert.equal(seatingFor("fable-challenge", "claude-sonnet-5").substituted, false);
  assert.equal(satisfiesIntended("claude-opus-5-5-medium", "claude-fable-5"), true);
  const substituted = seatingFor("fable-challenge", "gpt-6-astra");
  assert.equal(substituted.model, "gpt-6-astra");
  assert.equal(substituted.substituted, true);
  assert.equal(substituted.intended, "claude-opus-5-5");
  const sol = seatingFor("deep-code-review", "gpt-5.6-sol");
  assert.equal(sol.model, "gpt-5.6-sol");
  assert.equal(sol.substituted, false);
  assert.equal(sol.intended, "gpt-6-astra");
  assert.equal(seatingFor("deep-code-review", "gpt-5.6-terra").substituted, false);
  assert.equal(seatingFor("deep-code-review", "claude-opus-5-5").substituted, true);
  assert.throws(() => seatingFor("cheap-review"), /Unknown review role/);
});

test("identity keys live in the project namespace", () => {
  assert.deepEqual(identityKey("aon", "coordinator"), { key: "aon/coordinator", fallback: "aon/coordinator-2" });
  assert.deepEqual(identityKey("ad", "owner"), { key: "ad/owner", fallback: "ad/owner-2" });
  assert.throws(() => identityKey("aon", "reviewer"), /coordinator or owner/);
});

test("crr gate needs one finding-free GO, not three personas", () => {
  assert.equal(evaluateGate({ kind: "crr", target: crrTarget, workstream, reviews: [crrComplete("crr-1")] }).ready, true);
  const missing = evaluateGate({ kind: "crr", target: crrTarget, workstream, reviews: [] });
  assert.equal(missing.ready, false);
  assert.match(missing.reasons.join(" "), /missing crr/);
  const owner = evaluateGate({ kind: "crr", target: crrTarget, workstream, reviews: [crrComplete("owner")] });
  assert.match(owner.reasons.join(" "), /owner cannot satisfy/);
  const later = evaluateGate({ kind: "crr", target: crrTarget, workstream, reviews: [crrComplete("crr-1"), crrComplete("crr-2", { verdict: "NO_GO", findings: ["Gap"] })] });
  assert.equal(later.ready, false);
  assert.match(later.reasons.join(" "), /not a finding-free GO/);
  assert.throws(() => evaluateGate({ kind: "commit", target: crrTarget, workstream, reviews: [] }), /crr or mrr/);
});

test("crr findings do not enter the durable ledger", () => {
  const crr = crrComplete("crr-1", { verdict: "NO_GO", findings: ["Gap in tests"] });
  assert.deepEqual(outstandingFindings([crr], claim), []);
  const mrr = mrrComplete("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Authority boundary is unsound"] });
  assert.deepEqual(outstandingFindings([crr, mrr], claim).map((item) => item.id), ["F1"]);
});

test("mrr gate requires three finding-free persona GOs", () => {
  const reviews = [
    mrrComplete("deep-code-review", "sol-run"),
    mrrComplete("structural-challenge", "grok-run"),
    mrrComplete("fable-challenge", "fable-run")
  ];
  assert.equal(evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews }).ready, true);
  const two = evaluateGate({
    kind: "mrr", target: mrrTarget, workstream,
    reviews: reviews.slice(0, 2),
    delegations: [
      { id: randomUUID(), event: "created", type: "review", role: "fable-challenge", kind: "mrr", model: "claude-fable-5", claim, claimRevision: 1, head, baseHead },
      { id: randomUUID(), event: "failed" }
    ]
  });
  assert.equal(two.ready, false);
  assert.match(two.reasons.join(" "), /missing fable-challenge review/);
  const missing = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: reviews.slice(0, 2) });
  assert.equal(missing.ready, false);
  assert.match(missing.reasons.join(" "), /missing fable-challenge review/);
  assert.throws(() => evaluateGate({ kind: "coverage", target: mrrTarget, workstream, reviews }), /crr or mrr/);
});

test("a substituted mrr GO fills its job and does not require a provider failure", () => {
  const reviews = [
    mrrComplete("deep-code-review", "sol-run"),
    mrrComplete("structural-challenge", "sol-sub", { model: "gpt-6-astra", provider: "openai", substitutionReason: "cursor-agent not on PATH" }),
    mrrComplete("fable-challenge", "fable-run")
  ];
  const ready = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews });
  assert.equal(ready.ready, true);
  assert.match(ready.notes.join(" "), /structural-challenge: GO via Astra; intended Grok was substituted: cursor-agent not on PATH/);
  const unattested = { ...mrrComplete("structural-challenge", "grok-run"), model: "gpt-6-astra", provider: "openai" };
  const blocked = evaluateGate({
    kind: "mrr",
    target: mrrTarget,
    workstream,
    reviews: [mrrComplete("deep-code-review", "sol-run"), unattested, mrrComplete("fable-challenge", "fable-run")]
  });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join(" "), /structural-challenge is not a finding-free GO/);
  const bare = mrrDelegation("structural-challenge", undefined, { model: "gpt-6-astra" });
  assert.throws(
    () => validateReview(mrrEnvelope(bare, "sol-bare", { model: "gpt-6-astra", provider: "openai" }), bare),
    /substitution requires a non-empty substitutionReason/
  );
  const forged = mrrComplete("structural-challenge", "sol-forged", { model: "gpt-6-astra", provider: "openai", substitutionReason: "cursor-agent not on PATH" });
  const silent = { id: forged.delegationId, event: "created", type: "review", role: "structural-challenge", kind: "mrr", model: "gpt-6-astra" };
  const invented = evaluateGate({
    kind: "mrr",
    target: mrrTarget,
    workstream,
    reviews: [mrrComplete("deep-code-review", "sol-run"), forged, mrrComplete("fable-challenge", "fable-run")],
    delegations: [silent]
  });
  assert.equal(invented.ready, false);
  assert.match(invented.reasons.join(" "), /structural-challenge is not a finding-free GO/);
});

test("historical Sol and initial Astra panels retain readiness, churn, and skip eligibility", () => {
  for (const model of ["gpt-5.6-sol", "gpt-6-astra"]) {
    const deep = mrrDelegation("deep-code-review", undefined, { model });
    const delegations = [deep, mrrDelegation("structural-challenge"), mrrDelegation("fable-challenge")];
    // These are the original persisted envelopes, not normalized by new code.
    const reviews = delegations.map((d, i) => mrrEnvelope(d, `historical-${i}`));
    const snapshot = JSON.stringify({ reviews, delegations });
    const args = { target: mrrTarget, workstream, reviews, delegations };
    assert.equal(evaluateGate({ ...args, kind: "mrr" }).ready, true, model);
    assert.deepEqual(lastReadyMrr(reviews, workstream, delegations), { head, baseHead });
    const target = { ...mrrTarget, head: "d".repeat(40) };
    assert.equal(evaluateMergeReady({ ...args, target }).phase, "churn");
    const waivers = [{ ...target, claim, claimRevision: 1, actor: "user", reason: "Explicitly approved skip", priorHead: head }];
    assert.equal(evaluateMergeReady({ ...args, target, waivers }).phase, "waived");
    assert.equal(validateReview(reviews[0], deep).intendedModel, model);
    assert.equal(JSON.stringify({ reviews, delegations }), snapshot, "reading evidence must not rewrite history");
  }
});

test("a Codex model satisfies an Astra-intended brief without a substitution attestation", () => {
  const original = { ...mrrDelegation("deep-code-review", undefined, { model: "gpt-5.6-sol" }), intendedModel: "gpt-5.6-sol" };
  const historical = validateReview(mrrEnvelope(original, "original-sol"), original);
  assert.equal(historical.intendedModel, "gpt-5.6-sol");
  const newBrief = { ...original, id: randomUUID(), model: "gpt-5.6-sol", intendedModel: "gpt-6-astra" };
  const recorded = validateReview(normalizeReview(mrrEnvelope(newBrief, "new-sol"), newBrief), newBrief);
  assert.equal(recorded.model, "gpt-5.6-sol");
  assert.equal(recorded.intendedModel, "gpt-6-astra");
  assert.equal(recorded.substitutionReason, undefined);
  const others = [mrrComplete("structural-challenge", "grok"), mrrComplete("fable-challenge", "fable")];
  const ready = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: [recorded, ...others], delegations: [newBrief] });
  assert.equal(ready.ready, true);
  assert.equal(ready.notes.join(" "), "");
  const attested = { ...newBrief, substitutionReason: "Astra unavailable before launch" };
  assert.throws(() => validateReview(normalizeReview(mrrEnvelope(attested, "attested-sol"), attested), attested), /substitutionReason is only valid/);
  const cross = { ...newBrief, id: randomUUID(), model: "claude-opus-5-5" };
  assert.throws(() => validateReview(normalizeReview(mrrEnvelope(cross, "cross", { model: "claude-opus-5-5", provider: "anthropic" }), cross), cross), /substitution requires/);
  const invalid = { ...newBrief, intendedModel: "unknown" };
  assert.throws(() => validateReview(normalizeReview(mrrEnvelope(invalid, "invalid"), invalid), invalid), /invalid intendedModel/);
});

test("an Anthropic model satisfies an Opus-intended fable brief", () => {
  const brief = { ...mrrDelegation("fable-challenge", undefined, { model: "claude-sonnet-5" }), intendedModel: "claude-opus-5-5" };
  const recorded = validateReview(mrrEnvelope(brief, "sonnet", { model: "claude-sonnet-5", provider: "anthropic" }), brief);
  assert.equal(recorded.model, "claude-sonnet-5");
  assert.equal(recorded.intendedModel, "claude-opus-5-5");
  assert.equal(recorded.provider, "anthropic");
  assert.equal(recorded.substitutionReason, undefined);
  const legacy = mrrDelegation("fable-challenge");
  assert.equal(validateReview(mrrEnvelope(legacy, "legacy-fable"), legacy).intendedModel, "claude-fable-5");
});

test("the first completed envelope occupies its persona job", () => {
  const first = mrrComplete("structural-challenge", "grok-run");
  const later = mrrComplete("structural-challenge", "grok-later", { verdict: "NO_GO", findings: ["Later defect"] });
  const reviews = [
    mrrComplete("deep-code-review", "sol-run"),
    first,
    mrrComplete("fable-challenge", "fable-run"),
    later
  ];
  const result = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews });
  assert.equal(occupyingReview(reviews, { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 }).reviewerTaskId, "grok-run");
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /unreconciled structural-challenge finding F1/);
  assert.doesNotMatch(result.reasons.join(" "), /structural-challenge is not a finding-free GO/);
});

test("merge-ready accepts an exact-head skip after a prior finding-free MRR", () => {
  const older = "d".repeat(40);
  const reviews = [
    { ...mrrComplete("deep-code-review", "sol-run"), head: older },
    { ...mrrComplete("structural-challenge", "grok-run"), head: older },
    { ...mrrComplete("fable-challenge", "fable-run"), head: older }
  ];
  const churn = evaluateMergeReady({ kind: "mrr", target: mrrTarget, workstream, reviews });
  assert.equal(churn.phase, "churn");
  assert.equal(churn.ready, false);
  const waived = evaluateMergeReady({
    target: mrrTarget, workstream, reviews,
    waivers: [{ head, baseHead, claim, claimRevision: 1, priorHead: older, reason: "Not a substantive authority change", actor: "owner" }]
  });
  assert.equal(waived.phase, "waived");
  assert.equal(waived.ready, true);
  const missingActor = evaluateMergeReady({
    target: mrrTarget, workstream, reviews,
    waivers: [{ head, baseHead, claim, claimRevision: 1, priorHead: older, reason: "skip" }]
  });
  assert.equal(missingActor.phase, "churn");
  assert.equal(missingActor.ready, false);
  const blocked = evaluateMergeReady({
    target: mrrTarget, workstream, reviews: reviews.slice(0, 1),
    waivers: [{ head, baseHead, claim, claimRevision: 1, priorHead: older, reason: "skip", actor: "owner" }]
  });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join(" "), /prior finding-free MRR/);
  const newer = "e".repeat(40);
  const partial = [...reviews, { ...mrrComplete("deep-code-review", "sol-new"), head: newer }];
  assert.equal(lastReadyMrr(partial, workstream).head, older);
  const stillChurn = evaluateMergeReady({ target: { kind: "mrr", head: newer, baseHead }, workstream, reviews: partial });
  assert.equal(stillChurn.phase, "churn");
});

test("mrr findings remain durable until explicitly reconciled", () => {
  const adverse = mrrComplete("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Fix the bug"] });
  assert.deepEqual(outstandingFindings([adverse], claim).map((item) => item.id), ["F1"]);
  const reconciled = mrrComplete("deep-code-review", "sol-retry", { reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "Fixed and regression-tested." }] });
  assert.deepEqual(outstandingFindings([adverse, reconciled], claim), []);
});

test("a later mrr GO does not silently clear a recorded finding", () => {
  const adverse = mrrComplete("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Defect remains"] });
  const later = mrrComplete("deep-code-review", "sol-run");
  assert.deepEqual(outstandingFindings([adverse, later], claim).map((item) => item.id), ["F1"]);
});

test("claim edits do not launder mrr evidence", () => {
  const adverse = mrrComplete("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Claim-specific defect"] });
  const revised = mrrDelegation("deep-code-review");
  revised.claim = "Revised claim";
  const rejection = validateReview({ ...mrrEnvelope(revised, "sol-run"), claim: "Revised claim", reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable to the revised claim." }] }, revised);
  assert.deepEqual(outstandingFindings([adverse, rejection], "Revised claim", mrrTarget, 1), []);
  assert.deepEqual(outstandingFindings([adverse, rejection], claim, mrrTarget, 1).map((item) => item.id), ["F1"]);
});

test("bots gate rejects branch, base, and unsuccessful checks without draft ceremony", () => {
  const reasons = botsReasons({
    project: { baseBranch: "main" }, checkout: { dirty: false, head },
    pr: { number: 7, state: "OPEN", isDraft: true, headRefOid: head, headRefName: "feature", baseRefName: "develop", statusCheckRollup: [{ conclusion: "CANCELLED", status: "COMPLETED" }] },
    target: { head, branch: "other" }
  });
  assert.match(reasons.join(" "), /configured base/);
  assert.match(reasons.join(" "), /unsuccessful conclusion/);
  assert.match(reasons.join(" "), /reviewed branch/);
  assert.doesNotMatch(reasons.join(" "), /already non-draft/);
});

test("an already-ready PR with matching evidence is fine", () => {
  const reasons = botsReasons({
    project: { baseBranch: "main" }, checkout: { dirty: false, head },
    pr: { number: 7, state: "OPEN", isDraft: false, headRefOid: head, headRefName: "feature", baseRefName: "main", statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }] },
    target: { head, branch: "feature" }
  });
  assert.deepEqual(reasons, []);
});

test("open and bots gates block when checkout HEAD does not match the reviewed head", () => {
  const moved = "e".repeat(40);
  assert.match(openReasons({ checkout: { dirty: false, head: moved }, target: { head } }).join(" "), /does not match reviewed head/);
  const reasons = botsReasons({
    project: { baseBranch: "main" }, checkout: { dirty: false, head: moved },
    pr: { number: 7, state: "OPEN", isDraft: false, headRefOid: head, headRefName: "feature", baseRefName: "main", statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }] },
    target: { head, branch: "feature" }
  });
  assert.match(reasons.join(" "), /does not match reviewed head/);
});

test("bots gate blocks an empty GitHub check rollup", () => {
  const empty = botsReasons({
    project: { baseBranch: "main" }, checkout: { dirty: false, head },
    pr: { number: 7, state: "OPEN", isDraft: false, headRefOid: head, headRefName: "feature", baseRefName: "main", statusCheckRollup: [] },
    target: { head, branch: "feature" }
  });
  assert.deepEqual(empty, [NO_GITHUB_CHECKS_REASON]);
  const missing = botsReasons({
    project: { baseBranch: "main" }, checkout: { dirty: false, head },
    pr: { number: 7, state: "OPEN", isDraft: false, headRefOid: head, headRefName: "feature", baseRefName: "main" },
    target: { head, branch: "feature" }
  });
  assert.deepEqual(missing, [NO_GITHUB_CHECKS_REASON]);
});

test("bots gate blocks duplicate PR ownership", () => {
  const primary = { id: "primary", project: "sample", pullRequests: [7] };
  const reasons = workstreamBotsReasons({ workstream: primary, workstreams: [primary, { id: "other", project: "sample", pullRequests: [7] }], pr: { number: 7 } });
  assert.match(reasons.join(" "), /also claimed by workstream other/);
});

test("mrr reviewer task IDs are distinct", () => {
  const duplicate = evaluateGate({
    kind: "mrr", target: mrrTarget, workstream,
    reviews: [mrrComplete("deep-code-review", "same"), mrrComplete("structural-challenge", "same"), mrrComplete("fable-challenge", "fable-run")]
  });
  assert.match(duplicate.reasons.join(" "), /distinct reviewer task IDs/);
});

test("the occupying envelope is authoritative for its persona job", () => {
  const reviews = [
    mrrComplete("deep-code-review", "sol-run"),
    mrrComplete("structural-challenge", "grok-run"),
    mrrComplete("fable-challenge", "fable-run"),
    mrrComplete("structural-challenge", "grok-later", { verdict: "NO_GO", findings: ["Later defect"] })
  ];
  const result = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews });
  assert.equal(result.lanes["structural-challenge"].reviewerTaskId, "grok-run");
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /unreconciled/);
});

test("latestClaimReviews keeps the latest seat on the claim even when HEAD moved", () => {
  const stale = { ...mrrComplete("structural-challenge", "grok-old"), head: "d".repeat(40) };
  const latest = latestClaimReviews([
    stale,
    mrrComplete("structural-challenge", "grok-new", { verdict: "NO_GO", findings: ["Later defect"] }),
    crrComplete("crr-1")
  ], workstream);
  assert.equal(latest["structural-challenge"].reviewerTaskId, "grok-new");
  assert.equal(latest.crr.reviewerTaskId, "crr-1");
  assert.equal(latest["deep-code-review"], null);
});

test("a still_present reconciliation is enough evidence for NO_GO", () => {
  const d = mrrDelegation("deep-code-review");
  const envelope = mrrEnvelope(d, "sol-run", {
    verdict: "NO_GO",
    findings: [],
    reconciled: [{ findingId: "F2", disposition: "still_present", rationale: "The delivered defect remains on this target." }]
  });
  assert.equal(noGoHasEvidence(envelope), true);
  assert.equal(validateReview(envelope, d).verdict, "NO_GO");
  assert.throws(() => validateReview(mrrEnvelope(d, "sol-empty", { verdict: "NO_GO", findings: [] }), d), /finding, unresolved item, or still_present/);
});
