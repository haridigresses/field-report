import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { quote } from "../src/hooks.mjs";
import { fableInvokeCommand, fableInvokeInner, astraInvokeCommand } from "../src/machines.mjs";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
const sha = "a".repeat(40);
const head = "b".repeat(40);

test("Astra and Fable invoke commands use the login shell and the shared CLI recipes", () => {
  const repo = "/tmp/work repo";
  const prompt = "/tmp/brief's.txt";
  const astra = astraInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review" });
  assert.match(astra, /^zsh -ic /);
  assert.match(astra, /codex exec -m gpt-6-astra -s read-only --ignore-user-config --json --color never/);
  assert.doesNotMatch(astra, /--ask-for-approval|--ephemeral|--sandbox /);
  assert.match(astra, /cd "\/tmp\/work repo"/);
  const work = astraInvokeCommand({ promptFile: prompt, cwd: repo, kind: "work" });
  assert.match(work, /-s workspace-write/);
  const fable = fableInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head });
  assert.match(fable, /claude --print --permission-mode dontAsk/);
  assert.doesNotMatch(fable, /claude-aws/);
  assert.match(fable, new RegExp(`test "\\$\\(git rev-parse HEAD\\)" = "${head}"`));
  assert.match(fable, new RegExp(`Bash\\(git diff --no-ext-diff --no-textconv ${sha} ${head} --\\)`));
  assert.match(fable, /git status --porcelain/);
  assert.equal(fable, `zsh -ic ${quote(`cd "/tmp/work repo" && test "$(git rev-parse HEAD)" = "${head}" && test -z "$(git status --porcelain)" && claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(git diff --no-ext-diff --no-textconv ${sha} ${head} --)" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json --no-session-persistence --model claude-opus-5-5 "$(< "/tmp/brief's.txt")"`)}`);
  const fable51 = fableInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head, model: "claude-fable-5-1-thinking-high" });
  assert.match(fable51, /--model claude-fable-5-1 /);
  const sol = astraInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review", model: "gpt-5.6-sol-medium" });
  assert.match(sol, /codex exec -m gpt-5.6-sol /);
  assert.throws(() => fableInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head, model: "gpt-6-astra" }), /Anthropic model/);
  assert.throws(() => astraInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review", model: "claude-opus-5-5" }), /Codex model/);
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
  const astra = (await exec(process.execPath, [cli, "machines", "invoke", "astra", "--prompt-file", prompt, "--cwd", repo, "--kind", "review"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.equal(astra, astraInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review" }));
  const sol = (await exec(process.execPath, [cli, "machines", "invoke", "astra", "--prompt-file", prompt, "--cwd", repo, "--kind", "review", "--model", "gpt-5.6-sol"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.equal(sol, astraInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review", model: "gpt-5.6-sol" }));
  const opus = (await exec(process.execPath, [cli, "machines", "invoke", "fable", "--prompt-file", prompt, "--cwd", repo, "--base", sha, "--head", head, "--model", "claude-fable-5"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.match(opus, /--model claude-fable-5 /);
  await assert.rejects(
    exec(process.execPath, [cli, "machines", "invoke", "fable", "--prompt-file", prompt, "--cwd", repo, "--base", sha, "--head", head, "--model", "gpt-6-astra"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } }),
    /Anthropic model/
  );
  await assert.rejects(
    exec(process.execPath, [cli, "machines", "invoke", "sol", "--prompt-file", prompt, "--cwd", repo, "--kind", "review"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } }),
    /Invoke provider must be astra or fable/
  );
});

test("Fable inner command checks HEAD and a clean worktree before invoking claude", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-fable-run-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const prompt = path.join(root, "prompt.txt");
  const log = path.join(root, "claude.log");
  await mkdir(bin);
  await writeFile(prompt, "brief");
  await writeFile(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > ${JSON.stringify(log)}\n`);
  await chmod(path.join(bin, "claude"), 0o755);
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "test"]);
  await writeFile(path.join(repo, "file.txt"), "ok\n");
  await exec("git", ["-C", repo, "add", "file.txt"]);
  await exec("git", ["-C", repo, "commit", "-m", "init"]);
  const realHead = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  await exec("sh", ["-c", fableInvokeInner({ promptFile: prompt, cwd: repo, baseSha: realHead, headSha: realHead })], { env });
  const logged = await readFile(log, "utf8");
  assert.ok(logged.includes(repo));
  assert.match(logged, /claude-opus-5-5/);
  await assert.rejects(exec("sh", ["-c", fableInvokeInner({ promptFile: prompt, cwd: repo, baseSha: realHead, headSha: head })], { env }));
  await writeFile(path.join(repo, "file.txt"), "dirty\n");
  await assert.rejects(exec("sh", ["-c", fableInvokeInner({ promptFile: prompt, cwd: repo, baseSha: realHead, headSha: realHead })], { env }));
});
