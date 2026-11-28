import "./support/seats.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReview, parseEnvelope } from "../src/envelope.mjs";

const review = { reviewComplete: true, runId: "11111111-1111-1111-1111-111111111111", verdict: "GO" };

test("parseEnvelope accepts plain, fenced, Claude, Cursor stream-json, and Agy JSON wrappers", () => {
  assert.deepEqual(parseEnvelope(JSON.stringify(review)), review);
  assert.deepEqual(parseEnvelope(`Here:\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\`\n`), review);
  assert.deepEqual(parseEnvelope(JSON.stringify({ is_error: false, subtype: "success", result: JSON.stringify(review) })), review);
  assert.deepEqual(parseEnvelope(JSON.stringify({ is_error: false, subtype: "success", result: review })), review);
  const cursorStream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(review) })
  ].join("\n");
  assert.deepEqual(parseEnvelope(cursorStream), review);
  assert.deepEqual(parseEnvelope(JSON.stringify({ status: "SUCCESS", response: `\`\`\`json\n${JSON.stringify(review)}\n\`\`\`` })), review);
});

test("parseEnvelope does not unwrap failed Claude, Cursor, or Agy wrappers", () => {
  const badClaude = { is_error: true, subtype: "error", result: JSON.stringify(review) };
  assert.deepEqual(parseEnvelope(JSON.stringify(badClaude)), badClaude);
  const badCursor = { type: "result", subtype: "error", is_error: true, result: JSON.stringify(review) };
  assert.deepEqual(parseEnvelope(JSON.stringify(badCursor)), badCursor);
  const badAgy = { status: "ERROR", response: JSON.stringify(review) };
  assert.deepEqual(parseEnvelope(JSON.stringify(badAgy)), badAgy);
});

const brief = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "mrr",
  role: "intent",
  branch: "feat/x",
  head: "a".repeat(40),
  baseHead: "b".repeat(40),
  model: "claude-opus-5-5",
  seatModels: ["claude-opus-5-5"],
  route: "cli"
};

test("normalizeReview fills omitted identity, maps delegationId alias, and normalizes lists", () => {
  const input = {
    reviewComplete: true,
    independent: true,
    delegationId: brief.id,
    verdict: "NO_GO",
    findings: [{ text: "Unrequested scope" }],
    unresolved: ["Missing test"],
    questions: [{ question: "Allow draft?" }],
    intentSummary: "  Goal: ship x  ",
    summary: "Needs trim"
  };
  const normalized = normalizeReview(input, brief, "cli:claude:1");
  assert.equal(normalized.runId, brief.id);
  assert.equal("delegationId" in normalized, false);
  assert.equal(normalized.branch, "feat/x");
  assert.equal(normalized.intentSummary, "Goal: ship x");
  assert.deepEqual(normalized.findings, ["Unrequested scope"]);
  assert.deepEqual(normalized.questions, ["Allow draft?"]);
});

test("normalizeReview rejects conflicting identity or malformed finding items", () => {
  for (const key of ["runId", "kind", "role", "branch", "head", "baseHead", "model", "route"]) {
    assert.throws(() => normalizeReview({ [key]: "wrong", findings: [] }, brief), new RegExp(key));
  }
  assert.throws(() => normalizeReview({ findings: [{ detail: "bad" }] }, brief), /findings items/);
});
