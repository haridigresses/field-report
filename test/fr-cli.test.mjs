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
      res.end(JSON.stringify({ requested: [{ id: "sample-stream", recipient: "019f0000-0000-7000-8000-000000000001", alias: "repo-orchestrator", head: "a".repeat(40), prompt: "Review this head" }] }));
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
  const stream = { id: "sample-stream", project: "sample", title: "Sample stream", summary: "Initial state", status: "active", branch: "sample/import-authority", reviewState: "Build", chunks: [], questions: [], prs: [], issuePrefixes: [], references: [], orchestrator: "sample-agent", updatedAt: "2026-07-12T00:00:00.000Z" };
  await writeFile(path.join(localRoot, "workstreams", "sample-stream.json"), JSON.stringify(stream, null, 2));
  await exec("git", ["init", "-b", "sample/import-authority"], { cwd: localRoot });
  await exec("git", ["add", "."], { cwd: localRoot });
  await exec("git", ["-c", "user.name=Field Report Test", "-c", "user.email=field-report@example.invalid", "commit", "-m", "fixture"], { cwd: localRoot });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: localRoot })).stdout.trim();
  await writeFile(path.join(localRoot, "data", "current.json"), JSON.stringify({
    generatedAt: "2026-07-12T15:00:00.000Z",
    projects: [{ id: "sample", label: "Sample", repoPath: localRoot }],
    workstreams: [{ ...stream, assessment: { currentHead: head }, prs: [{ number: 42, state: "OPEN", headRefName: stream.branch, headRefOid: head }], timeline: [] }]
  }));
  const env = { ...process.env, FIELD_REPORT_ROOT: localRoot, FIELD_REPORT_STATE_DIR: path.join(localRoot, "state"), FIELD_REPORT_CWD: localRoot };
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

test("fr assess prepares a native Codex review brief", async () => {
  const mock = await fixture();
  try {
    const { stdout } = await exec(process.execPath, [cli, "assess", "sample-stream"], { env: mock.env });
    assert.match(stdout, /Native Codex review brief for repo-orchestrator/);
    assert.match(stdout, /Review this head/);
    assert.equal(mock.requests[0].url, "/api/assessments/request");
  } finally {
    await mock.close();
  }
});

test("fr stores a readable alias and assigns the exact Codex task UUID", async () => {
  const mock = await localFixture();
  const sessionId = "019f0000-0000-7000-8000-000000000002";
  const env = { ...mock.env, FIELD_REPORT_SESSION_ID: sessionId };
  try {
    const saved = await exec(process.execPath, [cli, "session", "alias", "sample-orchestrator"], { env });
    assert.match(saved.stdout, new RegExp(`Saved sample-orchestrator for Codex task ${sessionId}`));
    const renamed = await exec(process.execPath, [cli, "session", "alias", "sample"], { env });
    assert.match(renamed.stdout, new RegExp(`Saved sample for Codex task ${sessionId}`));
    const assigned = await exec(process.execPath, [cli, "assign", "sample-stream", "--session", "sample-orchestrator"], { env });
    assert.match(assigned.stdout, /Assigned sample \(/);
    const stream = JSON.parse(await readFile(path.join(mock.root, "workstreams", "sample-stream.json"), "utf8"));
    assert.equal(stream.orchestrator, sessionId);
    const registry = JSON.parse(await readFile(path.join(mock.root, "config", "sessions.json"), "utf8"));
    assert.deepEqual(registry.sessions.map(({ id, alias, aliases }) => ({ id, alias, aliases })), [{ id: sessionId, alias: "sample", aliases: ["sample-orchestrator"] }]);
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

test("fr context infers checkout, workstream, gate, delivery, and MRR", async () => {
  const mock = await localFixture();
  try {
    const result = await exec(process.execPath, [cli, "context"], { env: mock.env });
    assert.match(result.stdout, /Repository: Sample \(sample\)/);
    assert.match(result.stdout, /Checkout: sample\/import-authority @ [0-9a-f]{8}/);
    assert.match(result.stdout, /Workstream: sample-stream/);
    assert.match(result.stdout, /Gate: Build/);
    assert.match(result.stdout, /Delivery: PR #42 open/);
    assert.match(result.stdout, /MRR: NOT READY/);
  } finally {
    await mock.close();
  }
});

test("fr catchup infers the repository and accepts its checkout directory name", async () => {
  const mock = await localFixture();
  try {
    const inferred = await exec(process.execPath, [cli, "catchup", "--peek"], { env: mock.env });
    assert.match(inferred.stdout, /Catch-up for Sample/);
    const aliased = await exec(process.execPath, [cli, "catchup", path.basename(mock.root), "--peek"], { env: mock.env });
    assert.match(aliased.stdout, /Catch-up for Sample/);
  } finally {
    await mock.close();
  }
});

test("fr context associates external git worktrees through the common repository", async () => {
  const mock = await localFixture();
  const external = await mkdtemp(path.join(os.tmpdir(), "field-report-worktree-"));
  try {
    await rm(external, { recursive: true, force: true });
    await exec("git", ["worktree", "add", "-b", "sample/external-worktree", external, "HEAD"], { cwd: mock.root });
    const stream = JSON.parse(await readFile(path.join(mock.root, "workstreams", "sample-stream.json"), "utf8"));
    stream.branch = "sample/external-worktree";
    await writeFile(path.join(mock.root, "workstreams", "sample-stream.json"), JSON.stringify(stream, null, 2));
    const projection = JSON.parse(await readFile(path.join(mock.root, "data", "current.json"), "utf8"));
    projection.workstreams[0].branch = stream.branch;
    projection.workstreams[0].prs[0].headRefName = stream.branch;
    await writeFile(path.join(mock.root, "data", "current.json"), JSON.stringify(projection));
    const result = await exec(process.execPath, [cli, "context"], { env: { ...mock.env, FIELD_REPORT_CWD: external } });
    assert.match(result.stdout, /Repository: Sample \(sample\)/);
    assert.match(result.stdout, /Checkout: sample\/external-worktree/);
    assert.match(result.stdout, /Workstream: sample-stream/);
  } finally {
    await exec("git", ["worktree", "remove", "--force", external], { cwd: mock.root }).catch(() => {});
    await rm(external, { recursive: true, force: true });
    await mock.close();
  }
});

test("fr checkpoint infers the exact checkout head and suppresses duplicate checkpoints", async () => {
  const mock = await localFixture();
  try {
    const first = await exec(process.execPath, [cli, "checkpoint", "sample-stream", "--summary", "Committed implementation"], { env: mock.env });
    assert.match(first.stdout, /Updated sample-stream/);
    const stream = JSON.parse(await readFile(path.join(mock.root, "workstreams", "sample-stream.json"), "utf8"));
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    assert.deepEqual(stream.commits, [head]);
    const before = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").length;
    const second = await exec(process.execPath, [cli, "checkpoint", "sample-stream", "--summary", "Committed implementation"], { env: mock.env });
    assert.match(second.stdout, /No material change/);
    const after = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").length;
    assert.equal(after, before);
  } finally {
    await mock.close();
  }
});

test("fr pass import records a two-lane structured review envelope in one command", async () => {
  const mock = await localFixture();
  try {
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const envelope = {
      workstream_id: "sample-stream",
      head,
      passes: [
        { role: "deep-code-review", verdict: "GO", model: "gpt-5.6-sol", merge: 95, structural: 5, summary: "Code lane clear" },
        { review_role: "structural-challenge", verdict: "GO", model: "claude", merge_readiness: 92, structural_risk: 8, summary: "Structure lane clear" }
      ]
    };
    const result = await exec(process.execPath, [cli, "pass", "import", "--data", JSON.stringify(envelope)], { env: mock.env });
    assert.match(result.stdout, /Imported 2 review passes/);
    assert.match(result.stdout, /MRR: READY/);
    const events = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.slice(-2).map((event) => event.metadata.reviewRole), ["deep-code-review", "structural-challenge"]);
  } finally {
    await mock.close();
  }
});

test("fr pass import validates the entire envelope before recording any lane", async () => {
  const mock = await localFixture();
  try {
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const envelope = {
      workstreamId: "sample-stream",
      head,
      passes: [
        { role: "deep-code-review", verdict: "GO", merge: 95, structural: 5 },
        { role: "structural-challenge", verdict: "MAYBE", merge: 90, structural: 10 }
      ]
    };
    await assert.rejects(exec(process.execPath, [cli, "pass", "import", "--data", JSON.stringify(envelope)], { env: mock.env }), /GO, CONDITIONAL_GO, or NO_GO/);
    await assert.rejects(readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8"), { code: "ENOENT" });
  } finally {
    await mock.close();
  }
});

test("fr pass refuses review evidence on an outcome without a code anchor", async () => {
  const mock = await localFixture();
  try {
    const streamPath = path.join(mock.root, "workstreams", "sample-stream.json");
    const stream = JSON.parse(await readFile(streamPath, "utf8"));
    stream.branch = null;
    stream.commits = [];
    stream.prs = [];
    await writeFile(streamPath, JSON.stringify(stream, null, 2));
    const result = await exec(process.execPath, [cli, "pass", "record", "sample-stream", "--head", "a".repeat(40), "--verdict", "GO", "--reviewer", "reviewer", "--model", "test", "--merge", "90", "--structural", "10"], { env: mock.env }).catch((error) => error);
    assert.match(`${result.stderr || ""}${result.stdout || ""}`, /Review passes require a code workstream/);
  } finally {
    await mock.close();
  }
});
