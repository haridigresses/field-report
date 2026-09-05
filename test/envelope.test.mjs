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

const delegation = {
  id: "11111111-1111-1111-1111-111111111111", kind: "crr", role: "crr",
  claim: "Seat the three personas.", head: "a".repeat(40), baseHead: "b".repeat(40),
  tree: "c".repeat(40), model: "composer-2", route: "native"
};

test("normalizeReview fills omitted identity without changing substantive evidence", () => {
  const input = { reviewComplete: true, independent: true, verdict: "NO_GO",
    findings: [{ text: "Real defect" }], unresolved: ["Could not inspect diff"],
    summary: "Limited evidence", reconciled: [{ id: "F9", disposition: "still_present", rationale: "Not fixed." }] };
  const normalized = normalizeReview(input, delegation);
  assert.equal(normalized.delegationId, delegation.id);
  assert.equal(normalized.head, delegation.head);
  assert.equal(normalized.tree, delegation.tree);
  assert.deepEqual(normalized.findings, ["Real defect"]);
  assert.deepEqual(normalized.unresolved, input.unresolved);
  assert.equal(normalized.verdict, "NO_GO");
  assert.equal(normalized.summary, input.summary);
  assert.equal(normalized.reconciled[0].findingId, "F9");
});

test("normalizeReview rejects conflicting supplied identity instead of retargeting evidence", () => {
  for (const key of ["delegationId", "kind", "role", "claim", "head", "baseHead", "tree", "model", "route"]) {
    assert.throws(() => normalizeReview({ [key]: "wrong", findings: [], unresolved: [] }, delegation), new RegExp(key));
  }
});

test("normalization cannot erase malformed findings or promote pass into GO", () => {
  for (const key of ["findings", "unresolved"]) {
    for (const value of [[{ detail: "Cannot inspect diff" }], [{ text: "Looks fine", limitation: "Cannot inspect diff" }], [null], [42], [" "]]) {
      assert.throws(() => normalizeReview({ findings: [], unresolved: [], [key]: value }, delegation));
    }
  }
  const normalized = normalizeReview({ verdict: "pass", summary: "Cannot inspect diff" }, delegation);
  assert.equal(normalized.verdict, "pass");
  assert.equal(normalized.summary, "Cannot inspect diff");
  assert.equal(normalized.findings, undefined);
  assert.notEqual(normalized.reviewComplete, true);
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
    claim: "Claim", head: "a".repeat(40), baseHead: "b".repeat(40), model: "gpt-6-astra", route: "cli"
  });
  assert.equal(court.reconciliationOnly, true);
  assert.equal(court.jobRole, "structural-challenge");
});

test("normalizeReview takes substitutionReason from the brief, not the envelope", () => {
  const invented = normalizeReview({
    substitutionReason: "invented", findings: [], unresolved: []
  }, {
    id: "11111111-1111-1111-1111-111111111111", kind: "mrr", role: "structural-challenge",
    claim: "Claim", head: "a".repeat(40), baseHead: "b".repeat(40), model: "gpt-6-astra", route: "cli"
  });
  assert.equal("substitutionReason" in invented, false);
  const attested = normalizeReview({ findings: [], unresolved: [] }, {
    id: "11111111-1111-1111-1111-111111111111", kind: "mrr", role: "structural-challenge",
    claim: "Claim", head: "a".repeat(40), baseHead: "b".repeat(40), model: "gpt-6-astra", route: "cli",
    substitutionReason: "cursor-agent not on PATH"
  });
  assert.equal(attested.substitutionReason, "cursor-agent not on PATH");
});

test("normalizeReview preserves a supplied MRR tree for validation to reject", () => {
  const normalized = normalizeReview({ tree: "c".repeat(40), findings: [], unresolved: [] }, {
    id: "11111111-1111-1111-1111-111111111111", kind: "mrr", role: "structural-challenge",
    claim: "Claim", head: "a".repeat(40), baseHead: "b".repeat(40), model: "grok-4.6", route: "cli"
  });
  assert.equal(normalized.kind, "mrr");
  assert.equal(normalized.tree, "c".repeat(40));
});
