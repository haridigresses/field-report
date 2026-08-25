import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("v1 migration preserves corpus records but makes old reviews non-gating", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-migrate-"));
  const legacy = path.join(root, "legacy");
  const state = path.join(root, "state");
  await Promise.all(["config", "workstreams", "events"].map((name) => mkdir(path.join(legacy, name), { recursive: true })));
  await writeFile(path.join(legacy, "config", "projects.json"), JSON.stringify({ projects: [{ id: "sample", label: "Sample", repoPath: root }] }));
  await writeFile(path.join(legacy, "workstreams", "outcome.json"), JSON.stringify({ id: "outcome", project: "sample", title: "Old outcome", summary: "Preserve me", status: "active", questions: [] }));
  await writeFile(path.join(legacy, "events", "outcome.jsonl"), `${JSON.stringify({ id: "old-review", at: "2026-01-01T00:00:00Z", type: "review_pass", text: "Old GO", metadata: { verdict: "GO", reviewComplete: true, independent: true } })}\n`);
  await exec(process.execPath, [path.resolve("scripts/migrate-v1.mjs"), legacy], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } });
  const stream = JSON.parse(await readFile(path.join(state, "workstreams", "outcome.json"), "utf8"));
  const review = JSON.parse((await readFile(path.join(state, "reviews", "outcome.jsonl"), "utf8")).trim());
  assert.equal(stream.summary, "Preserve me");
  assert.equal(review.legacy, true);
  assert.equal(review.kind, "mrr");
});
