import assert from "node:assert/strict";
import test from "node:test";
import { classifyPullRequests } from "../src/prs.mjs";

test("new open PR on the workstream branch supersedes a closed predecessor", () => {
  const result = classifyPullRequests([
    { number: 10, state: "CLOSED", headRefName: "feature", updatedAt: "2026-07-10T00:00:00Z" },
    { number: 12, state: "OPEN", headRefName: "feature", updatedAt: "2026-07-12T00:00:00Z" }
  ], "feature");
  assert.equal(result[0].number, 12);
  assert.equal(result[0].relation, "current");
  assert.equal(result[1].relation, "superseded");
});

test("another open PR on a distinct branch remains active, not deprecated", () => {
  const result = classifyPullRequests([
    { number: 20, state: "OPEN", headRefName: "integration", updatedAt: "2026-07-12T00:00:00Z" },
    { number: 19, state: "OPEN", headRefName: "foundation", updatedAt: "2026-07-11T00:00:00Z" }
  ], "integration");
  assert.deepEqual(result.map((pr) => [pr.number, pr.relation]), [[20, "current"], [19, "active"]]);
});

test("merged delivery with no replacement remains past evidence", () => {
  const result = classifyPullRequests([{ number: 30, state: "MERGED", headRefName: "done", updatedAt: "2026-07-12T00:00:00Z" }], "done");
  assert.equal(result[0].relation, "past");
  assert.equal(result[0].current, false);
});
