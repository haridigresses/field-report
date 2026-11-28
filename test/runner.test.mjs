import "./support/seats.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPrompt, executeRoleReview } from "../src/runner.mjs";

const target = {
  kind: "mrr",
  branch: "feat/x",
  head: "a".repeat(40),
  baseHead: "b".repeat(40),
  repoRoot: "/tmp"
};
const inventory = { files: ["src/a.mjs"], additions: 10, deletions: 2 };

test("buildReviewPrompt keeps correctness and design blind to session prompts while separating intent provenance", () => {
  const userContract = { text: "### VERBATIM USER PROMPTS\nSecret prompt text" };
  const builderRationale = "Commit log: touched src/a.mjs for lock ordering";

  const correctnessPrompt = buildReviewPrompt({
    brief: { id: "11111111-1111-1111-1111-111111111111", kind: "mrr", role: "correctness", branch: "feat/x", head: target.head, baseHead: target.baseHead, model: "gpt-6-astra" },
    target,
    inventory,
    userContract,
    builderRationale
  });
  assert.doesNotMatch(correctnessPrompt, /Secret prompt text/);
  assert.doesNotMatch(correctnessPrompt, /USER CONTRACT/);

  const intentPrompt = buildReviewPrompt({
    brief: { id: "22222222-2222-2222-2222-222222222222", kind: "mrr", role: "intent", branch: "feat/x", head: target.head, baseHead: target.baseHead, model: "claude-opus-5-5" },
    target,
    inventory,
    userContract,
    builderRationale
  });
  assert.match(intentPrompt, /## USER CONTRACT/);
  assert.match(intentPrompt, /Secret prompt text/);
  assert.match(intentPrompt, /## BUILDER TECHNICAL RATIONALE/);
  assert.match(intentPrompt, /touched src\/a\.mjs/);
});

test("executeRoleReview falls back on start failure (e.g. out of credits), but NEVER shops after a valid NO_GO", async () => {
  const warnings = [];
  let calls = 0;
  const candidates = [
    { id: "gpt-6-astra", launch: "claude", cliModel: "gpt-6-astra" },
    { id: "gpt-5.6-sol", launch: "claude", cliModel: "gpt-5.6-sol" }
  ];
  const seatModels = candidates.map((c) => c.id);

  // Case 1: First model fails to start (exit 1, out of credits) -> falls back to second model (NO_GO), and stops!
  const { review } = await executeRoleReview({
    kind: "mrr",
    role: "correctness",
    target,
    inventory,
    candidates,
    seatModels,
    onWarn: (msg) => warnings.push(msg),
    runShell: async (cmd) => {
      calls += 1;
      if (cmd.includes("gpt-6-astra")) {
        return { code: 1, stdout: "", stderr: "Error: workspace out of credits" };
      }
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          reviewComplete: true,
          independent: true,
          verdict: "NO_GO",
          findings: ["Null dereference on line 12"],
          unresolved: [],
          summary: "Found bug.",
          scores: { mergeReadiness: 40, structuralRisk: 60, implementationQuality: 50, evidenceConfidence: 90, outcomeConfidence: 70 },
          scoreRationale: { mergeReadiness: "r", structuralRisk: "r", implementationQuality: "r", evidenceConfidence: "r", outcomeConfidence: "r" },
          necessity: "necessary",
          simplerPath: "None.",
          scopeDrift: "none",
          contractIntegrity: "mixed",
          evidenceQuality: "strong"
        })
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /out of credits.*trying fallback gpt-5\.6-sol/);
  assert.equal(review.model, "gpt-5.6-sol");
  assert.equal(review.verdict, "NO_GO");

  // Case 2: First model returns a valid NO_GO -> settles immediately without calling fallback!
  let secondCalls = 0;
  const settledFirst = await executeRoleReview({
    kind: "mrr",
    role: "correctness",
    target,
    inventory,
    candidates,
    seatModels,
    runShell: async () => {
      secondCalls += 1;
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          reviewComplete: true,
          independent: true,
          verdict: "NO_GO",
          findings: ["Real defect"],
          unresolved: [],
          summary: "Blocked.",
          scores: { mergeReadiness: 30, structuralRisk: 70, implementationQuality: 50, evidenceConfidence: 90, outcomeConfidence: 60 },
          scoreRationale: { mergeReadiness: "r", structuralRisk: "r", implementationQuality: "r", evidenceConfidence: "r", outcomeConfidence: "r" },
          necessity: "necessary",
          simplerPath: "None.",
          scopeDrift: "none",
          contractIntegrity: "broken",
          evidenceQuality: "strong"
        })
      };
    }
  });
  assert.equal(secondCalls, 1, "must not shop to fallback model after a valid NO_GO");
  assert.equal(settledFirst.review.model, "gpt-6-astra");

  // Case 3: First model exits 0 with a malformed envelope -> throws immediately instead of shopping to fallback!
  let malformedCalls = 0;
  await assert.rejects(
    executeRoleReview({
      kind: "mrr",
      role: "correctness",
      target,
      inventory,
      candidates,
      seatModels,
      runShell: async () => {
        malformedCalls += 1;
        return { code: 0, stderr: "", stdout: "{\"verdict\":\"NO_GO\",\"broken\":true}" };
      }
    }),
    /returned an invalid review envelope/
  );
  assert.equal(malformedCalls, 1, "malformed exit-0 output must NEVER fall back to a second model");
});
