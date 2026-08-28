import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { quote } from "../src/hooks.mjs";
import { fableInvokeCommand, solInvokeCommand } from "../src/machines.mjs";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
const sha = "a".repeat(40);
const head = "b".repeat(40);

test("Sol and Fable invoke commands use the login shell and the shared CLI recipes", () => {
  const repo = "/tmp/work repo";
  const prompt = "/tmp/brief's.txt";
  const sol = solInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review" });
  assert.match(sol, /^zsh -ic /);
  assert.match(sol, /codex exec -m gpt-5.6-sol -s read-only --ignore-user-config --json --color never/);
  assert.doesNotMatch(sol, /--ask-for-approval|--ephemeral|--sandbox /);
  assert.match(sol, /cd "\/tmp\/work repo"/);
  const work = solInvokeCommand({ promptFile: prompt, cwd: repo, kind: "work" });
  assert.match(work, /-s workspace-write/);
  const fable = fableInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head });
  assert.match(fable, /claude --print --permission-mode dontAsk/);
  assert.doesNotMatch(fable, /claude-aws/);
  assert.match(fable, new RegExp(`test "\\$\\(git rev-parse HEAD\\)" = "${head}"`));
  assert.match(fable, new RegExp(`Bash\\(git diff --no-ext-diff --no-textconv ${sha} ${head} --\\)`));
  assert.equal(fable, `zsh -ic ${quote(`cd "/tmp/work repo" && test "$(git rev-parse HEAD)" = "${head}" && claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(git diff --no-ext-diff --no-textconv ${sha} ${head} --)" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json --no-session-persistence --model claude-fable-5 "$(< "/tmp/brief's.txt")"`)}`);
});

test("CLI prints exact invoke lines and refuses status or worker commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-machines-"));
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  await exec("git", ["init", "-b", "main", repo]);
  await exec(process.execPath, [cli, "project", "add", "sample", "--label", "Sample", "--repo", repo], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } });
  await assert.rejects(
    exec(process.execPath, [cli, "machines", "status"], { cwd: repo, env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } }),
    /does not probe host accessibility or start My Machines workers/
  );
  await assert.rejects(
    exec(process.execPath, [cli, "machines", "worker"], { cwd: repo, env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } }),
    /does not probe host accessibility or start My Machines workers/
  );
  const prompt = path.join(root, "brief.txt");
  await writeFile(prompt, "review");
  const invoke = (await exec(process.execPath, [cli, "machines", "invoke", "fable", "--prompt-file", prompt, "--cwd", repo, "--base", sha, "--head", head], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.equal(invoke, fableInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head }));
  const sol = (await exec(process.execPath, [cli, "machines", "invoke", "sol", "--prompt-file", prompt, "--cwd", repo, "--kind", "review"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.equal(sol, solInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review" }));
});
