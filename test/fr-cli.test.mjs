import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  const env = { ...process.env, FIELD_REPORT_URL: `http://127.0.0.1:${address.port}`, FIELD_REPORT_STATE_DIR: stateDir };
  delete env.CODEX_THREAD_ID;
  delete env.FIELD_REPORT_SESSION_ID;
  return {
    requests,
    env,
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

async function installFakeCodex(root) {
  const binDir = path.join(root, "fake-bin");
  await mkdir(binDir);
  const packageRoot = path.join(root, "fake-codex-package");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "test" }));
  const executable = path.join(packageRoot, "bin", "codex.js");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
const prompt = args.at(-1);
const value = (label) => prompt.match(new RegExp(label + " ([0-9a-f-]+)"))?.[1];
const role = prompt.match(/independent (deep-code-review|structural-challenge) reviewer/)?.[1];
const reviewer = role === "deep-code-review" ? "019f0000-0000-7000-8000-000000000093" : "019f0000-0000-7000-8000-000000000094";
writeFileSync(output, JSON.stringify({ review_complete: true, independent: true, verdict: "GO", review_role: role, scope: "full", reviewed_sha: value("Head"), base_sha: value("Base"), staged_tree: value("Staged tree"), merge_readiness: 95, structural_risk: 5, findings: [], unresolved: [], summary: role + " clear" }));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: reviewer }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n");
`);
  await chmod(executable, 0o755);
  await symlink(executable, path.join(binDir, "codex"));
  return binDir;
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
    assert.match(stdout, /Native Codex advisory-assessment brief/);
    assert.match(stdout, /Review this head/);
    assert.equal(mock.requests[0].url, "/api/assessments/request");
  } finally {
    await mock.close();
  }
});

test("fr doctor is a non-gating compatibility diagnostic", async () => {
  const mock = await localFixture();
  try {
    const { stdout } = await exec(process.execPath, [cli, "doctor"], { env: mock.env });
    assert.match(stdout, /^Field Report doctor: OK/m);
    assert.match(stdout, /Canonical data:/);
    assert.match(stdout, /diagnostic only; onboarding remains the work prerequisite/);
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

test("workflow routes decisions directly to the user and coordinator messages only for collisions", async () => {
  const store = createFieldReportStore(root);
  const workstream = await store.workflowContract("workstream-orchestrator");
  const coordinator = await store.workflowContract("repo-coordinator");
  const coordinatorSkill = await readFile(path.join(root, "skills", "repo-coordinator", "SKILL.md"), "utf8");

  assert.match(workstream, /decisions directly to the user as compact briefs/);
  assert.match(workstream, /only for a concrete cross-workstream collision/);
  assert.match(workstream, /Do not route them through the repository coordinator/);
  assert.match(workstream, /`None` is valid for both changed premises and concerns/);
  assert.match(workstream, /Do not require a narrative about what was surprising/);
  assert.doesNotMatch(workstream, /user\/product decision, cross-workstream collision/);
  assert.match(coordinator, /Workstreams bring their own unresolved decisions directly to the user/);
  assert.match(coordinator, /do not make the coordinator a decision conduit/);
  assert.match(coordinatorSkill, /relay user direction to persistent workstreams/);
  assert.doesNotMatch(coordinatorSkill, /relay between the user and persistent workstreams/);
});

test("MRR evaluates an explicit live release head without allowing a reduced code policy", async () => {
  const mock = await localFixture();
  const liveHead = "abcdef1234567890abcdef1234567890abcdef12";
  const store = createFieldReportStore(mock.root);
  try {
    const streamPath = path.join(mock.root, "workstreams", "sample-stream.json");
    const stream = JSON.parse(await readFile(streamPath, "utf8"));
    await writeFile(streamPath, JSON.stringify({ ...stream, reviewPolicy: { mode: "single-independent", reason: "Legacy reduced policy" } }, null, 2));
    await store.recordReviewPass("sample-stream", { head: liveHead, verdict: "GO", reviewRole: "deep-code-review", reviewer: "deep", independent: true, mergeReadiness: 95, structuralRisk: 5 });
    await store.recordReviewPass("sample-stream", { head: liveHead, verdict: "GO", reviewRole: "structural-challenge", reviewer: "structural", independent: true, mergeReadiness: 95, structuralRisk: 5 });
    const stale = await store.mrrStatus("sample-stream");
    const live = await store.mrrStatus("sample-stream", liveHead);
    assert.equal(stale.ready, false);
    assert.equal(live.ready, false);
    assert.equal(live.head, liveHead);
    assert.equal(live.policy.mode, "full");
    assert.match(live.reasons.join(" "), /2 distinct Sol reviewers/);
  } finally {
    await mock.close();
  }
});

test("fr policy accepts only the full code review policy", async () => {
  const mock = await localFixture();
  try {
    const env = { ...mock.env };
    delete env.CODEX_THREAD_ID;
    delete env.FIELD_REPORT_SESSION_ID;
    const reduced = await exec(process.execPath, [cli, "policy", "sample-stream", "--mode", "delta", "--reason", "Only a bounded fix changed", "--user-authorized"], { env }).catch((error) => error);
    assert.match(`${reduced.stderr || ""}${reduced.stdout || ""}`, /cannot be reduced/);
    const result = await exec(process.execPath, [cli, "policy", "sample-stream", "--mode", "full", "--user-authorized"], { env });
    assert.match(result.stdout, /review policy to full/);
    const stream = JSON.parse(await readFile(path.join(mock.root, "workstreams", "sample-stream.json"), "utf8"));
    assert.deepEqual(stream.reviewPolicy, { mode: "full", reason: null, userAuthorized: true });
  } finally {
    await mock.close();
  }
});

test("generic reconciliation cannot weaken review policy", async () => {
  const mock = await localFixture();
  try {
    const result = await exec(process.execPath, [cli, "reconcile", "sample-stream", "--data", '{"reviewPolicy":{"mode":"none","reason":"bypass"}}', "--note", "attempt"], { env: mock.env }).catch((error) => error);
    assert.match(`${result.stderr || ""}${result.stdout || ""}`, /Change review policy only with fr policy/);
    const stream = JSON.parse(await readFile(path.join(mock.root, "workstreams", "sample-stream.json"), "utf8"));
    assert.equal(stream.reviewPolicy, undefined);
  } finally {
    await mock.close();
  }
});

test("generic store updates cannot set review policy or erase code anchors on completion", async () => {
  const mock = await localFixture();
  try {
    const store = createFieldReportStore(mock.root);
    await assert.rejects(store.updateWorkstream("sample-stream", { reviewPolicy: { mode: "none", reason: "bypass", userAuthorized: true } }), /user-authorized policy command/);
    await assert.rejects(store.updateWorkstream("sample-stream", { branch: null, prs: [], commits: [] }), /cannot clear all branch, PR, and commit anchors/);
    assert.equal((await store.currentStream("sample-stream")).stream.branch, "sample/import-authority");
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
    assert.match(brief.prompt, /not a role-assigned MRR lane/);
    assert.doesNotMatch(brief.prompt, /Publish the judgment directly/);
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
    await assert.rejects(exec(process.execPath, [cli, "ask", "sample-stream", "Should this cross repositories?"], { env }), /relay and monitoring role/);
  } finally {
    await mock.close();
  }
});

test("repository coordinators cannot manufacture workstream questions", async () => {
  const mock = await fixture();
  const sessionId = "019f0000-0000-7000-8000-000000000022";
  try {
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [sessionId]: { projectId: "sample", role: "repo-coordinator" } } }));
    const env = { ...mock.env, CODEX_THREAD_ID: sessionId };
    await assert.rejects(exec(process.execPath, [cli, "ask", "sample-stream", "Which option should the workstream choose?"], { env }), /relay and monitoring role/);
    assert.equal(mock.requests.length, 0);
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
    await writeFile(path.join(mock.root, "events", "sample-stream.jsonl"), `${JSON.stringify({ id: "legacy-commit-review", workstreamId: "sample-stream", at: new Date().toISOString(), type: "commit_review", actor: ownerId, text: "Legacy self-review evidence", metadata: { tree, baseHead, verdict: "GO", reviewComplete: true, reviewRole: "deep-code-review", reviewerId: ownerId } })}\n`, { flag: "a" });
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
    await writeFile(path.join(mock.root, "events", "sample-stream.jsonl"), `${JSON.stringify({ id: "legacy-review-pass", workstreamId: "sample-stream", at: new Date().toISOString(), type: "review_pass", actor: ownerId, text: "Legacy self-review pass", metadata: { head: baseHead, verdict: "GO", reviewComplete: true, reviewRole: "deep-code-review", reviewScope: "full", reviewerId: ownerId, provider: "openai", model: "gpt-5.6-sol", independent: true, unresolved: [] } })}\n`, { flag: "a" });
    await store.recordReviewPass("sample-stream", { head: baseHead, verdict: "GO", reviewRole: "structural-challenge", reviewerId: "019f0000-0000-7000-8000-000000000017", provider: "anthropic", model: "claude-fable-5", independent: true, mergeReadiness: 95, structuralRisk: 5 });
    const mrr = await store.mrrStatus("sample-stream", baseHead);
    assert.equal(mrr.ready, false);
    assert.match(mrr.reasons.join(" "), /missing completed deep-code-review/);
    await store.updateWorkstream("sample-stream", { orchestrator: null });
    assert.equal((await store.mrrStatus("sample-stream", baseHead)).ready, false);
    await store.updateWorkstream("sample-stream", { orchestrator: "019f0000-0000-7000-8000-000000000021" });

    await store.recordReviewPass("sample-stream", { head: baseHead, verdict: "GO", reviewRole: "deep-code-review", reviewerId: "019f0000-0000-7000-8000-000000000018", provider: "openai", model: "gpt-5.6-sol", independent: true, mergeReadiness: 95, structuralRisk: 5 });
    await assert.rejects(store.updateWorkstream("sample-stream", { orchestrator: "019f0000-0000-7000-8000-000000000017", status: "complete" }), /witnessed Sol|MRR completion gate/);

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
    assert.match(result.stdout, /MRR: NOT READY/);
    assert.match(result.stdout, /2 distinct Sol reviewers/);
    assert.match(result.stdout, /Fable review through claude-aws/);
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

test("fr pass import cannot attest registered Sol task identities for absent reviewers", async () => {
  const mock = await localFixture();
  try {
    const deepId = "019f0000-0000-7000-8000-000000000030";
    const structuralId = "019f0000-0000-7000-8000-000000000031";
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [
      { id: deepId, alias: "deep-review", kind: "codex" },
      { id: structuralId, alias: "structural-review", kind: "codex" }
    ] }));
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const envelope = {
      workstreamId: "sample-stream",
      head,
      review_complete: true,
      independent: true,
      passes: [
        { role: "deep-code-review", verdict: "GO", reviewer_id: deepId, provider: "openai", model: "gpt-5.6-sol", merge: 95, structural: 5 },
        { role: "structural-challenge", verdict: "GO", reviewer_id: structuralId, provider: "openai", model: "gpt-5.6-sol", merge: 95, structural: 5 }
      ]
    };
    const result = await exec(process.execPath, [cli, "pass", "import", "--data", JSON.stringify(envelope)], { env: mock.env });
    assert.match(result.stdout, /full MRR requires 2 distinct Sol reviewers; found 0/);
    const store = createFieldReportStore(mock.root);
    await store.recordReviewPasses("sample-stream", envelope.passes.map((pass) => ({
      ...pass,
      head,
      reviewComplete: true,
      reviewRole: pass.role,
      reviewerId: pass.reviewer_id,
      nativeReviewerId: pass.reviewer_id,
      mergeReadiness: pass.merge,
      structuralRisk: pass.structural
    })));
    const events = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.slice(-4).map((event) => event.metadata.reviewerIdentityVerified), [false, false, false, false]);
  } finally {
    await mock.close();
  }
});

test("only a Field Report-launched Fable process can mint Fable provenance", async () => {
  const mock = await localFixture();
  try {
    const ownerId = "019f0000-0000-7000-8000-000000000033";
    const reviewerId = "019f0000-0000-7000-8000-000000000034";
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [{ id: ownerId, alias: "sample-agent", kind: "codex" }] }));
    const streamPath = path.join(mock.root, "workstreams", "sample-stream.json");
    const streamState = JSON.parse(await readFile(streamPath, "utf8"));
    await writeFile(streamPath, JSON.stringify({ ...streamState, orchestrator: ownerId }, null, 2));
    await mkdir(mock.env.FIELD_REPORT_STATE_DIR, { recursive: true });
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [ownerId]: { workstreamId: "sample-stream", role: "workstream-orchestrator" } } }));
    const baseHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    await exec("git", ["update-ref", "refs/remotes/origin/main", baseHead], { cwd: mock.root });
    await writeFile(path.join(mock.root, "fable-candidate.txt"), "review me\n");
    await exec("git", ["add", "fable-candidate.txt"], { cwd: mock.root });
    await exec("git", ["-c", "user.name=Field Report Test", "-c", "user.email=field-report@example.invalid", "commit", "-m", "candidate"], { cwd: mock.root });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const fable = {
      head,
      verdict: "GO",
      reviewComplete: true,
      independent: true,
      reviewRole: "structural-challenge",
      reviewerId,
      provider: "anthropic",
      model: "anthropic.claude-fable-5",
      route: "claude-aws",
      provenanceVerified: true,
      evidenceDigest: "a".repeat(64),
      mergeReadiness: 95,
      structuralRisk: 5
    };
    const store = createFieldReportStore(mock.root);
    const raw = await store.recordReviewPass("sample-stream", fable);
    assert.equal(raw.metadata.provenanceVerified, false);
    const envelope = { workstreamId: "sample-stream", review_complete: true, independent: true, reviewed_sha: head, base_sha: baseHead, ...fable };
    await assert.rejects(exec(process.execPath, [cli, "pass", "import", "--data", JSON.stringify(envelope)], { env: mock.env }), /pass run-fable/);
    const fableEnvelope = { review_complete: true, independent: true, verdict: "GO", review_role: "structural-challenge", scope: "full", reviewed_sha: head, base_sha: baseHead, merge_readiness: 95, structural_risk: 5, findings: [], unresolved: [], summary: "No material findings." };
    const evidence = path.join(mock.root, "fable.stream.jsonl");
    const prompt = path.join(mock.root, "fable.prompt.txt");
    const stream = [
      { type: "system", subtype: "init", model: "anthropic.claude-fable-5", session_id: reviewerId },
      { type: "result", subtype: "success", terminal_reason: "completed", session_id: reviewerId, modelUsage: { fable: { canonicalModel: "claude-fable-5", provider: "mantle" } }, result: JSON.stringify(fableEnvelope) }
    ].map(JSON.stringify).join("\n") + "\n";
    const claude = path.join(mock.root, ".local", "share", "claude", "versions", "2.1.220");
    const claudeLink = path.join(mock.root, ".local", "bin", "claude");
    await mkdir(path.dirname(claude), { recursive: true });
    await mkdir(path.dirname(claudeLink), { recursive: true });
    await symlink(claude, claudeLink);
    await writeFile(prompt, "Review the exact head and return JSON.\n");
    await writeFile(claude, `#!${process.execPath}\nif (process.argv.includes("--version")) { process.stdout.write("2.1.220 (Claude Code)\\n"); process.exit(0); }\nconst args = process.argv.slice(2).join(" ");\nif (!args.includes("--permission-mode dontAsk") || !args.includes("--tools Read,Grep,Glob") || !args.includes("--disallowedTools Bash,Edit,Write") || !args.includes("--system-prompt")) process.exit(9);\nprocess.stdout.write(${JSON.stringify(stream)});\n`);
    await chmod(claude, 0o755);
    const fableEnv = { ...mock.env, HOME: mock.root, CODEX_THREAD_ID: ownerId };
    const snapshotFailure = await exec(process.execPath, [cli, "pass", "run-fable", "sample-stream", "--head", head, "--prompt-file", prompt, "--evidence-file", evidence], { env: { ...fableEnv, TMPDIR: path.join(mock.root, "missing-temp-root") } }).catch((error) => error);
    assert.match(`${snapshotFailure.stderr || ""}${snapshotFailure.stdout || ""}`, /ENOENT/);
    await assert.rejects(readFile(`${evidence}.review-packet.txt`), { code: "ENOENT" });
    const result = await exec(process.execPath, [cli, "pass", "run-fable", "sample-stream", "--head", head, "--prompt-file", prompt, "--evidence-file", evidence], { env: fableEnv });
    assert.match(result.stdout, /Ran and recorded witnessed Fable review/);
    const events = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).metadata.provenanceVerified, true);
    assert.notEqual(events.at(-1).metadata.evidenceDigest, "a".repeat(64));
    assert.match(await readFile(`${evidence}.review-packet.txt`, "utf8"), new RegExp(`Head: ${head}`));
    assert.match(await readFile(`${evidence}.review-packet.txt`, "utf8"), new RegExp(`Base: ${baseHead}`));
    const malformedEnvelope = { ...fableEnvelope, findings: "hidden finding" };
    const malformedStream = [
      { type: "system", subtype: "init", model: "anthropic.claude-fable-5", session_id: reviewerId },
      { type: "result", subtype: "success", terminal_reason: "completed", session_id: reviewerId, modelUsage: { fable: { canonicalModel: "claude-fable-5", provider: "mantle" } }, result: JSON.stringify(malformedEnvelope) }
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(claude, `#!${process.execPath}\nif (process.argv.includes("--version")) { process.stdout.write("2.1.220 (Claude Code)\\n"); process.exit(0); }\nprocess.stdout.write(${JSON.stringify(malformedStream)});\n`);
    const malformedEvidence = path.join(mock.root, "fable-malformed.stream.jsonl");
    const malformed = await exec(process.execPath, [cli, "pass", "run-fable", "sample-stream", "--head", head, "--prompt-file", prompt, "--evidence-file", malformedEvidence], { env: fableEnv }).catch((error) => error);
    assert.match(`${malformed.stderr || ""}${malformed.stdout || ""}`, /invalid review fields/);
    assert.equal((await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").length, events.length);
    const failedEvidence = path.join(mock.root, "fable-failed.stream.jsonl");
    await writeFile(claude, `#!${process.execPath}\nif (process.argv.includes("--version")) { process.stdout.write("2.1.220 (Claude Code)\\n"); process.exit(0); }\nprocess.stdout.write(${JSON.stringify(stream.split("\n")[0] + "\n")});\nprocess.exit(2);\n`);
    const failed = await exec(process.execPath, [cli, "pass", "run-fable", "sample-stream", "--head", head, "--prompt-file", prompt, "--evidence-file", failedEvidence], { env: fableEnv }).catch((error) => error);
    assert.match(`${failed.stderr || ""}${failed.stdout || ""}`, /partial evidence preserved/);
    assert.match(await readFile(failedEvidence, "utf8"), /anthropic\.claude-fable-5/);
    const afterFailure = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n");
    assert.equal(afterFailure.length, events.length);
  } finally {
    await mock.close();
  }
});

test("fr pass record attests only the invoking registered Codex task", async () => {
  const mock = await localFixture();
  try {
    const reviewerId = "019f0000-0000-7000-8000-000000000032";
    const claimedId = "019f0000-0000-7000-8000-000000000033";
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [
      { id: reviewerId, alias: "deep-review", kind: "codex", model: "gpt-5.6-terra", provider: "openai", reviewerMetadataVerified: true },
      { id: claimedId, alias: "claimed-review", kind: "codex" }
    ] }));
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    await exec(process.execPath, [cli, "pass", "record", "sample-stream", "--head", head, "--verdict", "GO", "--role", "deep-code-review", "--provider", "openai", "--model", "gpt-5.6-sol", "--merge", "95", "--structural", "5"], { env: { ...mock.env, CODEX_THREAD_ID: reviewerId, FIELD_REPORT_SESSION_ID: claimedId } });
    await exec(process.execPath, [cli, "pass", "record", "sample-stream", "--head", head, "--verdict", "GO", "--role", "structural-challenge", "--provider", "openai", "--model", "gpt-5.6-sol", "--merge", "95", "--structural", "5"], { env: { ...mock.env, FIELD_REPORT_SESSION_ID: claimedId } });
    const events = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-2).metadata.reviewerId, reviewerId);
    assert.equal(events.at(-2).metadata.reviewerIdentityVerified, true);
    assert.equal(events.at(-2).metadata.model, "gpt-5.6-terra");
    assert.equal(events.at(-1).metadata.reviewerId, claimedId);
    assert.equal(events.at(-1).metadata.reviewerIdentityVerified, false);
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
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [
      { id: "019f0000-0000-7000-8000-000000000010", alias: "deep-review", kind: "codex", model: "gpt-5.6-sol", provider: "openai", reviewerMetadataVerified: true },
      { id: "019f0000-0000-7000-8000-000000000011", alias: "structural-review", kind: "codex", model: "gpt-5.6-sol", provider: "openai", reviewerMetadataVerified: true }
    ] }));
    await writeFile(path.join(mock.root, "candidate.txt"), "candidate\n");
    await exec("git", ["add", "candidate.txt"], { cwd: mock.root });
    const tree = (await exec("git", ["write-tree"], { cwd: mock.root })).stdout.trim();
    const baseHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const store = createFieldReportStore(mock.root);
    const spoofed = await store.recordCommitReview("sample-stream", { tree, baseHead, verdict: "GO", reviewRole: "structural-challenge", reviewerId: "019f0000-0000-7000-8000-000000000011", nativeReviewerId: "019f0000-0000-7000-8000-000000000011", provider: "openai", model: "gpt-5.6-sol", summary: "Caller-controlled spoof" });
    assert.equal(spoofed.metadata.reviewerIdentityVerified, false);
    await exec(process.execPath, [cli, "commit-review", "record", "sample-stream", "--tree", tree, "--base-head", baseHead, "--role", "structural-challenge", "--provider", "openai", "--model", "gpt-5.6-sol", "--summary", "Fallback identity spoof"], { env: { ...mock.env, FIELD_REPORT_SESSION_ID: "019f0000-0000-7000-8000-000000000011" } });
    await exec(process.execPath, [cli, "commit-review", "record", "sample-stream", "--tree", tree, "--base-head", baseHead, "--role", "deep-code-review", "--provider", "openai", "--model", "gpt-5.6-sol", "--summary", "Deep review clear"], { env: { ...mock.env, CODEX_THREAD_ID: "019f0000-0000-7000-8000-000000000010" } });
    const blocked = await exec(process.execPath, [cli, "commit-check", "sample-stream"], { env: mock.env }).catch((error) => error);
    assert.match(`${blocked.stderr || ""}${blocked.stdout || ""}`, /missing local structural-challenge/);
    await exec(process.execPath, [cli, "commit-review", "record", "sample-stream", "--tree", tree, "--base-head", baseHead, "--role", "structural-challenge", "--provider", "openai", "--model", "gpt-5.6-sol", "--summary", "Structural review clear"], { env: { ...mock.env, CODEX_THREAD_ID: "019f0000-0000-7000-8000-000000000011" } });
    const stillBlocked = await exec(process.execPath, [cli, "commit-check", "sample-stream"], { env: mock.env }).catch((error) => error);
    assert.match(`${stillBlocked.stderr || ""}${stillBlocked.stdout || ""}`, /missing local deep-code-review/);
    await writeFile(path.join(mock.root, "candidate.txt"), "changed\n");
    await exec("git", ["add", "candidate.txt"], { cwd: mock.root });
    const changed = await exec(process.execPath, [cli, "commit-check", "sample-stream"], { env: mock.env }).catch((error) => error);
    assert.match(`${changed.stderr || ""}${changed.stdout || ""}`, /missing local deep-code-review/);
  } finally {
    await mock.close();
  }
});

test("fr commit creates a commit after the exact staged tree is reviewed", async () => {
  const mock = await localFixture();
  try {
    const ownerId = "019f0000-0000-7000-8000-000000000020";
    const deepId = "019f0000-0000-7000-8000-000000000021";
    const structuralId = "019f0000-0000-7000-8000-000000000022";
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [
      { id: ownerId, alias: "sample-agent", kind: "codex" },
      { id: deepId, alias: "deep-review", kind: "codex" },
      { id: structuralId, alias: "structural-review", kind: "codex" }
    ] }));
    const streamPath = path.join(mock.root, "workstreams", "sample-stream.json");
    const stream = JSON.parse(await readFile(streamPath, "utf8"));
    await writeFile(streamPath, JSON.stringify({ ...stream, orchestrator: ownerId }, null, 2));
    await mkdir(mock.env.FIELD_REPORT_STATE_DIR, { recursive: true });
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [ownerId]: { workstreamId: "sample-stream", role: "workstream-orchestrator" } } }));
    const spoof = await exec(process.execPath, [cli, "session", "reviewer", "deep-review", "--id", deepId, "--model", "gpt-5.6-sol", "--provider", "openai"], { env: { ...mock.env, FIELD_REPORT_SESSION_ID: ownerId } }).catch((error) => error);
    assert.match(`${spoof.stderr || ""}${spoof.stdout || ""}`, /assigned native workstream orchestrator/);
    for (const [reviewerId, alias] of [[deepId, "deep-review"], [structuralId, "structural-review"]]) {
      await exec(process.execPath, [cli, "session", "reviewer", alias, "--id", reviewerId, "--model", "gpt-5.6-sol", "--provider", "openai"], { env: { ...mock.env, CODEX_THREAD_ID: ownerId } });
    }
    await writeFile(path.join(mock.root, "candidate.txt"), "candidate\n");
    await exec("git", ["add", "candidate.txt"], { cwd: mock.root });
    const tree = (await exec("git", ["write-tree"], { cwd: mock.root })).stdout.trim();
    const baseHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const fakeBin = await installFakeCodex(mock.root);
    await writeFile(path.join(mock.root, "review.txt"), "Inspect the exact candidate without waiving the fixed rubric.\n");
    const reviewEnv = { ...mock.env, CODEX_THREAD_ID: ownerId, PATH: `${fakeBin}:${process.env.PATH}` };
    for (const role of ["deep-code-review", "structural-challenge"]) await exec(process.execPath, [cli, "commit-review", "run-sol", "sample-stream", "--role", role, "--prompt-file", path.join(mock.root, "review.txt"), "--evidence-file", path.join(mock.root, `commit-${role}.jsonl`)], { env: reviewEnv });
    const result = await exec(process.execPath, [cli, "commit", "sample-stream", "--message", "Reviewed candidate"], { env: { ...mock.env, FIELD_REPORT_SESSION_ID: ownerId } });
    assert.match(result.stdout, /Reviewed candidate/);
    assert.notEqual((await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim(), baseHead);
    assert.equal((await exec("git", ["show", "HEAD:candidate.txt"], { cwd: mock.root })).stdout, "candidate\n");
  } finally {
    await mock.close();
  }
});

test("fr commit-review run-sol launches the fixed Sol executable and records both witnessed lanes", async () => {
  const mock = await localFixture();
  try {
    const fakeBin = await installFakeCodex(mock.root);
    const ownerId = "019f0000-0000-7000-8000-000000000020";
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [{ id: ownerId, alias: "sample-agent", kind: "codex" }] }));
    const streamPath = path.join(mock.root, "workstreams", "sample-stream.json");
    const stream = JSON.parse(await readFile(streamPath, "utf8"));
    await writeFile(streamPath, JSON.stringify({ ...stream, orchestrator: ownerId }, null, 2));
    await mkdir(mock.env.FIELD_REPORT_STATE_DIR, { recursive: true });
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [ownerId]: { workstreamId: "sample-stream", role: "workstream-orchestrator" } } }));
    await writeFile(path.join(mock.root, "candidate.txt"), "candidate\n");
    await writeFile(path.join(mock.root, "review.txt"), "Review the exact packet. Report any correctness or structural defect. Return GO only with no findings.\n");
    await exec("git", ["add", "candidate.txt"], { cwd: mock.root });
    const env = { ...mock.env, CODEX_THREAD_ID: ownerId, PATH: `${fakeBin}:${process.env.PATH}` };
    const splitAuthority = await exec(process.execPath, [cli, "commit-review", "run-sol", "sample-stream", "--role", "deep-code-review", "--prompt-file", path.join(mock.root, "review.txt"), "--evidence-file", path.join(mock.root, "server-mode.jsonl")], { env: { ...env, FIELD_REPORT_URL: "http://127.0.0.1:1" } }).catch((error) => error);
    assert.match(`${splitAuthority.stderr || ""}${splitAuthority.stdout || ""}`, /direct local Field Report authority/);
    const setupFailurePath = path.join(mock.root, "missing-prompt.jsonl");
    const setupFailure = await exec(process.execPath, [cli, "commit-review", "run-sol", "sample-stream", "--role", "deep-code-review", "--prompt-file", path.join(mock.root, "absent.txt"), "--evidence-file", setupFailurePath], { env }).catch((error) => error);
    assert.match(`${setupFailure.stderr || ""}${setupFailure.stdout || ""}`, /ENOENT/);
    for (const file of [setupFailurePath, `${setupFailurePath}.review-packet.txt`, `${setupFailurePath}.schema.json`, `${setupFailurePath}.result.json`]) await assert.rejects(readFile(file), { code: "ENOENT" });
    for (const role of ["deep-code-review", "structural-challenge"]) {
      const evidencePath = path.join(mock.root, `run-${role}.jsonl`);
      const result = await exec(process.execPath, [cli, "commit-review", "run-sol", "sample-stream", "--role", role, "--prompt-file", path.join(mock.root, "review.txt"), "--evidence-file", evidencePath], { env });
      assert.match(result.stdout, new RegExp(`witnessed Sol ${role}`));
      assert.match(await readFile(evidencePath, "utf8"), /thread.started/);
      const duplicate = await exec(process.execPath, [cli, "commit-review", "run-sol", "sample-stream", "--role", role, "--prompt-file", path.join(mock.root, "review.txt"), "--evidence-file", evidencePath], { env }).catch((error) => error);
      assert.match(`${duplicate.stderr || ""}${duplicate.stdout || ""}`, /Refusing to overwrite witnessed Sol evidence sidecars/);
    }
    const ready = await exec(process.execPath, [cli, "commit-check", "sample-stream"], { env });
    assert.match(ready.stdout, /commit gate .* READY/);
  } finally {
    await mock.close();
  }
});

test("fr pass run-sol records exact-head witnessed MRR lanes and a head change invalidates them", async () => {
  const mock = await localFixture();
  try {
    const ownerId = "019f0000-0000-7000-8000-000000000020";
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [{ id: ownerId, alias: "sample-agent", kind: "codex" }] }));
    const streamPath = path.join(mock.root, "workstreams", "sample-stream.json");
    const stream = JSON.parse(await readFile(streamPath, "utf8"));
    await writeFile(streamPath, JSON.stringify({ ...stream, orchestrator: ownerId }, null, 2));
    await mkdir(mock.env.FIELD_REPORT_STATE_DIR, { recursive: true });
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [ownerId]: { workstreamId: "sample-stream", role: "workstream-orchestrator" } } }));
    const baseHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    await exec("git", ["update-ref", "refs/remotes/origin/main", baseHead], { cwd: mock.root });
    await writeFile(path.join(mock.root, "candidate.txt"), "candidate\n");
    await exec("git", ["add", "candidate.txt"], { cwd: mock.root });
    await exec("git", ["-c", "user.name=Field Report Test", "-c", "user.email=field-report@example.invalid", "commit", "-m", "candidate"], { cwd: mock.root });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mock.root })).stdout.trim();
    const fakeBin = await installFakeCodex(mock.root);
    const prompt = path.join(mock.root, "mrr-review.txt");
    await writeFile(prompt, "Review the exact branch candidate under the fixed rubric.\n");
    const env = { ...mock.env, CODEX_THREAD_ID: ownerId, PATH: `${fakeBin}:${process.env.PATH}` };
    for (const role of ["deep-code-review", "structural-challenge"]) await exec(process.execPath, [cli, "pass", "run-sol", "sample-stream", "--head", head, "--role", role, "--prompt-file", prompt, "--evidence-file", path.join(mock.root, `mrr-${role}.jsonl`)], { env });
    const events = (await readFile(path.join(mock.root, "events", "sample-stream.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter((event) => event.type === "review_pass");
    assert.deepEqual(events.slice(-2).map((event) => [event.metadata.reviewRole, event.metadata.head, event.metadata.provenanceVerified]), [["deep-code-review", head, true], ["structural-challenge", head, true]]);
    assert.deepEqual(events.slice(-2).map((event) => path.basename(event.metadata.evidencePath)), ["mrr-deep-code-review.jsonl", "mrr-structural-challenge.jsonl"]);
    const deepEvidence = path.join(mock.root, "mrr-deep-code-review.jsonl");
    const boundDigest = createHash("sha256").update(await readFile(deepEvidence)).update("\0field-report-sol-result\0").update(await readFile(`${deepEvidence}.result.json`)).digest("hex");
    assert.equal(events.at(-2).metadata.evidenceDigest, boundDigest);
    assert.match((await exec(process.execPath, [cli, "mrr", "sample-stream"], { env }).catch((error) => error)).stdout || "", /Fable|NOT READY/);
    await writeFile(path.join(mock.root, "candidate.txt"), "advanced\n");
    await exec("git", ["add", "candidate.txt"], { cwd: mock.root });
    await exec("git", ["-c", "user.name=Field Report Test", "-c", "user.email=field-report@example.invalid", "commit", "-m", "advance"], { cwd: mock.root });
    const stale = await exec(process.execPath, [cli, "mrr", "sample-stream"], { env }).catch((error) => error);
    assert.match(`${stale.stderr || ""}${stale.stdout || ""}`, /missing completed deep-code-review/);
  } finally {
    await mock.close();
  }
});

test("pre-commit hook is inert for humans and blocks unarmed, mismatched, or unreviewed Codex commits", async () => {
  const mock = await localFixture();
  try {
    await exec(process.execPath, [cli, "hook", "pre-commit"], { env: mock.env });
    const ownerId = "019f0000-0000-7000-8000-000000000020";
    const staleKindId = "019f0000-0000-7000-8000-000000000021";
    await writeFile(path.join(mock.root, "config", "sessions.json"), JSON.stringify({ sessions: [{ id: ownerId, alias: "sample-agent", kind: "codex" }, { id: staleKindId, alias: "stale-kind", kind: "other" }] }));
    const staleKind = await exec(process.execPath, [cli, "hook", "pre-commit"], { env: { ...mock.env, CODEX_THREAD_ID: staleKindId } }).catch((error) => error);
    assert.match(`${staleKind.stderr || ""}${staleKind.stdout || ""}`, /require an armed Field Report workstream/);
    const unarmed = await exec(process.execPath, [cli, "hook", "pre-commit"], { env: { ...mock.env, CODEX_THREAD_ID: ownerId } }).catch((error) => error);
    assert.match(`${unarmed.stderr || ""}${unarmed.stdout || ""}`, /require an armed Field Report workstream/);
    const streamPath = path.join(mock.root, "workstreams", "sample-stream.json");
    const stream = JSON.parse(await readFile(streamPath, "utf8"));
    await writeFile(streamPath, JSON.stringify({ ...stream, orchestrator: ownerId }, null, 2));
    await mkdir(mock.env.FIELD_REPORT_STATE_DIR, { recursive: true });
    await writeFile(path.join(mock.env.FIELD_REPORT_STATE_DIR, "state.json"), JSON.stringify({ sessions: { [ownerId]: { workstreamId: "sample-stream", role: "workstream-orchestrator" } } }));
    await writeFile(path.join(mock.root, "candidate.txt"), "candidate\n");
    await exec("git", ["add", "candidate.txt"], { cwd: mock.root });
    await exec(process.execPath, [cli, "hook", "pre-commit"], { env: { ...mock.env, FIELD_REPORT_SESSION_ID: ownerId } });
    const currentPath = path.join(mock.root, "data", "current.json");
    const current = JSON.parse(await readFile(currentPath, "utf8"));
    await writeFile(currentPath, JSON.stringify({ ...current, workstreams: current.workstreams.map((candidate) => candidate.id === "sample-stream" ? { ...candidate, branch: "stale/projected-branch" } : candidate) }));
    const blocked = await exec(process.execPath, [cli, "hook", "pre-commit"], { env: { ...mock.env, CODEX_THREAD_ID: ownerId } }).catch((error) => error);
    assert.match(`${blocked.stderr || ""}${blocked.stdout || ""}`, /commit gate .* BLOCKED/);
    await writeFile(streamPath, JSON.stringify({ ...stream, orchestrator: ownerId, branch: null }, null, 2));
    const unresolved = await exec(process.execPath, [cli, "hook", "pre-commit"], { env: { ...mock.env, CODEX_THREAD_ID: ownerId } }).catch((error) => error);
    assert.match(`${unresolved.stderr || ""}${unresolved.stdout || ""}`, /has no canonical branch/);
    await writeFile(streamPath, JSON.stringify({ ...stream, orchestrator: ownerId, branch: "another/branch" }, null, 2));
    const mismatched = await exec(process.execPath, [cli, "hook", "pre-commit"], { env: { ...mock.env, CODEX_THREAD_ID: ownerId } }).catch((error) => error);
    assert.match(`${mismatched.stderr || ""}${mismatched.stdout || ""}`, /bound to another\/branch/);
    await writeFile(streamPath, JSON.stringify({ ...stream, orchestrator: ownerId, project: "another-project" }, null, 2));
    const wrongProject = await exec(process.execPath, [cli, "hook", "pre-commit"], { env: { ...mock.env, CODEX_THREAD_ID: ownerId } }).catch((error) => error);
    assert.match(`${wrongProject.stderr || ""}${wrongProject.stdout || ""}`, /belongs to project another-project, not checkout project sample/);
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
