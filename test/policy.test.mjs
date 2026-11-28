import "./support/seats.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertSeatOpen,
  botsReasons,
  evaluateMrrGate,
  findingLedger,
  NO_GITHUB_CHECKS_REASON,
  openReasons,
  renderFieldReportMarkdown,
  REVIEW_ROLES,
  seatingFor,
  validateReview
} from "../src/policy.mjs";
import { normalizeId, seatFor } from "../src/seats.mjs";

const head = "a".repeat(40), baseHead = "b".repeat(40), older = "d".repeat(40);
const branch = "feat/gate";
const target = { branch, head, baseHead };
const defaults = { correctness: "gpt-6-astra", design: "grok-4.6", intent: "claude-opus-5-5" };

function makeBrief(role, sha = head, extras = {}) {
  return {
    id: randomUUID(),
    kind: "mrr",
    role,
    branch,
    head: sha,
    baseHead,
    model: extras.model || defaults[role],
    seatModels: extras.seatModels || seatFor(role).models.map((m) => m.id),
    route: extras.route || "cli"
  };
}

function makeMrr(role, extras = {}) {
  const brief = extras.brief || makeBrief(role, extras.head || head, extras);
  return validateReview({
    reviewComplete: true,
    independent: true,
    runId: brief.id,
    kind: "mrr",
    role,
    branch,
    head: brief.head,
    baseHead,
    model: extras.model || brief.model,
    route: brief.route,
    verdict: extras.verdict || "GO",
    findings: extras.findings || [],
    unresolved: extras.unresolved || [],
    ...(extras.questions ? { questions: extras.questions } : {}),
    summary: extras.summary || "Reviewed.",
    ...(role === "intent" ? { intentSummary: extras.intentSummary ?? "Goal: gate non-draft PRs." } : {}),
    scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 88, evidenceConfidence: 92, outcomeConfidence: 91 },
    scoreRationale: { mergeReadiness: "r", structuralRisk: "r", implementationQuality: "r", evidenceConfidence: "r", outcomeConfidence: "r" },
    necessity: "necessary",
    simplerPath: "None.",
    scopeDrift: "none",
    contractIntegrity: "sound",
    evidenceQuality: "strong"
  }, brief);
}

test("normalizeId strips cursor- prefix and effort variants", () => {
  assert.equal(normalizeId("cursor-grok-4.6-high-fast"), "grok-4.6");
  assert.equal(normalizeId("claude-fable-5-1-thinking-high"), "claude-fable-5-1");
  assert.equal(normalizeId("gemini-4-neon-high"), "gemini-4-neon");
  assert.equal(seatingFor("correctness").model, "gpt-6-astra");
});

test("intent seat requires intentSummary playback and MRR requires all three seats", () => {
  const brief = makeBrief("intent");
  assert.throws(() => makeMrr("intent", { brief, intentSummary: "   " }), /requires a nonblank intentSummary/);

  const reviews = REVIEW_ROLES.map((role) => makeMrr(role));
  const gate = evaluateMrrGate({ target, reviews });
  assert.equal(gate.ready, true);
  assert.equal(gate.intentSummary, "Goal: gate non-draft PRs.");

  const partial = evaluateMrrGate({ target, reviews: reviews.slice(0, 2) });
  assert.equal(partial.ready, false);
  assert.match(partial.reasons.join(" "), /missing intent review/);
});

test("carried GOs carry forward across commits and only failing seats rerun", () => {
  const before = [
    makeMrr("correctness", { head: older }),
    makeMrr("design", { head: older, verdict: "NO_GO", findings: ["Boundary leak"] }),
    makeMrr("intent", { head: older })
  ];
  const ancestors = new Map([[head, 0], [older, 1]]);
  const blocked = evaluateMrrGate({ target, reviews: before, ancestors });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join(" "), /design NO_GO at dddddddddddd; rerun fr mrr --seat design after fixing: F1: Boundary leak/);

  const afterFix = [...before, makeMrr("design", { head })];
  const ready = evaluateMrrGate({ target, reviews: afterFix, ancestors });
  assert.equal(ready.ready, true);
  assert.equal(ready.notes.length, 2);
  assert.match(ready.notes[0], /correctness: GO at dddddddddddd carried \(1 unreviewed commit/);
});

test("anti-shopping blocks second review on same head; user acceptance clears NO_GO findings", () => {
  const reviews = [
    makeMrr("correctness"),
    makeMrr("design", { verdict: "NO_GO", findings: ["Edge A", "Edge B"] }),
    makeMrr("intent", { questions: ["Allow custom port?"] })
  ];
  assert.equal(findingLedger(reviews).length, 2);
  assert.throws(() => assertSeatOpen(reviews, { role: "design", target }), /already reviewed head aaaaaaaaaaaa \(NO_GO\)/);

  const accepted = evaluateMrrGate({
    target,
    reviews,
    dispositions: [
      { findingId: "F1", actor: "user", reason: "Safe fallback" },
      { findingId: "F2", actor: "user", reason: "Out of scope" }
    ]
  });
  assert.equal(accepted.ready, true);
  assert.match(accepted.notes.join(" | "), /intent asks the user: Allow custom port\?/);
  const md = renderFieldReportMarkdown({ project: { id: "fr", label: "Field Report" }, branch, target, gate: accepted });
  assert.match(md, /## Intent Playback/);
  assert.match(md, /Accepted \(F1 by user\)/);
});

test("botsReasons distinguishes bot silent-resolve, unanswered human threads, and already-replied human threads", () => {
  const basePr = {
    number: 50,
    state: "OPEN",
    isDraft: false,
    headRefOid: head,
    headRefName: branch,
    baseRefName: "main",
    statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }]
  };
  assert.deepEqual(botsReasons({ project: { baseBranch: "main" }, checkout: { dirty: false, head }, target, pr: { ...basePr, statusCheckRollup: [], reviewThreads: [] } }), [NO_GITHUB_CHECKS_REASON]);
  assert.match(openReasons({ checkout: { dirty: true, head }, target }).join(" "), /uncommitted changes/);

  const reasons = botsReasons({
    project: { baseBranch: "main" },
    checkout: { dirty: false, head },
    target,
    pr: {
      ...basePr,
      reviewThreads: [
        { resolved: false, openerType: "Bot", path: "src/a.mjs", line: 10, author: "codex-bot[bot]", viewerRepliedLast: false, body: "Nitpick" },
        { resolved: false, openerType: "User", path: "src/b.mjs", line: 20, author: "alice", viewerRepliedLast: true, body: "Why this?" },
        { resolved: false, openerType: "User", path: "src/c.mjs", line: 30, author: "bob", viewerRepliedLast: false, body: "Please check" }
      ]
    }
  });
  assert.equal(reasons.length, 3);
  assert.match(reasons[0], /1 unresolved bot thread \(fix in code and resolve silently/);
  assert.match(reasons[1], /1 unresolved human thread \(fix or reply once concisely/);
  assert.match(reasons[2], /1 human thread awaiting human resolution \(already replied — do NOT comment again\)/);
});
