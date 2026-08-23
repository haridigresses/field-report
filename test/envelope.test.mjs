import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvelope } from "../src/envelope.mjs";

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

test("parseEnvelope rejects non-objects", () => {
  assert.throws(() => parseEnvelope("[]"), /JSON object/);
  assert.throws(() => parseEnvelope("not json"), /JSON object/);
});
