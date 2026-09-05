import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { normalizeReview } from "../src/envelope.mjs";
import {
  assertCourtJobAvailable, assertPersonaJobAvailable, COURT_ROLE, evaluateGate, isCourtReview, occupyingReview,
  occupantPacket, outstandingForDeep, outstandingOccupantPacket, outstandingFindings, seatingFor, validateReview
} from "../src/policy.mjs";

const head = "a".repeat(40), baseHead = "b".repeat(40);
const claim = "Ship the stated delivery unit";
const SUBSTITUTION_REASON = "cursor-agent not on PATH";
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
  assert.doesNotThrow(() => assertPersonaJobAvailable([], { ...scope, model: "gpt-5.6-sol", substitutionReason: SUBSTITUTION_REASON }));
  const go = persona("structural-challenge", "sol-sub", { model: "gpt-5.6-sol", provider: "openai", substitutionReason: SUBSTITUTION_REASON });
  assert.throws(() => assertPersonaJobAvailable([go], { ...scope, model: "grok-4.6" }), /occupied by a completed envelope/);
});

test("court is evidence-only: full reject grants one rerun of the NO_GO model", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  const packet = outstandingOccupantPacket([occupant], occupant, claim);
  assert.deepEqual(packet.map((item) => item.id), ["F1"]);
  assert.deepEqual(outstandingForDeep([occupant], claim, mrrTarget), []);
  const still = court("structural-challenge", "sol-court", { verdict: "NO_GO", reconciled: [{ findingId: "F1", disposition: "still_present", rationale: "The defect remains on this target." }] });
  assert.throws(() => assertPersonaJobAvailable([occupant, still], { ...scope, model: "grok-4.6" }), /already had its one court/);
  assert.throws(() => assertCourtJobAvailable([occupant, still], { jobRole: "structural-challenge", target: mrrTarget, claim, claimRevision: 1, model: "gpt-5.6-sol" }), /already had its one court/);
  const rejected = court("structural-challenge", "sol-court", { reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable to this claim." }] });
  assert.doesNotThrow(() => assertPersonaJobAvailable([occupant, rejected], { ...scope, model: "grok-4.6" }));
  assert.throws(() => assertPersonaJobAvailable([occupant, rejected], { ...scope, model: "gpt-5.6-sol", substitutionReason: "shop" }), /one rerun of Grok/);
  const rerun = persona("structural-challenge", "grok-rerun");
  const reviews = [persona("deep-code-review", "sol-run"), occupant, rejected, rerun, persona("fable-challenge", "fable-run")];
  assert.equal(occupyingReview(reviews, scope).reviewerTaskId, "grok-rerun");
  const gate = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews });
  assert.equal(gate.ready, true);
  assert.equal(gate.lanes["structural-challenge"].reviewerTaskId, "grok-rerun");
  const rebound = evaluateGate({ kind: "mrr", target: mrrTarget, workstream: { ...workstream, ownerTaskId: "sol-court" }, reviews });
  assert.equal(rebound.ready, false);
  assert.match(rebound.reasons.join(" "), /Workstream owner cannot satisfy an independent review/);
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

test("court is one-shot and cannot reuse a participating reviewer", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const deep = persona("deep-code-review", "sol-run");
  const fable = persona("fable-challenge", "fable-run");
  const panel = [occupant, deep, fable];
  const scope = { jobRole: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  assert.doesNotThrow(() => assertCourtJobAvailable(panel, { ...scope, model: "gpt-5.6-sol" }));
  assert.doesNotThrow(() => assertCourtJobAvailable(panel, { ...scope, model: "gpt-5.6-sol", reviewerTaskId: "sol-court" }));
  assert.doesNotThrow(() => assertCourtJobAvailable(panel, { ...scope, model: "claude-fable-5", reviewerTaskId: "fable-court" }));
  assert.throws(() => assertCourtJobAvailable(panel, { ...scope, model: "grok-4.6", reviewerTaskId: "grok-court" }), /cannot be the model that produced/);
  assert.throws(() => assertCourtJobAvailable(panel, { ...scope, model: "gpt-5.6-sol", reviewerTaskId: "sol-run" }), /participating persona reviewer/);
  assert.throws(() => assertCourtJobAvailable(panel, { ...scope, model: "claude-fable-5", reviewerTaskId: "grok-run" }), /participating persona reviewer/);
  const rejected = court("structural-challenge", "sol-court", { reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable." }] });
  assert.throws(() => assertCourtJobAvailable([occupant, rejected], { ...scope, model: "gpt-5.6-sol" }), /already had its one court/);
  const rerunNoGo = persona("structural-challenge", "grok-rerun", { verdict: "NO_GO", findings: ["Still unsound"] });
  const afterRerun = [occupant, rejected, rerunNoGo];
  assert.throws(() => assertCourtJobAvailable(afterRerun, { ...scope, model: "gpt-5.6-sol" }), /fix on a new head/);
  assert.throws(() => assertPersonaJobAvailable(afterRerun, { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1, model: "grok-4.6" }), /authorized rerun occupied this job/);
  const courtThenPersona = [occupant, rejected];
  assert.throws(
    () => assertPersonaJobAvailable(courtThenPersona, { role: "deep-code-review", target: mrrTarget, claim, claimRevision: 1, model: "gpt-5.6-sol", reviewerTaskId: "sol-court" }),
    /court reviewer cannot fill a persona job/
  );
  const overlap = [
    occupant,
    rejected,
    persona("structural-challenge", "grok-rerun"),
    persona("deep-code-review", "sol-court"),
    persona("fable-challenge", "fable-run")
  ];
  const overlapGate = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: overlap });
  assert.equal(overlapGate.ready, false);
  assert.match(overlapGate.reasons.join(" "), /Persona reviewers cannot reuse a court reviewer task ID/);
});

test("court cannot add findings or resolve them", () => {
  const d = courtDelegation("structural-challenge");
  assert.throws(() => validateReview(courtEnvelope(d, "sol-court", { findings: ["New defect"], reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "n" }] }), d), /Court cannot add findings/);
  assert.throws(() => validateReview(courtEnvelope(d, "sol-court", { reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "Fixed." }] }), d), /rejected\|still_present/);
});

test("occupancy ignores envelope-supplied court and ledger flags", () => {
  const d = mrrDelegation("structural-challenge");
  const raw = envelope(d, "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  raw.reconciliationOnly = true;
  raw.legacy = true;
  raw.staleAtRecord = true;
  raw.jobRole = "deep-code-review";
  const poisoned = validateReview(normalizeReview(raw, d), d);
  assert.equal(poisoned.reconciliationOnly, undefined);
  assert.equal(poisoned.legacy, undefined);
  assert.equal(poisoned.staleAtRecord, undefined);
  assert.equal(poisoned.jobRole, undefined);
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  assert.equal(occupyingReview([poisoned], scope).reviewerTaskId, "grok-run");
  assert.throws(() => assertPersonaJobAvailable([poisoned], { ...scope, model: "gpt-5.6-sol", substitutionReason: "shop" }), /occupied by Grok NO_GO/);
});

test("exact-head findings stay off deep; older-head findings still travel with deep", () => {
  const older = { ...persona("structural-challenge", "grok-old", { verdict: "NO_GO", findings: ["Old defect"] }), head: "d".repeat(40) };
  assert.deepEqual(outstandingForDeep([older], claim, mrrTarget).map((item) => item.id), ["F1"]);
  const current = persona("structural-challenge", "grok-now", { verdict: "NO_GO", findings: ["Current defect"] });
  assert.deepEqual(outstandingForDeep([current], claim, mrrTarget), []);
  assert.deepEqual(outstandingFindings([current], claim).map((item) => item.id), ["F1"]);
  const sameHeadNewBase = { ...persona("structural-challenge", "grok-base", { verdict: "NO_GO", findings: ["Base moved"] }), baseHead: "e".repeat(40) };
  assert.deepEqual(outstandingForDeep([sameHeadNewBase], claim, mrrTarget).map((item) => item.id), ["F1"]);
  const claimBump = { ...persona("structural-challenge", "grok-claim", { verdict: "NO_GO", findings: ["Claim moved"] }), claimRevision: 1 };
  assert.deepEqual(outstandingForDeep([claimBump], claim, mrrTarget, 2).map((item) => item.id), ["F1"]);
});

test("court rejection is scoped to the exact head, base, claim, and claim revision", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const rejected = court("structural-challenge", "sol-court", { reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable to this claim and target." }] });
  assert.deepEqual(outstandingFindings([occupant, rejected], claim, mrrTarget, 1), []);
  assert.deepEqual(outstandingFindings([occupant, rejected], claim, { head: "d".repeat(40), baseHead }, 1).map((item) => item.id), ["F1"]);
  assert.deepEqual(outstandingFindings([occupant, rejected], claim, { head, baseHead: "e".repeat(40) }, 1).map((item) => item.id), ["F1"]);
  assert.deepEqual(outstandingFindings([occupant, rejected], claim, mrrTarget, 2).map((item) => item.id), ["F1"]);
  assert.deepEqual(outstandingForDeep([occupant, rejected], claim, { head: "d".repeat(40), baseHead }, 1).map((item) => item.id), ["F1"]);
});

test("court can adjudicate a still_present-only occupant packet", () => {
  const older = { ...persona("structural-challenge", "grok-old", { verdict: "NO_GO", findings: ["Old defect"] }), head: "d".repeat(40) };
  const deep = persona("deep-code-review", "sol-run", { verdict: "NO_GO", findings: [], reconciled: [{ findingId: "F1", disposition: "still_present", rationale: "The defect remains on this target." }] });
  const reviews = [older, deep];
  assert.deepEqual(occupantPacket(reviews, deep).map((item) => item.id), ["F1"]);
  assert.doesNotThrow(() => assertCourtJobAvailable(reviews, { jobRole: "deep-code-review", target: mrrTarget, claim, claimRevision: 1, model: "grok-4.6" }));
});

test("historical reconciliationOnly on a persona does not hide occupancy or the ledger", () => {
  const occupant = { ...persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] }), reconciliationOnly: true };
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  assert.equal(isCourtReview(occupant), false);
  assert.equal(occupyingReview([occupant], scope).reviewerTaskId, "grok-run");
  assert.deepEqual(outstandingFindings([occupant], claim).map((item) => item.id), ["F1"]);
});

test("READY refuses a court whose brief-time owner is the court reviewer", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const rejected = { ...court("structural-challenge", "sol-court", { reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable." }] }), ownerTaskIdAtBrief: "sol-court" };
  const reviews = [persona("deep-code-review", "sol-run"), occupant, rejected, persona("structural-challenge", "grok-rerun"), persona("fable-challenge", "fable-run")];
  const gate = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews });
  assert.equal(gate.ready, false);
  assert.match(gate.reasons.join(" "), /Court reviewer was the workstream owner when its review brief was created/);
});

test("an authorized rerun must be recorded after the court", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const premature = persona("structural-challenge", "grok-early");
  const rejected = court("structural-challenge", "sol-court", { reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable." }] });
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  const reviews = [occupant, premature, rejected];
  assert.equal(occupyingReview(reviews, scope).reviewerTaskId, "grok-run");
});

test("a court rerun must come from a brief created after the court", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const rejected = { ...court("structural-challenge", "sol-court", { reconciled: [{ findingId: "F1", disposition: "rejected", rationale: "Inapplicable." }] }), recordedAt: "2026-01-01T02:00:00.000Z" };
  const withheld = { ...persona("structural-challenge", "grok-withheld"), recordedAt: "2026-01-01T03:00:00.000Z" };
  const fresh = { ...persona("structural-challenge", "grok-rerun"), recordedAt: "2026-01-01T04:00:00.000Z" };
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  const withheldDelegation = { id: withheld.delegationId, event: "created", createdAt: "2026-01-01T01:00:00.000Z" };
  const freshDelegation = { id: fresh.delegationId, event: "created", createdAt: "2026-01-01T03:30:00.000Z" };
  assert.equal(occupyingReview([occupant, rejected, withheld], scope, [withheldDelegation]).reviewerTaskId, "grok-run");
  assert.throws(
    () => assertPersonaJobAvailable([occupant, rejected], { ...scope, model: "grok-4.6", currentDelegation: withheldDelegation, delegations: [withheldDelegation] }),
    /brief created after the court/
  );
  assert.equal(occupyingReview([occupant, rejected, withheld, fresh], scope, [withheldDelegation, freshDelegation]).reviewerTaskId, "grok-rerun");
  assert.doesNotThrow(() => assertPersonaJobAvailable([occupant, rejected], { ...scope, model: "grok-4.6" }));
  const rebound = { ...persona("structural-challenge", "grok-run"), recordedAt: "2026-01-01T04:00:00.000Z" };
  const reboundDelegation = { id: rebound.delegationId, event: "created", createdAt: "2026-01-01T03:30:00.000Z" };
  assert.equal(occupyingReview([occupant, rejected, rebound], scope, [reboundDelegation]).reviewerTaskId, "grok-run");
  assert.throws(
    () => assertPersonaJobAvailable([occupant, rejected], { ...scope, model: "grok-4.6", reviewerTaskId: "grok-run", currentDelegation: reboundDelegation, delegations: [reboundDelegation] }),
    /pre-court reviewer task ID/
  );
});

test("GO cannot carry findings, unresolved items, or still_present", () => {
  const d = mrrDelegation("structural-challenge");
  assert.throws(() => validateReview(envelope(d, "grok-go", { findings: ["Gap"] }), d), /GO cannot carry findings/);
  assert.throws(() => validateReview(envelope(d, "grok-go", { unresolved: ["Open question"] }), d), /GO cannot carry/);
  assert.throws(
    () => validateReview(envelope(d, "grok-go", { reconciled: [{ findingId: "F1", disposition: "still_present", rationale: "Remains." }] }), d),
    /GO cannot carry/
  );
});

test("court authorizes a rerun against the outstanding occupant packet it briefed", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound A", "Unsound B"] });
  const later = { ...persona("deep-code-review", "sol-later", { reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "Fixed on a later head." }] }), head: "d".repeat(40) };
  const beforeCourt = [occupant, later];
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  assert.deepEqual(outstandingOccupantPacket(beforeCourt, occupant, claim).map((item) => item.id), ["F2"]);
  const rejected = court("structural-challenge", "sol-court", { reconciled: [{ findingId: "F2", disposition: "rejected", rationale: "Inapplicable." }] });
  const reviews = [...beforeCourt, rejected];
  assert.doesNotThrow(() => assertPersonaJobAvailable(reviews, { ...scope, model: "grok-4.6" }));
  const rerun = persona("structural-challenge", "grok-rerun");
  assert.equal(occupyingReview([...reviews, rerun], scope).reviewerTaskId, "grok-rerun");
});

test("a still_present court cannot reopen a rerun after a later resolve", () => {
  const occupant = persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] });
  const still = court("structural-challenge", "sol-court", { verdict: "NO_GO", reconciled: [{ findingId: "F1", disposition: "still_present", rationale: "The defect remains." }] });
  const later = { ...persona("deep-code-review", "sol-later", { reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "Fixed on a later head." }] }), head: "d".repeat(40) };
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  assert.throws(
    () => assertPersonaJobAvailable([occupant, still, later], { ...scope, model: "grok-4.6" }),
    /already had its one court/
  );
});

test("a stale adverse envelope occupies again when the exact target returns", () => {
  const occupant = { ...persona("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] }), staleAtRecord: true };
  const scope = { role: "structural-challenge", target: mrrTarget, claim, claimRevision: 1 };
  assert.equal(occupyingReview([occupant], scope).reviewerTaskId, "grok-run");
  assert.doesNotThrow(() => assertCourtJobAvailable([occupant], { jobRole: "structural-challenge", target: mrrTarget, claim, claimRevision: 1, model: "gpt-5.6-sol" }));
  assert.equal(occupyingReview([occupant], { ...scope, target: { head: "d".repeat(40), baseHead } }), null);
});
