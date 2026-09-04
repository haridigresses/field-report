import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvelope, normalizeReview } from "../src/envelope.mjs";

const review = { reviewComplete: true, delegationId: "11111111-1111-1111-1111-111111111111", verdict: "GO" };

test("parseEnvelope accepts a plain JSON object", () => {
  assert.deepEqual(parseEnvelope(JSON.stringify(review)), review);
});

test("parseEnvelope accepts one fenced JSON object", () => {
  assert.deepEqual(parseEnvelope(`Here is the review:\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\`\n`), review);
});

test("parseEnvelope accepts a Claude CLI result string", () => {
  const wrapper = { is_error: false, subtype: "success", result: JSON.stringify(review) };
  assert.deepEqual(parseEnvelope(JSON.stringify(wrapper)), review);
});

test("parseEnvelope accepts a Claude CLI result object", () => {
  const wrapper = { is_error: false, subtype: "success", result: review };
  assert.deepEqual(parseEnvelope(JSON.stringify(wrapper)), review);
});

test("parseEnvelope does not unwrap a failed Claude CLI wrapper", () => {
  const wrapper = { is_error: true, subtype: "error", result: JSON.stringify(review) };
  assert.deepEqual(parseEnvelope(JSON.stringify(wrapper)), wrapper);
});

test("parseEnvelope does not unwrap a wrapper missing the success contract", () => {
  const wrapper = { result: JSON.stringify(review) };
  assert.deepEqual(parseEnvelope(JSON.stringify(wrapper)), wrapper);
});

test("parseEnvelope does not unwrap a successful wrapper with an empty result", () => {
  const wrapper = { is_error: false, subtype: "success", result: "  " };
  assert.deepEqual(parseEnvelope(JSON.stringify(wrapper)), wrapper);
});

test("parseEnvelope accepts a Cursor CLI stream-json result line", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(review) })
  ].join("\n");
  assert.deepEqual(parseEnvelope(stream), review);
});

test("parseEnvelope does not unwrap a failed Cursor result wrapper", () => {
  const wrapper = { type: "result", subtype: "error", is_error: true, result: JSON.stringify(review) };
  assert.deepEqual(parseEnvelope(JSON.stringify(wrapper)), wrapper);
});

test("parseEnvelope does not unwrap a Cursor result missing is_error", () => {
  const wrapper = { type: "result", subtype: "success", result: JSON.stringify(review) };
  assert.deepEqual(parseEnvelope(JSON.stringify(wrapper)), wrapper);
});

test("parseEnvelope does not unwrap a Cursor result missing subtype", () => {
  const wrapper = { type: "result", is_error: false, result: JSON.stringify(review) };
  assert.deepEqual(parseEnvelope(JSON.stringify(wrapper)), wrapper);
});

test("parseEnvelope extracts a JSON object after wrapper preamble", () => {
  const wrapper = { is_error: false, subtype: "success", result: `Sure.\n${JSON.stringify(review)}` };
  assert.deepEqual(parseEnvelope(JSON.stringify(wrapper)), review);
});

test("normalizeReview pins identity from the brief", () => {
  const delegation = {
    id: "11111111-1111-1111-1111-111111111111",
    kind: "crr",
    role: "crr",
    claim: "Seat the three personas.",
    head: "a".repeat(40),
    baseHead: "b".repeat(40),
    tree: "c".repeat(40),
    model: "composer-2",
    route: "native"
  };
  const normalized = normalizeReview({
    reviewComplete: true,
    independent: true,
    delegationId: "22222222-2222-2222-2222-222222222222",
    claim: "Seat the three personas. Extra sentence.",
    kind: "mrr",
    role: "fable-challenge",
    head: "d".repeat(40),
    baseHead: "e".repeat(40),
    findings: [{ text: " " }, "Real defect"],
    unresolved: [],
    reconciled: [{ id: "F9", disposition: "resolved", rationale: "Fixed." }]
  }, delegation);
  assert.equal(normalized.delegationId, delegation.id);
  assert.equal(normalized.kind, "crr");
  assert.equal(normalized.role, "crr");
  assert.equal(normalized.claim, delegation.claim);
  assert.equal(normalized.head, delegation.head);
  assert.equal(normalized.tree, delegation.tree);
  assert.deepEqual(normalized.findings, ["Real defect"]);
  assert.equal(normalized.reconciled[0].findingId, "F9");
});

test("normalizeReview takes occupancy flags from the brief, not the envelope", () => {
  const persona = normalizeReview({
    reconciliationOnly: true, jobRole: "deep-code-review", legacy: true, staleAtRecord: true, findings: [], unresolved: []
  }, {
    id: "11111111-1111-1111-1111-111111111111", kind: "mrr", role: "structural-challenge",
    claim: "Claim", head: "a".repeat(40), baseHead: "b".repeat(40), model: "grok-4.6", route: "cli"
  });
  assert.equal("reconciliationOnly" in persona, false);
  assert.equal("jobRole" in persona, false);
  assert.equal("legacy" in persona, false);
  assert.equal("staleAtRecord" in persona, false);
  const court = normalizeReview({ findings: [], unresolved: [] }, {
    id: "11111111-1111-1111-1111-111111111111", kind: "mrr", role: "reconciliation", reconciliationOnly: true, jobRole: "structural-challenge",
    claim: "Claim", head: "a".repeat(40), baseHead: "b".repeat(40), model: "gpt-5.6-sol", route: "cli"
  });
  assert.equal(court.reconciliationOnly, true);
  assert.equal(court.jobRole, "structural-challenge");
});

test("normalizeReview takes substitutionReason from the brief, not the envelope", () => {
  const invented = normalizeReview({
    substitutionReason: "invented", findings: [], unresolved: []
  }, {
    id: "11111111-1111-1111-1111-111111111111", kind: "mrr", role: "structural-challenge",
    claim: "Claim", head: "a".repeat(40), baseHead: "b".repeat(40), model: "gpt-5.6-sol", route: "cli"
  });
  assert.equal("substitutionReason" in invented, false);
  const attested = normalizeReview({ findings: [], unresolved: [] }, {
    id: "11111111-1111-1111-1111-111111111111", kind: "mrr", role: "structural-challenge",
    claim: "Claim", head: "a".repeat(40), baseHead: "b".repeat(40), model: "gpt-5.6-sol", route: "cli",
    substitutionReason: "cursor-agent not on PATH"
  });
  assert.equal(attested.substitutionReason, "cursor-agent not on PATH");
});

test("normalizeReview strips staged tree from an mrr envelope", () => {
  const normalized = normalizeReview({ tree: "c".repeat(40), findings: [], unresolved: [] }, {
    id: "11111111-1111-1111-1111-111111111111", kind: "mrr", role: "structural-challenge",
    claim: "Claim", head: "a".repeat(40), baseHead: "b".repeat(40), model: "grok-4.6", route: "cli"
  });
  assert.equal(normalized.kind, "mrr");
  assert.equal("tree" in normalized, false);
});
