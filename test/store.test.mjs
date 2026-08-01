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
  assert.equal(stream.reviewClass, "full");
  assert.equal((await store.events(stream.id)).length, 0);
  await assert.rejects(store.saveWorkstream({ id: "sample-outcome", project: "sample", title: "Duplicate", outcome: "Duplicate", summary: "Duplicate" }), /already exists/);
  const project = await store.updateProject("sample", { baseBranch: "develop" });
  assert.equal(project.baseBranch, "develop");
  assert.equal(project.revision, 2);
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
