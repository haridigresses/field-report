import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "fr.mjs");

async function fixture() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/passes")) {
        res.end(JSON.stringify({ event: { metadata: { passId: "pass-1", head: "abcdef1234567890" } } }));
      } else if (req.url === "/api/assessments/request") {
        res.end(JSON.stringify({ requested: [{ recipient: "repo/orchestrator" }] }));
      } else if (req.url === "/data/current.json") {
        res.end(JSON.stringify({
          generatedAt: "2026-07-12T15:00:00.000Z",
          projects: [{ id: "sample", label: "Sample", metrics: { activeWorkstreams: 1, openPrs: 1, openQuestions: 1 } }],
          workstreams: [{
            id: "sample-stream",
            project: "sample",
            title: "Repair import authority",
            status: "active",
            updatedAt: "2026-07-12T14:30:00.000Z",
            reviewState: "User decision required before publication",
            branch: "sample/import-authority",
            chunks: [{ id: "publish", title: "Publish reviewed branch", status: "planned" }],
            questions: [{ id: "Q1", text: "Which contract applies?", status: "open", askedAt: "2026-07-12T14:20:00.000Z" }],
            prs: [{ number: 42, state: "OPEN", headRefName: "sample/import-authority", headRefOid: "abcdef1234567890", updatedAt: "2026-07-12T14:40:00.000Z" }],
            timeline: []
          }]
        }));
      } else if (req.url === "/api/workstreams/sample-stream/mrr") {
        res.end(JSON.stringify({ required: true, ready: false, head: "abcdef1234567890abcdef1234567890abcdef12", policy: { mode: "full", reason: null }, reasons: ["missing completed structural-challenge exact-head pass"], lanes: { deepCode: { verdict: "GO", model: "gpt-5.6-sol" }, structuralChallenge: null } }));
      } else if (req.url === "/api/workstreams/sample-stream" && req.method === "PATCH") {
        res.end(JSON.stringify({ workstream: { id: "sample-stream", ...requests.at(-1).body } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "field-report-cli-"));
  const address = server.address();
  return {
    requests,
    env: { ...process.env, FIELD_REPORT_URL: `http://127.0.0.1:${address.port}`, FIELD_REPORT_STATE_DIR: stateDir },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(stateDir, { recursive: true, force: true });
    }
  };
}

async function localFixture() {
  const localRoot = await mkdtemp(path.join(os.tmpdir(), "field-report-local-"));
  await Promise.all(["config", "data", "docs", "events", "workstreams"].map((directory) => mkdir(path.join(localRoot, directory))));
  await writeFile(path.join(localRoot, "config", "projects.json"), JSON.stringify({ projects: [{ id: "sample", label: "Sample", repoPath: localRoot, coordinator: "sample-coordinator" }] }));
  await writeFile(path.join(localRoot, "docs", "fr-workflow.md"), "# Contract\n\n## Shared contract\n\n- Keep it durable.\n");
  await writeFile(path.join(localRoot, "workstreams", "sample-stream.json"), JSON.stringify({ id: "sample-stream", project: "sample", title: "Sample stream", summary: "Initial state", status: "active", branch: null, reviewState: "Build", chunks: [], questions: [], prs: [], issuePrefixes: [], references: [], orchestrator: "sample-agent", updatedAt: "2026-07-12T00:00:00.000Z" }, null, 2));
  const env = { ...process.env, FIELD_REPORT_ROOT: localRoot, FIELD_REPORT_STATE_DIR: path.join(localRoot, "state") };
  delete env.FIELD_REPORT_URL;
  return {
    root: localRoot,
    env,
    async close() { await rm(localRoot, { recursive: true, force: true }); }
  };
}

test("fr pass record dispatches as a top-level command", async () => {
  const mock = await fixture();
  try {
    const { stdout } = await exec(process.execPath, [cli, "pass", "record", "sample-stream", "--head", "abcdef1234567890", "--verdict", "GO"], { env: mock.env });
    assert.match(stdout, /Recorded review pass pass-1/);
    assert.equal(mock.requests[0].url, "/api/workstreams/sample-stream/passes");
    assert.equal(mock.requests[0].body.verdict, "GO");
  } finally {
    await mock.close();
  }
});

test("fr delegate review dispatches as a top-level command", async () => {
  const mock = await fixture();
  try {
    const { stdout } = await exec(process.execPath, [cli, "delegate", "review", "sample-stream"], { env: mock.env });
    assert.match(stdout, /Requested delegated review from repo\/orchestrator/);
    assert.equal(mock.requests[0].url, "/api/assessments/request");
  } finally {
    await mock.close();
  }
});

test("fr catchup advances a durable repository cursor", async () => {
  const mock = await fixture();
  try {
    const first = await exec(process.execPath, [cli, "catchup", "sample"], { env: mock.env });
    assert.match(first.stdout, /initial orientation/);
    assert.match(first.stdout, /Repair import authority/);
    assert.match(first.stdout, /decision needed/);
    const second = await exec(process.execPath, [cli, "catchup", "sample"], { env: mock.env });
    assert.match(second.stdout, /No semantic or delivery changes since the last catch-up/);
    assert.match(second.stdout, /Other attention still open:[\s\S]*Repair import authority/);
  } finally {
    await mock.close();
  }
});

test("fr mrr reports the missing review lane", async () => {
  const mock = await fixture();
  try {
    const result = await exec(process.execPath, [cli, "mrr", "sample-stream"], { env: mock.env });
    assert.match(result.stdout, /MRR gate at abcdef12: NOT READY/);
    assert.match(result.stdout, /Policy: full/);
    assert.match(result.stdout, /Deep code review: GO/);
    assert.match(result.stdout, /Structural challenge: MISSING/);
  } finally {
    await mock.close();
  }
});

test("fr policy records a reasoned review exception", async () => {
  const mock = await fixture();
  try {
    const result = await exec(process.execPath, [cli, "policy", "sample-stream", "--mode", "delta", "--reason", "Only a bounded fix changed"], { env: mock.env });
    assert.match(result.stdout, /review policy to delta/);
    assert.deepEqual(mock.requests[0].body.reviewPolicy, { mode: "delta", reason: "Only a bounded fix changed" });
  } finally {
    await mock.close();
  }
});

test("fr checkpoint writes canonical state while the HTTP service is offline", async () => {
  const mock = await localFixture();
  try {
    const result = await exec(process.execPath, [cli, "checkpoint", "sample-stream", "--summary", "Offline update persisted", "--gate", "Independent review"], { env: mock.env });
    assert.match(result.stdout, /Updated sample-stream/);
    const stream = JSON.parse(await readFile(path.join(mock.root, "workstreams", "sample-stream.json"), "utf8"));
    assert.equal(stream.summary, "Offline update persisted");
    assert.equal(stream.reviewState, "Independent review");
    const events = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).type, "checkpoint");
  } finally {
    await mock.close();
  }
});

test("fr pass record writes exact-head review evidence while offline", async () => {
  const mock = await localFixture();
  try {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const result = await exec(process.execPath, [cli, "pass", "record", "sample-stream", "--head", sha, "--verdict", "GO", "--role", "deep-code-review", "--merge", "90", "--structural", "4"], { env: mock.env });
    assert.match(result.stdout, /Recorded review pass/);
    const events = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).metadata.reviewRole, "deep-code-review");
    assert.equal(events.at(-1).metadata.head, sha);
  } finally {
    await mock.close();
  }
});
