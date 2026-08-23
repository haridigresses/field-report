import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.mjs";

test("store keeps canonical runtime state outside application source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-state-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", label: "Sample", repoPath: root });
  await store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Outcome", outcome: "Deliver it", summary: "Active" });
  const stream = await store.workstream("sample-outcome");
  assert.equal(stream.schemaVersion, 2);
  assert.equal(stream.claimRevision, 1);
  assert.equal((await store.events(stream.id)).length, 0);
  await assert.rejects(store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Duplicate", outcome: "Duplicate", summary: "Duplicate" }), /already exists/);
  const project = await store.updateProject("sample", { baseBranch: "develop" });
  assert.equal(project.baseBranch, "develop");
  assert.equal(project.revision, 2);
  const changedClaim = await store.saveWorkstream({ ...stream, claim: "A changed claim" });
  assert.equal(changedClaim.claimRevision, 2);
  const changedSummary = await store.saveWorkstream({ ...changedClaim, summary: "New status only" });
  assert.equal(changedSummary.claimRevision, 2);
});

test("store records only explicit material events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-events-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", label: "Sample", repoPath: root });
  await store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Outcome", outcome: "Deliver it", summary: "Active" }, { type: "created", text: "Created" });
  assert.deepEqual((await store.events("sample-outcome")).map((event) => event.type), ["created"]);
});

test("store rejects a stale read-modify-write instead of losing a concurrent update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-revision-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", label: "Sample", repoPath: root });
  const first = await store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Outcome", outcome: "Deliver it", summary: "Active" });
  await store.saveWorkstream({ ...first, summary: "Newer update" });
  await assert.rejects(store.saveWorkstream({ ...first, next: "Stale update" }), /changed since it was read/);
});

test("store rejects rebinding a delegation to a different task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-binding-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", label: "Sample", repoPath: root });
  await store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Outcome", outcome: "Deliver it", summary: "Active" });
  const delegation = await store.addDelegation("sample-outcome", { type: "work" });
  await store.addDelegationEvent("sample-outcome", delegation.id, { event: "bound", taskId: "task-a" });
  await store.addDelegationEvent("sample-outcome", delegation.id, { event: "bound", taskId: "task-a" });
  await assert.rejects(store.addDelegationEvent("sample-outcome", delegation.id, { event: "bound", taskId: "task-b" }), /already bound to task-a/);
});

test("store atomically records a review delegation once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-review-once-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", label: "Sample", repoPath: root });
  await store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Outcome", outcome: "Deliver it", summary: "Active" });
  const value = { delegationId: "delegation-1", verdict: "NO_GO", findings: [], unresolved: [] };
  const results = await Promise.allSettled([store.addReview("sample-outcome", value), store.addReview("sample-outcome", value)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await store.reviews("sample-outcome")).length, 1);
});

test("review failure and completion are one atomic terminal decision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-review-terminal-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", label: "Sample", repoPath: root });
  await store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Outcome", outcome: "Deliver it", summary: "Active" });
  const delegation = await store.addDelegation("sample-outcome", { type: "review" });
  await store.addDelegationEvent("sample-outcome", delegation.id, { event: "bound", taskId: "reviewer-1" });
  const results = await Promise.allSettled([
    store.addReview("sample-outcome", { delegationId: delegation.id, findings: [], unresolved: [] }),
    store.addDelegationEvent("sample-outcome", delegation.id, { event: "failed", taskId: "reviewer-1", reason: "provider failed" })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const recorded = (await store.reviews("sample-outcome")).some((review) => review.delegationId === delegation.id);
  const failed = (await store.delegations("sample-outcome")).some((event) => event.id === delegation.id && event.event === "failed");
  assert.notEqual(recorded, failed);
});

test("store rejects review recording against a concurrently changed claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-review-claim-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", label: "Sample", repoPath: root });
  const stream = await store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Outcome", outcome: "Deliver it", summary: "Active" });
  await store.saveWorkstream({ ...stream, claim: "Changed claim" });
  await assert.rejects(store.addReview("sample-outcome", { delegationId: "delegation-1", expectedClaimRevision: stream.claimRevision, findings: [], unresolved: [] }), /claim changed while the review was being recorded/);
});

test("store assigns finding IDs atomically across concurrent reviews", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-review-ids-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", label: "Sample", repoPath: root });
  await store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Outcome", outcome: "Deliver it", summary: "Active" });
  const [first, second] = await Promise.all([
    store.addReview("sample-outcome", { delegationId: "delegation-1", findings: ["First"], unresolved: [] }),
    store.addReview("sample-outcome", { delegationId: "delegation-2", findings: ["Second"], unresolved: [] })
  ]);
  assert.deepEqual(new Set([...first.assignedFindingIds, ...second.assignedFindingIds]), new Set(["F1", "F2"]));
});

test("store aborts a review when pre-append target validation fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-review-target-"));
  const store = createStore(root);
  await store.saveProject({ id: "sample", label: "Sample", repoPath: root });
  await store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Outcome", outcome: "Deliver it", summary: "Active" });
  await assert.rejects(store.addReview("sample-outcome", { delegationId: "delegation-1", findings: [], unresolved: [] }, { beforeAppend: async () => { throw new Error("target moved"); } }), /target moved/);
  assert.equal((await store.reviews("sample-outcome")).length, 0);
});
