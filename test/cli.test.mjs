import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createStore } from "../src/store.mjs";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
function testEnv(state) {
  const env = { ...process.env, FIELD_REPORT_STATE_ROOT: state };
  delete env.CODEX_THREAD_ID;
  return env;
}
const run = async (args, cwd, state) => (await exec(process.execPath, [cli, ...args], { cwd, env: testEnv(state) })).stdout;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-cli-"));
  const repo = path.join(root, "repo"), origin = path.join(root, "origin.git"), state = path.join(root, "state");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["config", "user.email", "fr-test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Field Report Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "test\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  await exec("git", ["clone", "--bare", repo, origin]);
  await exec("git", ["remote", "add", "origin", origin], { cwd: repo });
  await exec("git", ["fetch", "origin"], { cwd: repo });
  await run(["project", "add", "sample", "--label", "Sample", "--repo", repo], repo, state);
  await run(["create", "outcome", "--project", "sample", "--title", "Outcome", "--outcome", "Ship bounded change", "--branch", "main", "--owner-task", "owner-1"], repo, state);
  return { root, repo, origin, state };
}

async function featureBranch({ repo, state }) {
  await exec("git", ["checkout", "-b", "feature"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "feature\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "feature"], { cwd: repo });
  await run(["update", "outcome", "--branch", "feature"], repo, state);
}

function scores(verdict = "GO") {
  return {
    scores: { mergeReadiness: verdict === "GO" ? 90 : 55, structuralRisk: verdict === "GO" ? 10 : 40, implementationQuality: 80, evidenceConfidence: 90, outcomeConfidence: 80 },
    scoreRationale: { mergeReadiness: "n", structuralRisk: "n", implementationQuality: "n", evidenceConfidence: "n", outcomeConfidence: "n" },
    necessity: "necessary", simplerPath: "None found.", scopeDrift: "none", contractIntegrity: verdict === "GO" ? "sound" : "mixed", evidenceQuality: "strong"
  };
}

test("checkout gate prints a self-register command for an unbound branch", async () => {
  const { repo, state } = await fixture();
  assert.match(await run(["gate", "checkout", "outcome"], repo, state), /bound to this checkout/);
  assert.match(await run(["gate", "commit", "outcome"], repo, state), /bound to this checkout/);
  await exec("git", ["branch", "-m", "unsafe'quote"], { cwd: repo });
  await assert.rejects(run(["gate", "checkout", "outcome"], repo, state), /not bound to this checkout/);
  await assert.rejects(run(["gate", "crr"], repo, state), (error) => /Self-register without coordinator approval/.test(error.stderr || "") && (error.stderr || "").includes(`--branch 'unsafe'"'"'quote'`));
});

test("identity names the coordinator into the project namespace", async () => {
  const { repo, state } = await fixture();
  const identity = JSON.parse(await run(["identity", "--role", "coordinator"], repo, state));
  assert.equal(identity.key, "sample/coordinator");
  assert.equal(identity.fallback, "sample/coordinator-2");
  assert.match(identity.instruction, /Do not ask the user to name you/);
});

test("a next action is a sticky note on context and show", async () => {
  const { repo, state } = await fixture();
  await assert.rejects(run(["update", "outcome", "--next"], repo, state), /Specify --next/);
  assert.match(await run(["update", "outcome", "--next", "Record CRR then commit"], repo, state), /Updated outcome/);
  assert.match(await run(["context", "outcome"], repo, state), /Next: Record CRR then commit/);
  assert.match(await run(["context", "outcome"], repo, state), /Reviews never require permission/);
  assert.match(await run(["context", "outcome"], repo, state), /Product and domain questions go to the user/);
  assert.match(await run(["context", "outcome"], repo, state), /do not infer them from schema or code/);

  assert.match(await run(["show", "outcome"], repo, state), /Next: Record CRR then commit/);
});

test("hook uninstall removes a v3 managed hook without a v4 reinstall", async () => {
  const { repo, state } = await fixture();
  const hook = (await exec("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: repo })).stdout.trim();
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, "#!/bin/sh\n# field-report-commit-gate:v3\nexit 0\n", { mode: 0o755 });
  assert.match(await run(["hook", "uninstall", "sample"], repo, state), /removed checkout hook/);
  await assert.rejects(readFile(hook), (error) => error.code === "ENOENT");
  await writeFile(hook, "#!/bin/sh\nnpm test\n", { mode: 0o755 });
  await assert.rejects(run(["hook", "uninstall", "sample"], repo, state), /not installed/);
});

test("crr briefs prefer a local native subagent", async () => {
  const { repo, state } = await fixture();
  await writeFile(path.join(repo, "README.md"), "review me\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  const crr = JSON.parse(await run(["review", "brief", "outcome", "--kind", "crr", "--role", "crr"], repo, state));
  assert.equal(crr.delegation.role, "crr");
  assert.equal(crr.delegation.kind, "crr");
  assert.equal(crr.execution.mcp, "none");
  assert.equal(crr.execution.route, "native");
  assert.match(crr.execution.launch, /Prefer a local model/);
  assert.match(crr.prompt, /delegationId=/);
  assert.doesNotMatch(crr.prompt, /necessity=/);
});

test("mrr briefs seat Astra, Grok, and Fable and isolate reviewers from AF", async () => {
  const { repo, state } = await fixture();
  await featureBranch({ repo, state });
  const deep = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "deep-code-review"], repo, state));
  const structural = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge"], repo, state));
  const fable = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "fable-challenge"], repo, state));
  assert.equal(deep.delegation.model, "gpt-6-astra");
  assert.deepEqual(deep.delegation.seatModels, ["gpt-6-astra", "gpt-5.6-sol"]);
  assert.equal(structural.delegation.model, "grok-4.6");
  assert.equal(fable.delegation.model, "claude-opus-5-5");
  assert.equal(deep.execution.mcp, "none");
  assert.match(deep.execution.launch, /codex exec -m gpt-6-astra/);
  assert.match(deep.execution.launch, /--ignore-user-config/);
  assert.match(deep.execution.launch, /--color never/);
  assert.doesNotMatch(deep.execution.launch, /--ask-for-approval/);
  assert.match(structural.execution.launch, /fr-cursor-review --model cursor-grok-4.6-high --print --output-format stream-json/);
  assert.doesNotMatch(structural.execution.launch, /--force|--yolo|--mode ask|--approve-mcps/);
  assert.match(fable.execution.launch, /--model claude-opus-5-5/);
  assert.doesNotMatch(fable.execution.launch, /anthropic\.claude-fable-5/);
  assert.match(fable.execution.launch, /git rev-parse HEAD/);
  assert.match(fable.execution.launch, /git status --porcelain/);
  assert.match(fable.execution.launch, /--strict-mcp-config/);
  assert.match(fable.execution.launch, new RegExp(`Bash\\(git diff --no-ext-diff --no-textconv ${fable.delegation.baseHead} ${fable.delegation.head} --\\)`));
  assert.doesNotMatch(fable.execution.launch, /Bash\(git diff \*\)/);
  assert.doesNotMatch(fable.execution.launch, /claude-aws/);
  assert.doesNotMatch(fable.execution.launch, /Bash\(git \*\)/);
  assert.match(deep.prompt, /delegationId=/);
  for (const brief of [deep, structural, fable]) assert.doesNotMatch(brief.prompt, /\bprovider\b/);
  assert.match(deep.prompt, /Do not run fr, owner skills, MCP servers, or AF/);
  assert.equal(deep.inspection.command, `git diff --no-ext-diff --no-textconv ${deep.delegation.baseHead} ${deep.delegation.head} --`);
  const sol = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "deep-code-review", "--model", "gpt-5.6-sol"], repo, state));
  assert.equal(sol.delegation.model, "gpt-5.6-sol");
  assert.equal(sol.execution.intended, "gpt-6-astra");
  assert.match(sol.execution.launch, /codex exec -m gpt-5.6-sol /);
  await assert.rejects(run(["review", "brief", "outcome", "--kind", "mrr", "--role", "deep-code-review", "--model", "gpt-5.6-terra"], repo, state), /gpt-5.6-terra is not a valid deep-code-review model/);
  const fable5 = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "fable-challenge", "--model", "claude-fable-5"], repo, state));
  assert.equal(fable5.delegation.model, "claude-fable-5");
  assert.match(fable5.execution.launch, /--model claude-fable-5 /);
});

test("worktree persona launches use the reviewed checkout instead of the configured project root", async () => {
  const { root, repo, state } = await fixture();
  const worktree = path.join(root, "review worktree");
  await exec("git", ["worktree", "add", "-b", "feature", worktree], { cwd: repo });
  const worktreeRoot = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: worktree })).stdout.trim();
  await writeFile(path.join(worktree, "README.md"), "worktree change\n");
  await exec("git", ["add", "README.md"], { cwd: worktree });
  await exec("git", ["commit", "-m", "worktree feature"], { cwd: worktree });
  await run(["update", "outcome", "--branch", "feature"], worktree, state);
  const mainHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const deep = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "deep-code-review"], worktree, state));
  const fable = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "fable-challenge"], worktree, state));
  assert.notEqual(deep.delegation.head, mainHead);
  for (const brief of [deep, fable]) {
    assert.ok(brief.execution.launch.includes(`cd "${worktreeRoot}"`), brief.execution.launch);
    assert.ok(!brief.execution.launch.includes(`cd "${repo}"`), brief.execution.launch);
  }
});

test("version identifies runtime source and revision independently of the current checkout", async () => {
  const { repo, state } = await fixture();
  const runtimeRoot = path.dirname(path.dirname(cli));
  const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: runtimeRoot })).stdout.trim();
  const { version } = JSON.parse(await readFile(path.join(runtimeRoot, "package.json"), "utf8"));
  assert.equal(await run(["version"], repo, state), `Field Report ${version}\nRuntime source: ${runtimeRoot}\nGit revision: ${revision}\n`);
});

test("mrr native route isolates a fresh subagent", async () => {
  const { repo, state } = await fixture();
  await featureBranch({ repo, state });
  const native = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "deep-code-review", "--route", "native"], repo, state));
  assert.equal(native.execution.route, "native");
  assert.match(native.execution.launch, /fresh native gpt-6-astra subagent/);
  assert.match(native.execution.launch, /no MCP servers, including agent-fixes/);
  const nativeFable = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "fable-challenge", "--route", "native"], repo, state));
  assert.equal(nativeFable.execution.route, "native");
  assert.match(nativeFable.execution.launch, /fresh native claude-opus-5-5 subagent/);
});

test("a seat rerun after a fix carries that seat's own open findings", async () => {
  const { repo, state } = await fixture();
  await featureBranch({ repo, state });
  const structural = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge"], repo, state));
  await run(["review", "bind", "outcome", "--delegation", structural.delegation.id, "--task-id", "grok-run"], repo, state);
  const review = {
    reviewComplete: true, independent: true, delegationId: structural.delegation.id, reviewerTaskId: "grok-run",
    claim: structural.delegation.claim, kind: "mrr", role: "structural-challenge",
    head: structural.delegation.head, baseHead: structural.delegation.baseHead,
    provider: "cursor", model: "grok-4.6", route: "cli", verdict: "NO_GO", findings: ["Finding one"], unresolved: [],
    summary: "Reviewed", ...scores("NO_GO")
  };
  const file = path.join(repo, "review.json");
  await writeFile(file, `\`\`\`json\n${JSON.stringify(review)}\n\`\`\``);
  assert.match(await run(["review", "record", "outcome", "--file", file], repo, state), /Assigned finding IDs: F1/);
  const fable = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "fable-challenge"], repo, state));
  assert.equal(fable.delegation.prior, undefined);
  await writeFile(path.join(repo, "README.md"), "fixed\n");
  await exec("git", ["commit", "-am", "fix"], { cwd: repo });
  const rerun = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge"], repo, state));
  assert.deepEqual(rerun.delegation.prior, [{ id: "F1", text: "Finding one" }]);
  assert.match(rerun.prompt, /This seat's open findings from an earlier head[\s\S]*- F1: Finding one/);
  const deep = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "deep-code-review"], repo, state));
  assert.equal(deep.delegation.prior, undefined);
});

test("a completed review settles its seat on that head; fail and shopping are not escapes", async () => {
  const { repo, state } = await fixture();
  await featureBranch({ repo, state });
  const unused = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge"], repo, state));
  const second = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge"], repo, state));
  assert.notEqual(unused.delegation.id, second.delegation.id);
  await assert.rejects(run(["review", "fail", "outcome", "--delegation", unused.delegation.id, "--task-id", "never-started", "--reason", "no envelope"], repo, state), /does not record provider failure/);
  await assert.rejects(run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge", "--model", "gpt-6-astra"], repo, state), /gpt-6-astra is not a valid structural-challenge model \(valid: grok-4\.6\)/);
  await run(["review", "bind", "outcome", "--delegation", unused.delegation.id, "--task-id", "grok-run"], repo, state);
  const review = {
    reviewComplete: true, independent: true, delegationId: unused.delegation.id, reviewerTaskId: "grok-run",
    claim: unused.delegation.claim, kind: "mrr", role: "structural-challenge",
    head: unused.delegation.head, baseHead: unused.delegation.baseHead,
    provider: "cursor", model: "grok-4.6", route: "cli", verdict: "NO_GO", findings: ["Unsound boundary"], unresolved: [],
    summary: "Reviewed", ...scores("NO_GO")
  };
  const file = path.join(repo, "review.json");
  await writeFile(file, JSON.stringify(review));
  await run(["review", "record", "outcome", "--file", file], repo, state);
  await assert.rejects(run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge", "--model", "grok-4.6-high"], repo, state), /already reviewed this head \(NO_GO\)/);
  await assert.rejects(run(["gate", "open", "outcome"], repo, state), /structural-challenge NO_GO on this head/);
  const status = await run(["review", "status", "outcome", "--kind", "mrr"], repo, state);
  assert.match(status, /BLOCKED/);
  assert.match(status, /F1: Unsound boundary/);
});

test("coordinator workflow keeps user-owned collaborators and the thin loop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-workflow-"));
  const output = await run(["workflow", "coordinator"], root, path.join(root, "state"));
  assert.match(output, /When the user explicitly asks for an agent they will work with directly, create a user-owned task/);
  const shared = await run(["workflow"], root, path.join(root, "state"));
  assert.match(shared, /CRR against the exact staged tree/);
  assert.match(shared, /every seat's deciding review is a GO/);
  assert.match(shared, /Reviews never require permission/);
  assert.match(shared, /fr review accept/);
  assert.match(shared, /fr decide/);
  assert.match(shared, /rerun only the seat that said NO_GO/);
  assert.match(shared, /does not record provider failure/);
  assert.match(shared, /Do not auto-open a pull request/);
  assert.match(shared, /Reviewers must not use MCP servers or AF/);
  assert.match(shared, /empty user-level MCP file/);
  assert.match(shared, /does not hide repository-scoped Cursor MCP/);
  assert.match(shared, /Do not wrap `git commit`/);
  assert.match(shared, /Do not collapse MRR into a generic family panel/);
  assert.match(shared, /Launch implementation workers as fresh subagents/);
  assert.match(shared, /Do not restore `claude-aws`/);
  assert.match(shared, /Do not add `fr question`/);
  assert.match(shared, /Tabula Rasa Review is an informational pass/);
  assert.match(shared, /Do not add `kind=trr`/);
  assert.match(shared, /Do not commission MRR because the user asked for TRR/);
  assert.match(shared, /do not infer them from the repo/);
  assert.match(shared, /Those questions never go to a reviewer model/);
  assert.match(shared, /Do not dispatch a worker to settle a product or domain question/);

  assert.doesNotMatch(shared, /fr review (waive|adjudicate)/);
  assert.match(shared, /one-line next action/);
  assert.match(shared, /green checkout hook is not CRR/);
  assert.match(shared, /empty GitHub check rollup is not evidence that CI ran/);
  assert.match(shared, /fr gate bots` stays BLOCKED until checks are observed/);
  assert.match(shared, /My Machines worker/);
  assert.match(shared, /native same-type/);
  assert.match(shared, /fr machines invoke/);
  assert.doesNotMatch(shared, /accessible\.sol|fr machines status|fr machines worker/);
  const help = await run(["help"], root, path.join(root, "state"));
  assert.doesNotMatch(help, /fr question|fr catchup|fr publish|fr delegate/);
  assert.match(help, /fr machines invoke/);
  assert.match(help, /fr review accept/);
  assert.match(help, /fr decide/);
  assert.doesNotMatch(help, /fr review (waive|adjudicate)/);
  assert.doesNotMatch(help, /fr review fail/);
  assert.doesNotMatch(help, /fr machines \[status\|worker\]|fr machines status|fr machines worker/);
});

const mrrModels = {
  "deep-code-review": { model: "gpt-6-astra", provider: "openai" },
  "structural-challenge": { model: "grok-4.6", provider: "cursor" },
  "fable-challenge": { model: "claude-opus-5-5", provider: "anthropic" }
};

async function recordMrrLane(repo, state, role, taskId, stream = "outcome") {
  const brief = JSON.parse(await run(["review", "brief", stream, "--kind", "mrr", "--role", role], repo, state));
  await run(["review", "bind", stream, "--delegation", brief.delegation.id, "--task-id", taskId], repo, state);
  const seated = mrrModels[role];
  const review = {
    reviewComplete: true, independent: true, delegationId: brief.delegation.id, reviewerTaskId: taskId,
    claim: brief.delegation.claim, kind: "mrr", role,
    head: brief.delegation.head, baseHead: brief.delegation.baseHead,
    provider: seated.provider, model: brief.delegation.model, route: "cli",
    verdict: "GO", findings: [], unresolved: [],
    summary: "Complete adversarial review", ...scores("GO")
  };
  const file = path.join(state, `${taskId}.json`);
  await writeFile(file, JSON.stringify(review));
  await run(["review", "record", stream, "--file", file], repo, state);
  return brief;
}

test("the user's acceptance of a finding unblocks its seat and is printed", async () => {
  const { repo, state } = await fixture();
  await featureBranch({ repo, state });
  const brief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge"], repo, state));
  await run(["review", "bind", "outcome", "--delegation", brief.delegation.id, "--task-id", "grok-run"], repo, state);
  const file = path.join(state, "grok.json");
  await writeFile(file, JSON.stringify({
    reviewComplete: true, independent: true, delegationId: brief.delegation.id, provider: "cursor", verdict: "NO_GO",
    findings: ["Unlikely edge that fails safe"], unresolved: [], questions: ["Should the edge be handled at all?"], summary: "Reviewed", ...scores("NO_GO")
  }));
  await run(["review", "record", "outcome", "--file", file], repo, state);
  await recordMrrLane(repo, state, "deep-code-review", "sol-run");
  await recordMrrLane(repo, state, "fable-challenge", "fable-run");
  await assert.rejects(run(["gate", "open", "outcome"], repo, state), /F1: Unlikely edge/);
  assert.match(await run(["review", "status", "outcome", "--kind", "mrr"], repo, state), /Questions for the user: Should the edge be handled at all\?/);
  await assert.rejects(run(["review", "accept", "outcome", "--finding", "F9", "--reason", "x"], repo, state), /Unknown MRR finding: F9/);
  await assert.rejects(run(["review", "accept", "outcome", "--finding", "F1"], repo, state), /Specify --reason/);
  await assert.rejects(run(["review", "accept", "outcome", "--finding", "F1", "--reason", "Fails safe; not worth a fix"], repo, state), /Specify --actor/);
  await assert.rejects(run(["review", "accept", "outcome", "--finding", "F1", "--reason", "Fails safe; not worth a fix", "--actor"], repo, state), /Specify --actor/);
  await assert.rejects(run(["review", "accept", "outcome", "--finding", "F1", "--reason", "--actor", "user"], repo, state), /Specify --reason/);
  assert.match(await run(["review", "accept", "outcome", "--finding", "F1", "--reason", "Fails safe; not worth a fix", "--actor", "user"], repo, state), /Recorded acceptance of F1 \(structural-challenge\) by user/);
  const open = await run(["gate", "open", "outcome"], repo, state);
  assert.match(open, /READY/);
  assert.match(open, /structural-challenge F1 accepted by user: Fails safe; not worth a fix/);
});

test("user decisions travel with every review brief", async () => {
  const { repo, state } = await fixture();
  await featureBranch({ repo, state });
  assert.match(await run(["decide", "outcome", "Three labs is only a default"], repo, state), /Recorded decision 1/);
  await assert.rejects(run(["decide", "outcome"], repo, state), /Specify the decision text/);
  const brief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "fable-challenge"], repo, state));
  assert.match(brief.prompt, /User decisions\. These are settled product choices; do not re-litigate them:\n- Three labs is only a default/);
  assert.match(await run(["context", "outcome"], repo, state), /Decisions: Three labs is only a default/);
});

test("later commits carry earlier seat reviews forward and print the unreviewed delta", async () => {
  const { repo, state } = await fixture();
  await featureBranch({ repo, state });
  await recordMrrLane(repo, state, "deep-code-review", "sol-run");
  await recordMrrLane(repo, state, "structural-challenge", "grok-run");
  await recordMrrLane(repo, state, "fable-challenge", "fable-run");
  const ready = await run(["context", "outcome"], repo, state);
  assert.match(ready, /MRR: READY on this HEAD\n/);
  assert.match(ready, /readiness 90%/);
  await writeFile(path.join(repo, "README.md"), "churn\n");
  await exec("git", ["commit", "-am", "churn"], { cwd: repo });
  const carried = await run(["context", "outcome"], repo, state);
  assert.match(carried, /MRR: READY \(carried; not reviewed on this HEAD by: deep-code-review, structural-challenge, fable-challenge\); deep-code-review: GO at [0-9a-f]{12} carried; [0-9a-f]{12}\.\.[0-9a-f]{12} not reviewed by this seat/);
  assert.match(carried, /not this HEAD/);
  assert.match(await run(["gate", "open", "outcome"], repo, state), /open gate at [0-9a-f]{12}: READY \(carried; not reviewed on this HEAD by: deep-code-review/);
  await assert.rejects(run(["gate", "bots", "outcome"], repo, state), /GitHub lookup failed:/);
});

test("raw review recording preserves source and limitations without owner identity repair", async () => {
  const { root, repo, state } = await fixture();
  await featureBranch({ repo, state });
  const brief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "fable-challenge"], repo, state));
  const d = brief.delegation;
  await run(["review", "bind", "outcome", "--delegation", d.id, "--task-id", "original-fable-run"], repo, state);
  const replacement = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "fable-challenge"], repo, state));
  await assert.rejects(run(["review", "bind", "outcome", "--delegation", replacement.delegation.id, "--task-id", "original-fable-run"], repo, state), /already bound/);
  const file = path.join(root, "original.json");
  const raw = { reviewComplete: true, independent: true, provider: "anthropic", verdict: "NO_GO",
    findings: [], unresolved: ["Cannot mechanically inspect base-to-head diff"], summary: "Review is limited", ...scores("NO_GO") };
  const source = JSON.stringify({ subtype: "success", is_error: false, result: `\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`` });
  await writeFile(file, source);
  await run(["review", "record", "outcome", "--delegation", d.id, "--file", file], repo, state);
  const [recorded] = await createStore(state).reviews("outcome");
  assert.equal(recorded.sourceText, source);
  assert.equal(recorded.delegationId, d.id);
  assert.equal(recorded.reviewerTaskId, "original-fable-run");
  assert.equal(recorded.verdict, "NO_GO");
  assert.deepEqual(recorded.unresolved, raw.unresolved);
  await assert.rejects(run(["gate", "open", "outcome"], repo, state), /fable-challenge NO_GO on this head/);
});

test("record refuses conflicting provenance, pass, and lossy evidence instead of manufacturing GO", async () => {
  const { root, repo, state } = await fixture();
  await featureBranch({ repo, state });
  const { delegation: d } = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "deep-code-review"], repo, state));
  await run(["review", "bind", "outcome", "--delegation", d.id, "--task-id", "original-astra"], repo, state);
  const file = path.join(root, "output.json");
  const raw = { reviewComplete: true, independent: true, provider: "openai", verdict: "GO", findings: [], unresolved: [], summary: "Reviewed", ...scores() };
  for (const extra of [
    { delegationId: "unknown", reviewerTaskId: "original-astra" },
    { head: "f".repeat(40) }, { reviewerTaskId: "replacement-task" },
    { verdict: "pass", summary: "Could not inspect diff" },
    { unresolved: [{ limitation: "Could not inspect diff" }] },
    { findings: [{ text: "Looks fine", caveat: "Could not inspect diff" }] }
  ]) {
    await writeFile(file, JSON.stringify({ ...raw, ...extra }));
    await assert.rejects(run(["review", "record", "outcome", "--delegation", d.id, "--file", file], repo, state));
  }
  await writeFile(file, JSON.stringify({ ...raw, delegationId: "unknown", reviewerTaskId: "original-astra" }));
  await assert.rejects(run(["review", "record", "outcome", "--file", file], repo, state));
  assert.deepEqual(await createStore(state).reviews("outcome"), []);
  // The unedited substantive result needs no duplicated routing identity.
  await writeFile(file, JSON.stringify(raw));
  await run(["review", "record", "outcome", "--delegation", d.id, "--file", file], repo, state);
  assert.equal((await createStore(state).reviews("outcome"))[0].verdict, "GO");
});

test("context and identity print the project's todo tracker", async () => {
  const { repo, state } = await fixture();
  assert.match(await run(["context", "outcome"], repo, state), /Todos: AF issues in namespace sample/);
  assert.match(await run(["context", "outcome"], repo, state), /Session name: sample\/owner/);
  await assert.rejects(run(["project", "update", "sample", "--linear-team", "ENG"], repo, state), /require --tracker linear/);
  await assert.rejects(run(["project", "update", "sample", "--tracker"], repo, state), /Specify --tracker <value>/);
  await run(["project", "update", "sample", "--tracker", "linear", "--linear-team", "ENG", "--linear-label", "agent-todo"], repo, state);
  assert.match(await run(["context", "outcome"], repo, state), /Todos: Linear team ENG, label agent-todo/);
  assert.equal(JSON.parse(await run(["identity", "--role", "owner"], repo, state)).todos, "Linear team ENG, label agent-todo");
  assert.match(await run(["project", "list"], repo, state), /\tlinear:ENG\/agent-todo\n$/);
  await assert.rejects(run(["project", "update", "sample", "--clear-linear-label", "yes"], repo, state), /takes no value/);
  await run(["project", "update", "sample", "--clear-linear-label"], repo, state);
  assert.match(await run(["context", "outcome"], repo, state), /Todos: Linear team ENG\n/);
  assert.match(await run(["project", "list"], repo, state), /\tlinear:ENG\n$/);
  await run(["project", "update", "sample", "--linear-label", "agent-todo"], repo, state);
  await run(["project", "update", "sample", "--linear-team", "OPS"], repo, state);
  assert.match(await run(["project", "list"], repo, state), /\tlinear:OPS\n$/, "a team change drops the old label");
});

test("project add accepts a Linear tracker", async () => {
  const { repo, state } = await fixture();
  const other = await mkdtemp(path.join(os.tmpdir(), "fr-cli-add-"));
  await run(["project", "add", "linear-sample", "--label", "Linear", "--repo", other, "--tracker", "linear", "--linear-team", "ENG", "--linear-label", "agent-todo"], repo, state);
  assert.match(await run(["project", "list"], repo, state), /^linear-sample\tmain\t.*\tlinear:ENG\/agent-todo$/m);
  assert.match(await run(["project", "list"], repo, state), /^sample\tmain\t.*\taf$/m);
  await assert.rejects(run(["project", "add", "broken", "--label", "Broken", "--repo", other, "--tracker", "linear"], repo, state), /needs --linear-team/);
});
