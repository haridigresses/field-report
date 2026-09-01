import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  assertCourtJobAvailable, assertPersonaJobAvailable, COURT_ROLE, evaluateGate, occupyingReview,
  outstandingForDeep, outstandingOccupantPacket, outstandingFindings, seatingFor, validateReview
} from "../src/policy.mjs";

const head = "a".repeat(40), baseHead = "b".repeat(40);
const claim = "Ship the stated delivery unit";
const workstream = { claim, claimRevision: 1, ownerTaskId: "owner" };
const mrrTarget = { head, baseHead };
const models = {
  "deep-code-review": { model: "gpt-5.6-sol", provider: "openai" },
  "structural-challenge": { model: "grok-4.6", provider: "cursor" },
  "fable-challenge": { model: "claude-fable-5", provider: "anthropic" }
};

function mrrDelegation(role, extras = {}) {
  return {
    id: extras.id || randomUUID(), event: "created", type: "review", role, kind: "mrr", claim, claimRevision: 1, head, baseHead,
    model: extras.model || models[role].model, route: extras.route || "cli", ownerTaskIdAtBrief: extras.ownerTaskIdAtBrief || "owner",
    ...(extras.substitutionReason ? { substitutionReason: extras.substitutionReason } : {})
  };
}

function envelope(delegation, reviewerTaskId, extras = {}) {
  const seated = models[delegation.role] || { provider: extras.provider || "openai" };
  return {
    reviewComplete: true, independent: true, delegationId: delegation.id, reviewerTaskId, claim, kind: "mrr", role: delegation.role,
    head, baseHead, provider: extras.provider || seated.provider, model: extras.model || delegation.model, route: delegation.route,
    verdict: extras.verdict || "GO", findings: extras.findings || [], unresolved: extras.unresolved || [],
    summary: extras.summary || "Complete adversarial review",
    scores: extras.scores || { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 88, evidenceConfidence: 92, outcomeConfidence: 91 },
    scoreRationale: { mergeReadiness: "Ready", structuralRisk: "Low risk", implementationQuality: "Strong", evidenceConfidence: "Direct evidence", outcomeConfidence: "Outcome supported" },
    necessity: "necessary", simplerPath: "No simpler reliable path was found.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong",
    ...(extras.substitutionReason ? { substitutionReason: extras.substitutionReason } : {}),
    ...("reconciled" in extras ? { reconciled: extras.reconciled } : {})
  };
}

const persona = (role, id, extras = {}) => {
  const d = mrrDelegation(role, extras);
  return validateReview(envelope(d, id, extras), d);
};

function courtDelegation(jobRole, extras = {}) {
  return {
    id: extras.id || randomUUID(), event: "created", type: "review", role: COURT_ROLE, kind: "mrr", reconciliationOnly: true, jobRole,
    claim, claimRevision: 1, head, baseHead, model: extras.model || "gpt-5.6-sol", route: "cli", ownerTaskIdAtBrief: "owner"
  };
}

function courtEnvelope(delegation, reviewerTaskId, extras = {}) {
  return {
    reviewComplete: true, independent: true, delegationId: delegation.id, reviewerTaskId, claim, kind: "mrr", role: COURT_ROLE,
    head, baseHead, provider: extras.provider || "openai", model: extras.model || delegation.model, route: "cli",
    verdict: extras.verdict || "GO", findings: extras.findings || [], unresolved: extras.unresolved || [],
    summary: extras.summary || "Packet adjudicated",
    scores: { mergeReadiness: 40, structuralRisk: 40, implementationQuality: 40, evidenceConfidence: 80, outcomeConfidence: 80 },
    scoreRationale: { mergeReadiness: "n", structuralRisk: "n", implementationQuality: "n", evidenceConfidence: "n", outcomeConfidence: "n" },
    necessity: "necessary", simplerPath: "Court does not select a path.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong",
    reconciled: extras.reconciled
  };
}

const court = (jobRole, reviewerTaskId, extras = {}) => {
  const d = courtDelegation(jobRole, extras);
  return validateReview(courtEnvelope(d, reviewerTaskId, extras), d);
};

test("READY requires three finding-free GOs; scores never override", () => {
  const reviews = [persona("deep-code-review", "sol-run"), persona("structural-challenge", "grok-run"), persona("fable-challenge", "fable-run")];
  assert.equal(evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews }).ready, true);
  const weakScores = persona("deep-code-review", "sol-low", { scores: { mergeReadiness: 1, structuralRisk: 99, implementationQuality: 1, evidenceConfidence: 1, outcomeConfidence: 1 } });
  assert.equal(evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: [weakScores, reviews[1], reviews[2]] }).ready, true);
  const finding = persona("fable-challenge", "fable-no", { verdict: "NO_GO", findings: ["Gap"] });
  const blocked = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: [reviews[0], reviews[1], finding] });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join(" "), /fable-challenge is not a finding-free GO/);
});

test("a completed envelope occupies the job; substitution cannot escape a NO_GO", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  assert.equal(occupyingReview([occupant], scope).reviewerTaskId, "grok-run");
  assert.throws(() => assertPersonaJobAvailable([occupant], { ...scope, model: "gpt-5.6-sol", substitutionReason: "shop for GO" }), /occupied by Grok NO_GO/);
  assert.throws(() => assertPersonaJobAvailable([occupant], { ...scope, model: "grok-4.6" }), /adjudicate that packet/);
  assert.throws(() => seatingFor("structural-challenge", "composer-2"), /Unknown review model/);
});

test("substitution is allowed only while the job has zero envelopes and must be attested", () => {
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  assert.throws(() => assertPersonaJobAvailable([], { ...scope, model: "gpt-5.6-sol" }), /substitution requires a non-empty substitutionReason/);
  assert.doesNotThrow(() => assertPersonaJobAvailable([], { ...scope, model: "gpt-5.6-sol", substitutionReason: "Grok hung after bind" }));
  const go = persona("structural-challenge", "sol-sub", { model: "gpt-5.6-sol", provider: "openai", substitutionReason: "Grok hung after bind" });
  assert.throws(() => assertPersonaJobAvailable([go], { ...scope, model: "grok-4.6" }), /occupied by a completed envelope/);
});

test("court is evidence-only: full reject grants one rerun of the NO_GO model", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  const packet = outstandingOccupantPacket([occupant], occupant, claim);
  assert.deepEqual(packet.map((item) => item.id), ["F1"]);
  assert.deepEqual(outstandingForDeep([occupant], claim, mrrTarget), []);
  const still = court("structural-challenge", "sol-court", { verdict: "NO_GO", reconciled: [{ findingId: "F1", disposition: "still_present", rationale: "The defect remains on this target." }] });
  assert.throws(() => assertPersonaJobAvailable([occupant, still], { ...scope, model: "grok-4.6" }), /adjudicate that packet/);
  const rejected = court("structural-challenge", "sol-court", { reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable to this claim." }] });
  assert.doesNotThrow(() => assertPersonaJobAvailable([occupant, rejected], { ...scope, model: "grok-4.6" }));
  assert.throws(() => assertPersonaJobAvailable([occupant, rejected], { ...scope, model: "gpt-5.6-sol", substitutionReason: "shop" }), /one rerun of Grok/);
  const rerun = persona("structural-challenge", "grok-rerun");
  const reviews = [persona("deep-code-review", "sol-run"), occupant, rejected, rerun, persona("fable-challenge", "fable-run")];
  assert.equal(occupyingReview(reviews, scope).reviewerTaskId, "grok-rerun");
  const gate = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews });
  assert.equal(gate.ready, true);
  assert.equal(gate.lanes["structural-challenge"].reviewerTaskId, "grok-rerun");
});

test("court cannot fill a persona job or use the occupying model", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const scope = { jobRole: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  assert.throws(() => assertCourtJobAvailable([occupant], { ...scope, model: "grok-4.6" }), /cannot be the model that produced/);
  const go = persona("structural-challenge", "grok-go");
  assert.throws(() => assertCourtJobAvailable([go], { ...scope, model: "gpt-5.6-sol" }), /finding-free GO/);
  const courtGo = court("structural-challenge", "sol-court", { reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable." }] });
  const gate = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: [occupant, courtGo] });
  assert.equal(gate.ready, false);
  assert.equal(gate.lanes["structural-challenge"].reviewerTaskId, "grok-run");
  assert.match(gate.reasons.join(" "), /structural-challenge is not a finding-free GO/);
});

test("court cannot add findings or resolve them", () => {
  const d = courtDelegation("structural-challenge");
  assert.throws(() => validateReview(courtEnvelope(d, "sol-court", { findings: ["New defect"], reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "n" }] }), d), /Court cannot add findings/);
  assert.throws(() => validateReview(courtEnvelope(d, "sol-court", { reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "Fixed." }] }), d), /rejected\|still_present/);
});

test("exact-head findings stay off deep; older-head findings still travel with deep", () => {
  const older = { ...persona("structural-challenge", "grok-old", { verdict: "NO_GO", findings: ["Old defect"] }), head: "d".repeat(40) };
  assert.deepEqual(outstandingForDeep([older], claim, mrrTarget).map((item) => item.id), ["F1"]);
  const current = persona("structural-challenge", "grok-now", { verdict: "NO_GO", findings: ["Current defect"] });
  assert.deepEqual(outstandingForDeep([current], claim, mrrTarget), []);
  assert.deepEqual(outstandingFindings([current], claim).map((item) => item.id), ["F1"]);
});
