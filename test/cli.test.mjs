import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
const run = async (args, cwd, state) => (await exec(process.execPath, [cli, ...args], { cwd, env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-cli-"));
  const repo = path.join(root, "repo"), state = path.join(root, "state");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["config", "user.email", "fr-test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Field Report Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "test\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  await run(["project", "add", "sample", "--label", "Sample", "--repo", repo], repo, state);
  await run(["create", "outcome", "--project", "sample", "--title", "Outcome", "--outcome", "Ship bounded change", "--branch", "main", "--owner-task", "owner-1"], repo, state);
  return { root, repo, state };
}

test("work delegation makes AF best-effort and forbids conversation inheritance", async () => {
  const { repo, state } = await fixture();
  await exec("git", ["branch", "-m", "unsafe'quote"], { cwd: repo });
  await assert.rejects(run(["gate", "commit"], repo, state), (error) => /Self-register without coordinator approval/.test(error.stderr || "") && (error.stderr || "").includes(`--branch 'unsafe'"'"'quote'`));
  await exec("git", ["branch", "-m", "main"], { cwd: repo });
  const brief = JSON.parse(await run(["delegate", "brief", "outcome", "--role", "executor", "--slice", "Implement one bounded change"], repo, state));
  assert.deepEqual(brief.execution, { conversationInheritance: "none", allowedRoutes: ["native", "cli"], families: ["codex", "cursor", "claude"] });
  assert.match(brief.prompt, /AF is useful context, never a gate/);
  assert.match(brief.prompt, /fails, report that briefly and continue/);
});

test("review briefs are family-specific, comprehensive, exact-target, and optionally carry reconciliation", async () => {
  const { repo, state } = await fixture();
  await writeFile(path.join(repo, "README.md"), "review me\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  const brief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "commit", "--reviewer", "cursor", "--route", "cli"], repo, state));
  assert.equal(brief.delegation.role, "comprehensive-review");
  assert.equal(brief.delegation.reviewerFamily, "cursor");
  assert.deepEqual(brief.execution, { conversationInheritance: "none", allowedRoutes: ["native", "cli"], families: ["codex", "cursor", "claude"] });
  assert.match(brief.prompt, /Review comprehensively: correctness/);
  assert.match(brief.prompt, /necessity, simplicity, authority boundaries/);
  assert.match(brief.prompt, /Do not inherit or request the owner's conversation/);
  assert.match(brief.prompt, /AF may be attempted.*failure must not block/);
  assert.match(brief.prompt, /reviewerFamily=cursor/);
  assert.match(brief.prompt, /route=cli/);
  assert.match(brief.prompt, /Current claim JSON string/);
  assert.equal(brief.inspection.command, `git diff --no-ext-diff --no-textconv ${brief.delegation.baseHead} ${brief.delegation.tree} --`);

  await run(["review", "bind", "outcome", "--delegation", brief.delegation.id, "--task-id", "cursor-run"], repo, state);
  const review = { reviewComplete: true, independent: true, delegationId: brief.delegation.id, reviewerTaskId: "cursor-run", claim: brief.delegation.claim, kind: "commit", role: "comprehensive-review", reviewerFamily: "cursor", head: brief.delegation.head, baseHead: brief.delegation.baseHead, tree: brief.delegation.tree, provider: "cursor", model: "cursor-current", route: "cli", verdict: "NO_GO", findings: ["Finding one"], unresolved: [], summary: "Reviewed", scores: { mergeReadiness: 70, structuralRisk: 30, implementationQuality: 75, evidenceConfidence: 90, outcomeConfidence: 72 }, scoreRationale: { mergeReadiness: "Blocked", structuralRisk: "Moderate", implementationQuality: "Mostly sound", evidenceConfidence: "Direct", outcomeConfidence: "Finding remains" }, necessity: "necessary", simplerPath: "No simpler path found.", scopeDrift: "none", contractIntegrity: "mixed", evidenceQuality: "strong" };
  const file = path.join(repo, "review.json");
  await writeFile(file, `\`\`\`json\n${JSON.stringify(review)}\n\`\`\``);
  await run(["review", "record", "outcome", "--file", file], repo, state);
  const fresh = JSON.parse(await run(["review", "brief", "outcome", "--kind", "commit", "--reviewer", "codex", "--route", "native"], repo, state));
  assert.equal(fresh.delegation.outstanding, undefined);
  const reconcile = JSON.parse(await run(["review", "brief", "outcome", "--kind", "commit", "--reviewer", "claude", "--route", "cli", "--reconcile"], repo, state));
  assert.deepEqual(reconcile.delegation.outstanding, [{ id: "F1", category: "finding", text: "Finding one" }]);

  await run(["review", "bind", "outcome", "--delegation", fresh.delegation.id, "--task-id", "codex-run"], repo, state);
  const freshReview = { ...review, delegationId: fresh.delegation.id, reviewerTaskId: "codex-run", reviewerFamily: "codex", provider: "openai", route: "native", head: fresh.delegation.head, baseHead: fresh.delegation.baseHead, tree: fresh.delegation.tree, verdict: "GO", findings: [], contractIntegrity: "sound", reconciled: [{ findingId: "F1", disposition: "resolved", rationale: "This lane never received the packet." }] };
  await writeFile(file, JSON.stringify(freshReview));
  await assert.rejects(run(["review", "record", "outcome", "--file", file], repo, state), /out-of-packet ID: F1/);

  const staleBrief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "commit", "--reviewer", "codex", "--route", "native"], repo, state));
  await run(["review", "bind", "outcome", "--delegation", staleBrief.delegation.id, "--task-id", "stale-codex-run"], repo, state);
  await writeFile(path.join(repo, "README.md"), "new staged target\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  const staleGo = { ...freshReview, delegationId: staleBrief.delegation.id, reviewerTaskId: "stale-codex-run", head: staleBrief.delegation.head, baseHead: staleBrief.delegation.baseHead, tree: staleBrief.delegation.tree, reconciled: undefined };
  await writeFile(file, JSON.stringify(staleGo));
  await assert.rejects(run(["review", "record", "outcome", "--file", file], repo, state), /stale review may record new adverse evidence only/);
  await writeFile(file, JSON.stringify({ ...staleGo, verdict: "NO_GO", findings: ["Late adverse evidence"] }));
  await run(["review", "record", "outcome", "--file", file], repo, state);
});

test("three attempts must terminate and a provider failure is non-evidence", async () => {
  const { repo, state } = await fixture();
  await writeFile(path.join(repo, "README.md"), "review me\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  const briefs = {};
  for (const family of ["codex", "cursor", "claude"]) briefs[family] = JSON.parse(await run(["review", "brief", "outcome", "--kind", "commit", "--reviewer", family, "--route", family === "codex" ? "native" : "cli"], repo, state));
  await run(["review", "fail", "outcome", "--delegation", briefs.claude.delegation.id, "--task-id", "claude-run", "--reason", "CLI exited without an envelope"], repo, state);
  const events = (await readFile(path.join(state, "delegations", "outcome.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.filter((item) => item.id === briefs.claude.delegation.id).map((item) => item.event), ["created", "bound", "failed"]);
  await assert.rejects(run(["review", "fail", "outcome", "--delegation", briefs.claude.delegation.id, "--task-id", "claude-run", "--reason", "again"], repo, state), /already terminal/);
  await assert.rejects(run(["gate", "commit", "outcome"], repo, state), /requires two completed finding-free GO reviews; received 0/);
});

test("coordinator workflow distinguishes user-owned collaborators from internal delegation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-workflow-"));
  const output = await run(["workflow", "coordinator"], root, path.join(root, "state"));
  assert.match(output, /When the user explicitly asks for an agent they will work with directly, create a user-owned Codex task/);
  assert.match(output, /Use an internal subagent only for delegated work the current task will consume/);
});
