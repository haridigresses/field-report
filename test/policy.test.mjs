import "./support/seats.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertSeatOpen, botsReasons, CRR_ROLE, evaluateGate, findingLedger, identityKey, latestClaimReviews, NO_GITHUB_CHECKS_REASON, openReasons, REVIEW_ROLES, seatingFor, validateReview, workstreamBotsReasons } from "../src/policy.mjs";
import { normalizeReview } from "../src/envelope.mjs";
import { normalizeId, seatFor } from "../src/seats.mjs";

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
  seatModels: extras.seatModels || seatFor(role).models.map((entry) => entry.id)
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
    ...(extras.questions ? { questions: extras.questions } : {})
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

test("a supplied provider label neither fails nor gets recorded", () => {
  const astra = mrrDelegation("deep-code-review");
  const recorded = validateReview(mrrEnvelope(astra, "astra-label", { provider: "OpenAI" }), astra);
  assert.equal(recorded.verdict, "GO");
  assert.equal("provider" in recorded, false);
  const crr = crrDelegation();
  const crrRecorded = validateReview(crrEnvelope(crr, "crr-free", { provider: "OpenAI/Codex" }), crr);
  assert.equal("provider" in crrRecorded, false);
  assert.equal(crrRecorded.model, "composer-2");
});

test("model ids strip Cursor prefixes and effort variants", () => {
  assert.equal(normalizeId("cursor-grok-4.6-high"), "grok-4.6");
  assert.equal(normalizeId("cursor-grok-4.6-high-fast"), "grok-4.6");
  assert.equal(normalizeId("claude-opus-5-5-medium"), "claude-opus-5-5");
  assert.equal(normalizeId("claude-fable-5-1-thinking-high"), "claude-fable-5-1");
  assert.equal(normalizeId("gpt-5.6-sol-medium"), "gpt-5.6-sol");
  assert.equal(normalizeId("gemini-4-neon-high"), "gemini-4-neon");
  assert.equal(normalizeId("composer-2"), "composer-2");
  assert.equal(normalizeId("grok 4.6"), null);
});

test("crr seating accepts local models; mrr seating takes only the seat's listed models", () => {
  assert.equal(seatingFor(CRR_ROLE).model, "local");
  assert.equal(seatingFor(CRR_ROLE, "composer-2").model, "composer-2");
  assert.equal(seatingFor("deep-code-review").model, "gpt-6-astra");
  assert.deepEqual(seatingFor("deep-code-review").seatModels, ["gpt-6-astra", "gpt-5.6-sol"]);
  assert.equal(seatingFor("structural-challenge", "cursor-grok-4.6-high").model, "grok-4.6");
  const fable = seatingFor("fable-challenge", "claude-fable-5");
  assert.deepEqual([fable.model, fable.intended], ["claude-fable-5", "claude-opus-5-5"]);
  assert.throws(() => seatingFor("fable-challenge", "claude-sonnet-5"), /claude-sonnet-5 is not a valid fable-challenge model \(valid: claude-opus-5-5, claude-fable-5-1, claude-fable-5\)\. Add it to seats\.fable-challenge\.models/);
  assert.throws(() => seatingFor("fable-challenge", "gpt-6-astra"), /not a valid fable-challenge model/);
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

test("crr findings do not enter the MRR finding ledger", () => {
  const crr = crrComplete("crr-1", { verdict: "NO_GO", findings: ["Gap in tests"] });
  const mrr = mrrComplete("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Authority boundary is unsound"] });
  assert.deepEqual(findingLedger([crr, mrr]).map((item) => [item.id, item.role]), [["F1", "structural-challenge"]]);
});

test("mrr gate requires a review from every seat", () => {
  const reviews = [
    mrrComplete("deep-code-review", "sol-run"),
    mrrComplete("structural-challenge", "grok-run"),
    mrrComplete("fable-challenge", "fable-run")
  ];
  assert.equal(evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews }).ready, true);
  const missing = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: reviews.slice(0, 2) });
  assert.equal(missing.ready, false);
  assert.match(missing.reasons.join(" "), /missing fable-challenge review/);
  assert.throws(() => evaluateGate({ kind: "coverage", target: mrrTarget, workstream, reviews }), /crr or mrr/);
});

test("a review counts only when its model is on the list its brief pinned", () => {
  const neon = mrrDelegation("structural-challenge", undefined, { model: "gemini-4-neon", seatModels: ["gemini-4-neon"] });
  const recorded = validateReview(mrrEnvelope(neon, "neon-run", { model: "gemini-4-neon-high" }), neon);
  assert.deepEqual([recorded.model, recorded.seatModels], ["gemini-4-neon", ["gemini-4-neon"]]);
  const others = [mrrComplete("deep-code-review", "astra-run"), mrrComplete("fable-challenge", "fable-run")];
  assert.equal(evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: [others[0], recorded, others[1]] }).ready, true);
  const grokBrief = mrrDelegation("structural-challenge");
  assert.throws(() => validateReview(mrrEnvelope(grokBrief, "swap", { model: "gpt-6-astra" }), grokBrief), /Review model must match its exact delegation/);
  const offList = { ...grokBrief, model: "gpt-6-astra" };
  assert.throws(() => validateReview(mrrEnvelope(offList, "off-list"), offList), /structural-challenge review model gpt-6-astra is not on its brief's valid list/);
});

test("one model may fill every seat when the config lists it there", () => {
  const brief = (role) => mrrDelegation(role, undefined, { model: "gemini-4-neon", seatModels: ["gemini-4-neon"] });
  const delegations = REVIEW_ROLES.map(brief);
  const reviews = delegations.map((d, i) => validateReview(mrrEnvelope(d, `neon-${i}`), d));
  assert.equal(evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews }).ready, true);
  const shared = delegations.map((d) => validateReview(mrrEnvelope(d, "neon-same"), d));
  assert.match(evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: shared }).reasons.join(" "), /distinct reviewer task IDs/);
});

const older = "d".repeat(40);
const at = (review, sha) => ({ ...review, head: sha });

test("a seat's review of an earlier head carries forward, and the gate prints the unreviewed delta", () => {
  const reviews = REVIEW_ROLES.map((role, i) => at(mrrComplete(role, `run-${i}`), older));
  const carried = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews, ancestors: new Map([[head, 0], [older, 1]]) });
  assert.equal(carried.ready, true);
  assert.equal(carried.notes.length, 3);
  assert.match(carried.notes[0], /deep-code-review: GO at dddddddddddd carried; dddddddddddd\.\.aaaaaaaaaaaa not reviewed by this seat/);
  const unrelated = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews, ancestors: new Map([[head, 0]]) });
  assert.match(unrelated.reasons.join(" "), /missing deep-code-review review/);
});

test("after a fix only the failing seat reruns", () => {
  const before = [
    at(mrrComplete("deep-code-review", "sol-run"), older),
    at(mrrComplete("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] }), older),
    at(mrrComplete("fable-challenge", "fable-run"), older)
  ];
  const ancestors = new Map([[head, 0], [older, 1]]);
  const pending = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: before, ancestors });
  assert.equal(pending.ready, false);
  assert.match(pending.reasons.join(" "), /structural-challenge NO_GO at dddddddddddd; rerun this seat after the fix: F1: Unsound boundary/);
  const rerun = [...before, mrrComplete("structural-challenge", "grok-rerun")];
  const ready = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews: rerun, ancestors });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.notes.map((note) => note.split(":")[0]), ["deep-code-review", "fable-challenge"]);
});

test("the reviewed commit nearest HEAD decides a seat, whatever order reviews were recorded in", () => {
  const middle = "e".repeat(40);
  const reviews = [
    mrrComplete("deep-code-review", "sol-run"),
    at(mrrComplete("structural-challenge", "grok-new", { verdict: "NO_GO", findings: ["Newer defect"] }), middle),
    at(mrrComplete("structural-challenge", "grok-late"), older),
    mrrComplete("fable-challenge", "fable-run")
  ];
  const gate = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews, ancestors: new Map([[head, 0], [middle, 1], [older, 2]]) });
  assert.equal(gate.ready, false);
  assert.match(gate.reasons.join(" "), /structural-challenge NO_GO at eeeeeeeeeeee; rerun this seat after the fix: F1: Newer defect/);
});

test("READY lists reviewers' open questions for the user", () => {
  const reviews = [
    mrrComplete("deep-code-review", "sol-run", { questions: ["Should old reviews be discarded?"] }),
    mrrComplete("structural-challenge", "grok-run"),
    mrrComplete("fable-challenge", "fable-run")
  ];
  const gate = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews });
  assert.equal(gate.ready, true);
  assert.deepEqual(gate.notes, ["deep-code-review asks the user: Should old reviews be discarded?"]);
});

test("a NO_GO on the exact head cannot be shopped away by another review of that head", () => {
  const reviews = [
    mrrComplete("deep-code-review", "sol-run"),
    mrrComplete("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unsound boundary"] }),
    mrrComplete("structural-challenge", "grok-again"),
    mrrComplete("fable-challenge", "fable-run")
  ];
  const gate = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews });
  assert.equal(gate.ready, false);
  assert.match(gate.reasons.join(" "), /structural-challenge NO_GO on this head; fix on a new head and rerun this seat, or record the user's acceptance/);
  const scope = { target: mrrTarget, claim, claimRevision: 1 };
  assert.throws(() => assertSeatOpen(reviews, { role: "structural-challenge", ...scope }), /already reviewed this head \(NO_GO\); fix on a new head to rerun it, or record the user's acceptance/);
  assert.throws(() => assertSeatOpen(reviews, { role: "deep-code-review", ...scope }), /already reviewed this head \(GO\); fix on a new head to rerun it$/);
  assert.doesNotThrow(() => assertSeatOpen([], { role: "deep-code-review", ...scope }));
});

test("the user's acceptance clears a finding, and READY says so", () => {
  const reviews = [
    mrrComplete("deep-code-review", "sol-run"),
    mrrComplete("structural-challenge", "grok-run", { verdict: "NO_GO", findings: ["Unlikely edge", "Real bug"] }),
    mrrComplete("fable-challenge", "fable-run")
  ];
  const accept = (findingId) => ({ findingId, actor: "user", reason: "Fails safe; not worth a fix" });
  const partial = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews, dispositions: [accept("F1")] });
  assert.equal(partial.ready, false);
  assert.match(partial.reasons.join(" "), /F2: Real bug/);
  assert.doesNotMatch(partial.reasons.join(" "), /F1/);
  const ready = evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews, dispositions: [accept("F1"), accept("F2")] });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.notes, ["structural-challenge F1 accepted by user: Fails safe; not worth a fix", "structural-challenge F2 accepted by user: Fails safe; not worth a fix"]);
});

test("editing the config later does not reinterpret recorded reviews", () => {
  const reviews = REVIEW_ROLES.map((role, i) => mrrComplete(role, `run-${i}`));
  const snapshot = JSON.stringify(reviews);
  assert.equal(evaluateGate({ kind: "mrr", target: mrrTarget, workstream, reviews }).ready, true);
  assert.equal(JSON.stringify(reviews), snapshot, "reading evidence must not rewrite history");
});

test("reviews of an earlier claim do not count for a revised claim", () => {
  const reviews = REVIEW_ROLES.map((role, i) => mrrComplete(role, `run-${i}`));
  const revised = evaluateGate({ kind: "mrr", target: mrrTarget, workstream: { ...workstream, claim: "Revised claim", claimRevision: 2 }, reviews });
  assert.equal(revised.ready, false);
  assert.match(revised.reasons.join(" "), /missing deep-code-review review/);
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

test("a verdict must match its findings; questions are recorded and reconciliations are not", () => {
  const d = mrrDelegation("deep-code-review");
  assert.throws(() => validateReview(mrrEnvelope(d, "sol-empty", { verdict: "NO_GO" }), d), /NO_GO requires at least one finding or unresolved item/);
  assert.throws(() => validateReview(mrrEnvelope(d, "sol-go", { findings: ["Bug"] }), d), /GO cannot carry findings/);
  const recorded = validateReview({ ...mrrEnvelope(d, "sol-q", { questions: ["Should old reviews be discarded?"] }), reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "x" }] }, d);
  assert.deepEqual(recorded.questions, ["Should old reviews be discarded?"]);
  assert.equal("reconciled" in recorded, false);
  assert.throws(() => validateReview(mrrEnvelope(d, "sol-bad-q", { questions: [""] }), d), /questions must be a nonblank string array/);
});

test("bots gate blocks unresolved review threads from bots and humans", () => {
  const pr = { number: 7, state: "OPEN", isDraft: false, headRefOid: head, headRefName: "feature", baseRefName: "main", statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }] };
  const base = { project: { baseBranch: "main" }, checkout: { dirty: false, head }, target: { head, branch: "feature" } };
  const reasons = botsReasons({ ...base, pr: { ...pr, reviewThreads: [
    { resolved: false, path: "src/doctor.mjs", line: 43, author: "chatgpt-codex-connector", body: "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow)</sub></sub>  Check the wrapper**\n\nDetails" },
    { resolved: true, path: "README.md", line: 5, author: "hari", body: "done" }
  ] } });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /^1 unresolved review thread; fix each or reply why not; resolve bot threads, and leave a person's thread for them to resolve: src\/doctor.mjs:43 \(chatgpt-codex-connector\) Check the wrapper$/);
  assert.deepEqual(botsReasons({ ...base, pr: { ...pr, reviewThreads: [{ resolved: true, path: "a", line: 1, author: "x", body: "y" }] } }), []);
});
