import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRelease } from "../src/release.mjs";

const head = "abcdef1234567890abcdef1234567890abcdef12";

function pass(role, model, reviewerId, extra = {}) {
  return {
    at: "2026-07-25T18:00:00.000Z",
    actor: role,
    metadata: { head, reviewer: role, reviewerId, model, verdict: "GO", reviewRole: role, reviewComplete: true, independent: true, unresolved: [], orchestratorAtReview: null, ...extra }
  };
}

function fullFleet() {
  return [
    pass("deep-code-review", "gpt-5.6-sol", "019f0000-0000-7000-8000-000000000101", { provider: "openai", reviewerIdentityVerified: true }),
    pass("structural-challenge", "gpt-5.6-sol", "019f0000-0000-7000-8000-000000000102", { provider: "openai", reviewerIdentityVerified: true }),
    pass("structural-challenge", "anthropic.claude-fable-5", "019f0000-0000-7000-8000-000000000103", { provider: "anthropic", route: "claude-aws", provenanceVerified: true, evidenceDigest: "a".repeat(64) })
  ];
}

function candidate(overrides = {}) {
  return {
    stream: {
      branch: "codex/sample",
      prs: [{ number: 42 }],
      reviewPasses: fullFleet()
    },
    checkout: { branch: "codex/sample", head },
    remoteHead: head,
    pr: { number: 42, state: "OPEN", isDraft: true, headRefName: "codex/sample", headRefOid: head },
    ...overrides
  };
}

test("release check accepts exact live heads with complete MRR", () => {
  const result = evaluateRelease(candidate());
  assert.equal(result.ready, true);
  assert.equal(result.reasons.length, 0);
});

test("release check rejects a PR already marked ready", () => {
  const result = evaluateRelease(candidate({ pr: { number: 42, state: "OPEN", isDraft: false, headRefName: "codex/sample", headRefOid: head } }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /already marked ready/);
});

test("release check rejects a pushed head without fresh exact-head review", () => {
  const nextHead = "1234567890abcdef1234567890abcdef12345678";
  const result = evaluateRelease(candidate({
    checkout: { branch: "codex/sample", head: nextHead },
    remoteHead: nextHead,
    pr: { number: 42, state: "OPEN", isDraft: true, headRefName: "codex/sample", headRefOid: nextHead }
  }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /MRR: missing completed deep-code-review/);
  assert.match(result.reasons.join(" "), /MRR: missing completed structural-challenge/);
});

test("release check rejects mismatched checkout, remote, and PR heads", () => {
  const other = "1234567890abcdef1234567890abcdef12345678";
  const result = evaluateRelease(candidate({ remoteHead: other }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /checkout head .* does not match remote head/);
  assert.match(result.reasons.join(" "), /PR #42 head .* does not match remote head/);
});

test("release check rejects an uncommitted checkout", () => {
  const result = evaluateRelease(candidate({ checkout: { branch: "codex/sample", head, dirty: true } }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /checkout has uncommitted changes/);
});

test("release check rejects stale MRR even when all delivery heads agree", () => {
  const stale = "1234567890abcdef1234567890abcdef12345678";
  const result = evaluateRelease(candidate({
    mrr: { required: true, ready: true, head: stale, reasons: [], lanes: {} }
  }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /MRR reviewed head .* does not match remote head/);
});

test("release check rejects PR-backed work classified as non-code", () => {
  const result = evaluateRelease(candidate({ stream: { branch: null, prs: [], commits: [], reviewPasses: [] } }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /must use a code workstream/);
});

test("release check rejects a publication hold", () => {
  const result = evaluateRelease(candidate({ stream: { ...candidate().stream, publicationHold: { reason: "visual proof missing" } } }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /visual proof missing/);
});

test("release check rejects duplicate PR ownership", () => {
  const result = evaluateRelease(candidate({ prOwners: ["one", "two"] }));
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(" "), /multiple workstreams/);
});
