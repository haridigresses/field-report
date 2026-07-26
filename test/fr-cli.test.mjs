import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createFieldReportStore } from "../src/store.mjs";

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
      } else if (req.url.startsWith("/api/workstreams/sample-stream/mrr")) {
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
  delete env.CODEX_THREAD_ID;
  delete env.FIELD_REPORT_SESSION_ID;
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
    assert.match(stdout, /Native Codex independent-review brief/);
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
    const userEnv = { ...env };
    delete userEnv.CODEX_THREAD_ID;
    delete userEnv.FIELD_REPORT_SESSION_ID;
    const assigned = await exec(process.execPath, [cli, "assign", "sample-stream", "--session", "sample-orchestrator"], { env: userEnv });
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

test("MRR can evaluate an explicit live release head instead of a stale local ref", async () => {
  const mock = await localFixture();
  const liveHead = "abcdef1234567890abcdef1234567890abcdef12";
  const store = createFieldReportStore(mock.root);
  try {
    await store.recordReviewPass("sample-stream", { head: liveHead, verdict: "GO", reviewRole: "deep-code-review", reviewer: "deep", independent: true, mergeReadiness: 95, structuralRisk: 5 });
    await store.recordReviewPass("sample-stream", { head: liveHead, verdict: "GO", reviewRole: "structural-challenge", reviewer: "structural", independent: true, mergeReadiness: 95, structuralRisk: 5 });
    const stale = await store.mrrStatus("sample-stream");
    const live = await store.mrrStatus("sample-stream", liveHead);
    assert.equal(stale.ready, false);
    assert.equal(live.ready, true);
    assert.equal(live.head, liveHead);
  } finally {
    await mock.close();
  }
});

test("fr policy records a reasoned review exception", async () => {
  const mock = await fixture();
  try {
    const env = { ...mock.env };
    delete env.CODEX_THREAD_ID;
    delete env.FIELD_REPORT_SESSION_ID;
    const result = await exec(process.execPath, [cli, "policy", "sample-stream", "--mode", "delta", "--reason", "Only a bounded fix changed", "--user-authorized"], { env });
    assert.match(result.stdout, /review policy to delta/);
    assert.deepEqual(mock.requests[0].body.reviewPolicy, { mode: "delta", reason: "Only a bounded fix changed" });
  } finally {
    await mock.close();
  }
});

test("armed repository coordinators cannot answer decisions or mutate workstream authority", async () => {
  const mock = await fixture();
  const sessionId = "019f0000-0000-7000-8000-000000000002";
  try {
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [sessionId]: { projectId: "sample", role: "repo-coordinator" } } }));
    const env = { ...mock.env, CODEX_THREAD_ID: sessionId };
    const attempts = [
      ["onboard", "sample-stream", "--role", "workstream-orchestrator"],
      ["decide", "sample-stream", "Q1", "Approved option 2"],
      ["reconcile", "sample-stream", "--data", JSON.stringify({ status: "complete", questions: [] }), "--note", "Cleared"],
      ["policy", "sample-stream", "--mode", "delta", "--reason", "Only a bounded fix changed"],
      ["pass", "record", "sample-stream", "--head", "a".repeat(40), "--verdict", "GO"],
      ["disarm"]
    ];
    for (const args of attempts) await assert.rejects(exec(process.execPath, [cli, ...args], { env }), /relay and monitoring role/);
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("coordinator workstream creation preserves the coordinator binding", async () => {
  const mock = await localFixture();
  const sessionId = "019f0000-0000-7000-8000-000000000004";
  const stateFile = path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json");
  try {
    await mkdir(mock.env.FIELD_REPORT_STATE_DIR, { recursive: true });
    await writeFile(stateFile, JSON.stringify({ sessions: { [sessionId]: { projectId: "sample", role: "repo-coordinator" } } }));
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [{ id: sessionId, alias: "sample-coordinator", kind: "codex" }] }));
    const env = { ...mock.env, CODEX_THREAD_ID: sessionId };
    const result = await exec(process.execPath, [cli, "create", "--repo", "sample", "--title", "New tracked outcome", "--outcome", "Track the user-directed outcome"], { env });
    assert.match(result.stdout, /Created sample-new-tracked-outcome/);
    await assert.rejects(exec(process.execPath, [cli, "create", "--repo", "sample", "--title", "Self owned outcome", "--outcome", "Invalid self assignment", "--orchestrator", sessionId], { env }), /cannot create a workstream assigned to themselves/);
    await assert.rejects(exec(process.execPath, [cli, "create", "--repo", "sample", "--title", "Alias self owned outcome", "--outcome", "Invalid alias self assignment", "--orchestrator", "sample-coordinator"], { env }), /cannot create a workstream assigned to themselves/);
    await assert.rejects(exec(process.execPath, [cli, "auto-onboard"], { env }), /relay and monitoring role/);
    await exec(process.execPath, [cli, "hook", "session-start"], { env });
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.sessions[sessionId].role, "repo-coordinator");
    assert.equal(state.sessions[sessionId].workstreamId, undefined);
    const stream = JSON.parse(await readFile(path.join(mock.root, "workstreams", "sample-new-tracked-outcome.json"), "utf8"));
    assert.equal(stream.orchestrator, null);
  } finally {
    await mock.close();
  }
});

test("an unbound Codex identity cannot claim user-only review-policy authority", async () => {
  const mock = await fixture();
  try {
    const env = { ...mock.env, CODEX_THREAD_ID: "019f0000-0000-7000-8000-000000000005" };
    await assert.rejects(exec(process.execPath, [cli, "policy", "sample-stream", "--mode", "none", "--reason", "Agent bypass"], { env }), /Only the user may change review policy/);
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("workstream decisions require exact current assignment", async () => {
  const mock = await fixture();
  const sessionId = "019f0000-0000-7000-8000-000000000006";
  try {
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [sessionId]: { workstreamId: "other-stream", role: "workstream-orchestrator" } } }));
    const env = { ...mock.env, CODEX_THREAD_ID: sessionId };
    await assert.rejects(exec(process.execPath, [cli, "decide", "sample-stream", "Q1", "Approved option 2"], { env }), /exact assigned workstream orchestrator/);
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("ordinary local creation remains unassigned without an explicit orchestrator", async () => {
  const mock = await localFixture();
  const coordinatorId = "019f0000-0000-7000-8000-000000000007";
  try {
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [{ id: coordinatorId, alias: "sample-coordinator", kind: "codex" }] }));
    const env = { ...mock.env };
    delete env.CODEX_THREAD_ID;
    delete env.FIELD_REPORT_SESSION_ID;
    await exec(process.execPath, [cli, "create", "--repo", "sample", "--title", "User created outcome", "--outcome", "Track a user-created outcome", "--no-onboard"], { env });
    const stream = JSON.parse(await readFile(path.join(mock.root, "workstreams", "sample-user-created-outcome.json"), "utf8"));
    assert.equal(stream.orchestrator, null);
    const store = createFieldReportStore(mock.root);
    const [brief] = await store.prepareAssessmentBriefs(["sample-stream"]);
    assert.equal(brief.recipient, undefined);
    assert.match(brief.prompt, /independent reviewer/);
  } finally {
    await mock.close();
  }
});

test("coordinator mutations stay inside the assigned repository", async () => {
  const mock = await localFixture();
  const sessionId = "019f0000-0000-7000-8000-000000000008";
  try {
    await mkdir(mock.env.FIELD_REPORT_STATE_DIR, { recursive: true });
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [sessionId]: { projectId: "other", role: "repo-coordinator" } } }));
    const env = { ...mock.env, CODEX_THREAD_ID: sessionId };
    await assert.rejects(exec(process.execPath, [cli, "create", "--repo", "sample", "--title", "Cross repo", "--outcome", "Invalid"], { env }), /only in their assigned repository/);
    await assert.rejects(exec(process.execPath, [cli, "ask", "sample-stream", "Should this cross repositories?"], { env }), /only workstreams in their assigned repository/);
  } finally {
    await mock.close();
  }
});

test("workstream-orchestrator onboarding requires durable assignment", async () => {
  const mock = await localFixture();
  const sessionId = "019f0000-0000-7000-8000-000000000009";
  try {
    const env = { ...mock.env, CODEX_THREAD_ID: sessionId };
    await assert.rejects(exec(process.execPath, [cli, "onboard", "sample-stream", "--role", "workstream-orchestrator"], { env }), /requires the exact durable task assignment/);
  } finally {
    await mock.close();
  }
});

test("creating for another orchestrator succeeds without onboarding the creator", async () => {
  const mock = await localFixture();
  const creatorId = "019f0000-0000-7000-8000-000000000010";
  const ownerId = "019f0000-0000-7000-8000-000000000011";
  try {
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [{ id: ownerId, alias: "delegated-owner", kind: "codex" }] }));
    const env = { ...mock.env, CODEX_THREAD_ID: creatorId };
    const result = await exec(process.execPath, [cli, "create", "--repo", "sample", "--title", "Delegated outcome", "--outcome", "Owned by another task", "--orchestrator", "delegated-owner"], { env });
    assert.match(result.stdout, /Created sample-delegated-outcome/);
    const stream = JSON.parse(await readFile(path.join(mock.root, "workstreams", "sample-delegated-outcome.json"), "utf8"));
    assert.equal(stream.orchestrator, ownerId);
  } finally {
    await mock.close();
  }
});

test("legacy orchestrator aliases resolve to UUID authority and new writes canonicalize them", async () => {
  const mock = await localFixture();
  const ownerId = "019f0000-0000-7000-8000-000000000014";
  try {
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [{ id: ownerId, alias: "sample-agent", kind: "codex" }] }));
    await mkdir(mock.env.FIELD_REPORT_STATE_DIR, { recursive: true });
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [ownerId]: { workstreamId: "sample-stream", role: "workstream-orchestrator" } } }));
    const ownerEnv = { ...mock.env, CODEX_THREAD_ID: ownerId };
    await exec(process.execPath, [cli, "checkpoint", "sample-stream", "--summary", "Legacy alias owner remains authorized"], { env: ownerEnv });

    const store = createFieldReportStore(mock.root);
    const baseHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const tree = (await exec("git", ["write-tree"], { cwd: mock.root })).stdout.trim();
    await assert.rejects(store.recordCommitReview("sample-stream", { tree, baseHead, reviewRole: "deep-code-review", verdict: "GO", reviewerId: "sample-agent", summary: "Owner cannot review its own commit" }), /cannot record an independent review/);
    await assert.rejects(store.recordReviewPass("sample-stream", { head: baseHead, verdict: "GO", reviewRole: "deep-code-review", reviewerId: "sample-agent", provider: "openai", model: "gpt-5.6-sol", mergeReadiness: 95, structuralRisk: 5 }), /cannot record an independent review/);
    await store.appendWorkstreamEvent("sample-stream", { type: "commit_review", actor: ownerId, text: "Legacy self-review evidence", metadata: { tree, baseHead, verdict: "GO", reviewComplete: true, reviewRole: "deep-code-review", reviewerId: ownerId } });
    await store.recordCommitReview("sample-stream", { tree, baseHead, reviewRole: "structural-challenge", verdict: "GO", reviewerId: "019f0000-0000-7000-8000-000000000017", summary: "Independent structural review" });
    await store.updateWorkstream("sample-stream", { orchestrator: "019f0000-0000-7000-8000-000000000021" });
    const panel = await store.commitPanelStatus("sample-stream", tree, baseHead);
    assert.equal(panel.ready, false);
    assert.match(panel.reasons.join(" "), /missing local deep-code-review/);
    await store.updateWorkstream("sample-stream", { orchestrator: null });
    assert.equal((await store.commitPanelStatus("sample-stream", tree, baseHead)).ready, false);
    await store.updateWorkstream("sample-stream", { orchestrator: "019f0000-0000-7000-8000-000000000021" });

    const configPath = path.join(mock.root, "config", "projects.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.projects[0].reviewPolicy = { requireReviewerIds: true };
    await writeFile(configPath, JSON.stringify(config));
    await store.appendWorkstreamEvent("sample-stream", { type: "review_pass", actor: ownerId, text: "Legacy self-review pass", metadata: { head: baseHead, verdict: "GO", reviewComplete: true, reviewRole: "deep-code-review", reviewScope: "full", reviewerId: ownerId, provider: "openai", model: "gpt-5.6-sol", independent: true, unresolved: [] } });
    await store.recordReviewPass("sample-stream", { head: baseHead, verdict: "GO", reviewRole: "structural-challenge", reviewerId: "019f0000-0000-7000-8000-000000000017", provider: "anthropic", model: "claude-fable-5", independent: true, mergeReadiness: 95, structuralRisk: 5 });
    const mrr = await store.mrrStatus("sample-stream", baseHead);
    assert.equal(mrr.ready, false);
    assert.match(mrr.reasons.join(" "), /missing completed deep-code-review/);
    await store.updateWorkstream("sample-stream", { orchestrator: null });
    assert.equal((await store.mrrStatus("sample-stream", baseHead)).ready, false);
    await store.updateWorkstream("sample-stream", { orchestrator: "019f0000-0000-7000-8000-000000000021" });

    await store.recordReviewPass("sample-stream", { head: baseHead, verdict: "GO", reviewRole: "deep-code-review", reviewerId: "019f0000-0000-7000-8000-000000000018", provider: "openai", model: "gpt-5.6-sol", independent: true, mergeReadiness: 95, structuralRisk: 5 });
    await assert.rejects(store.updateWorkstream("sample-stream", { orchestrator: "019f0000-0000-7000-8000-000000000017", status: "complete" }), /orchestrator cannot count toward the independent MRR fleet/);

    const stream = await store.updateWorkstream("sample-stream", { orchestrator: "sample-agent" });
    assert.equal(stream.orchestrator, ownerId);
  } finally {
    await mock.close();
  }
});

test("exact task IDs take precedence over colliding legacy aliases", async () => {
  const mock = await localFixture();
  const ownerId = "019f0000-0000-7000-8000-000000000015";
  const otherId = "019f0000-0000-7000-8000-000000000016";
  const futureId = "019f0000-0000-7000-8000-000000000019";
  try {
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [
      { id: otherId, alias: ownerId, kind: "codex" },
      { id: ownerId, alias: "exact-owner", kind: "codex" },
      { id: "019f0000-0000-7000-8000-000000000020", alias: futureId, kind: "codex" }
    ] }));
    const store = createFieldReportStore(mock.root);
    assert.equal((await store.resolveSession(ownerId)).id, ownerId);
    await assert.rejects(store.saveSessionAlias({ id: otherId, alias: ownerId }), /conflicts with an existing task ID/);
    await assert.rejects(store.saveSessionAlias({ id: futureId, alias: "new-owner" }), /conflicts with an existing alias/);
  } finally {
    await mock.close();
  }
});

test("a reassigned former orchestrator cannot mutate the workstream", async () => {
  const mock = await localFixture();
  const formerId = "019f0000-0000-7000-8000-000000000012";
  try {
    const streamPath = path.join(mock.root, "workstreams", "sample-stream.json");
    const stream = JSON.parse(await readFile(streamPath, "utf8"));
    await writeFile(streamPath, JSON.stringify({ ...stream, orchestrator: "019f0000-0000-7000-8000-000000000013" }, null, 2));
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [{ id: formerId, alias: "former-owner", kind: "codex" }] }));
    await mkdir(mock.env.FIELD_REPORT_STATE_DIR, { recursive: true });
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [formerId]: { workstreamId: "sample-stream", role: "workstream-orchestrator" } } }));
    const env = { ...mock.env, CODEX_THREAD_ID: formerId };
    await assert.rejects(exec(process.execPath, [cli, "checkpoint", "sample-stream", "--summary", "Unauthorized mutation"], { env }), /no longer the durable orchestrator/);
    await assert.rejects(exec(process.execPath, [cli, "assign", "sample-stream", "--session", "former-owner"], { env }), /no longer the durable orchestrator/);
    await assert.rejects(exec(process.execPath, [cli, "commit", "sample-stream", "--message", "Unauthorized commit"], { env }), /no longer the durable orchestrator/);
    const eventPath = path.join(mock.root, "events", "sample-stream.jsonl");
    const before = await readFile(eventPath, "utf8").catch(() => "");
    await exec(process.execPath, [cli, "hook", "stop"], { env });
    const after = await readFile(eventPath, "utf8").catch(() => "");
    assert.equal(after, before);
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
      review_complete: true,
      independent: true,
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
      review_complete: true,
      independent: true,
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

test("fr commit-check requires two reviews of the exact staged tree", async () => {
  const mock = await localFixture();
  try {
    await writeFile(path.join(mock.root, "candidate.txt"), "candidate\n");
    await exec("git", ["add", "candidate.txt"], { cwd: mock.root });
    const tree = (await exec("git", ["write-tree"], { cwd: mock.root })).stdout.trim();
    const baseHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    await exec(process.execPath, [cli, "commit-review", "record", "sample-stream", "--tree", tree, "--base-head", baseHead, "--role", "deep-code-review", "--model", "gpt-5.6-sol", "--summary", "Deep review clear"], { env: { ...mock.env, FIELD_REPORT_SESSION_ID: "019f0000-0000-7000-8000-000000000010" } });
    const blocked = await exec(process.execPath, [cli, "commit-check", "sample-stream"], { env: mock.env }).catch((error) => error);
    assert.match(`${blocked.stderr || ""}${blocked.stdout || ""}`, /missing local structural-challenge/);
    await exec(process.execPath, [cli, "commit-review", "record", "sample-stream", "--tree", tree, "--base-head", baseHead, "--role", "structural-challenge", "--model", "gpt-5.6-sol", "--summary", "Structural review clear"], { env: { ...mock.env, FIELD_REPORT_SESSION_ID: "019f0000-0000-7000-8000-000000000011" } });
    const ready = await exec(process.execPath, [cli, "commit-check", "sample-stream"], { env: mock.env });
    assert.match(ready.stdout, /commit gate .* READY/);
    await writeFile(path.join(mock.root, "candidate.txt"), "changed\n");
    await exec("git", ["add", "candidate.txt"], { cwd: mock.root });
    const changed = await exec(process.execPath, [cli, "commit-check", "sample-stream"], { env: mock.env }).catch((error) => error);
    assert.match(`${changed.stderr || ""}${changed.stdout || ""}`, /missing local deep-code-review/);
  } finally {
    await mock.close();
  }
});

test("completion preserves project-level review provenance requirements", async () => {
  const mock = await localFixture();
  try {
    const configPath = path.join(mock.root, "config", "projects.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.projects[0].reviewPolicy = { requireReviewerIds: true, minProviderFamilies: 2 };
    await writeFile(configPath, JSON.stringify(config));
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const store = createFieldReportStore(mock.root);
    await store.recordReviewPass("sample-stream", { head, verdict: "GO", reviewRole: "deep-code-review", reviewer: "deep", model: "gpt-5.6-sol", mergeReadiness: 95, structuralRisk: 5 });
    await store.recordReviewPass("sample-stream", { head, verdict: "GO", reviewRole: "structural-challenge", reviewer: "structural", model: "anthropic.claude-fable-5", mergeReadiness: 95, structuralRisk: 5 });
    await assert.rejects(store.updateWorkstream("sample-stream", { status: "complete", updatedBy: "test" }), /MRR completion gate is not satisfied/);
  } finally {
    await mock.close();
  }
});

test("fr pass import requires affirmative completion and independence", async () => {
  const mock = await localFixture();
  try {
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const base = { workstream_id: "sample-stream", head, passes: [{ role: "deep-code-review", verdict: "GO", model: "gpt-5.6-sol", merge: 95, structural: 5, summary: "clear" }] };
    const missing = await exec(process.execPath, [cli, "pass", "import", "--data", JSON.stringify(base)], { env: mock.env }).catch((error) => error);
    assert.match(`${missing.stderr || ""}${missing.stdout || ""}`, /explicit review_complete: true/);
    const dependent = await exec(process.execPath, [cli, "pass", "import", "--data", JSON.stringify({ ...base, review_complete: true, independent: false })], { env: mock.env }).catch((error) => error);
    assert.match(`${dependent.stderr || ""}${dependent.stdout || ""}`, /explicit independent: true/);
  } finally {
    await mock.close();
  }
});
