import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { quote } from "../src/hooks.mjs";
import { agyInvokeCommand, claudeInvokeCommand, claudeInvokeInner, codexInvokeCommand, cursorReviewCommand, devinInvokeCommand } from "../src/machines.mjs";
import { useSeatConfig } from "../src/seats.mjs";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
const sha = "a".repeat(40);
const head = "b".repeat(40);

test("codex and claude invoke commands use the login shell, the shared CLI recipes, and seated models", () => {
  const repo = "/tmp/work repo";
  const prompt = "/tmp/brief's.txt";
  const astra = codexInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review" });
  assert.match(astra, /^zsh -ic /);
  assert.match(astra, /codex exec -m gpt-6-astra -s read-only --ignore-user-config --json --color never/);
  assert.doesNotMatch(astra, /--ask-for-approval|--ephemeral|--sandbox /);
  assert.match(astra, /cd "\/tmp\/work repo"/);
  const work = codexInvokeCommand({ promptFile: prompt, cwd: repo, kind: "work" });
  assert.match(work, /-s workspace-write/);
  const fable = claudeInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head });
  assert.match(fable, /claude --print --permission-mode dontAsk/);
  assert.doesNotMatch(fable, /claude-aws/);
  assert.match(fable, new RegExp(`test "\\$\\(git rev-parse HEAD\\)" = "${head}"`));
  assert.match(fable, new RegExp(`Bash\\(git diff --no-ext-diff --no-textconv ${sha} ${head} --\\)`));
  assert.match(fable, /git status --porcelain/);
  assert.equal(fable, `zsh -ic ${quote(`cd "/tmp/work repo" && test "$(git rev-parse HEAD)" = "${head}" && test -z "$(git status --porcelain)" && claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(git diff --no-ext-diff --no-textconv ${sha} ${head} --)" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json --no-session-persistence --model claude-opus-5-5 "$(< "/tmp/brief's.txt")"`)}`);
  const fable51 = claudeInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head, model: "claude-fable-5-1-thinking-high" });
  assert.match(fable51, /--model claude-fable-5-1 /);
  const sol = codexInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review", model: "gpt-5.6-sol-medium" });
  assert.match(sol, /codex exec -m gpt-5.6-sol /);
  assert.throws(() => claudeInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head, model: "gpt-6-astra" }), /launches with codex in config.json, not claude/);
  assert.throws(() => codexInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review", model: "claude-opus-5-5" }), /launches with claude in config.json, not codex/);
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
  const invoke = (await exec(process.execPath, [cli, "machines", "invoke", "claude", "--prompt-file", prompt, "--cwd", repo, "--base", sha, "--head", head], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.equal(invoke, claudeInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head }));
  const astra = (await exec(process.execPath, [cli, "machines", "invoke", "codex", "--prompt-file", prompt, "--cwd", repo, "--kind", "review"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.equal(astra, codexInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review" }));
  const sol = (await exec(process.execPath, [cli, "machines", "invoke", "codex", "--prompt-file", prompt, "--cwd", repo, "--kind", "review", "--model", "gpt-5.6-sol"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.equal(sol, codexInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review", model: "gpt-5.6-sol" }));
  const opus = (await exec(process.execPath, [cli, "machines", "invoke", "claude", "--prompt-file", prompt, "--cwd", repo, "--base", sha, "--head", head, "--model", "claude-fable-5"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.match(opus, /--model claude-fable-5 /);
  await assert.rejects(
    exec(process.execPath, [cli, "machines", "invoke", "claude", "--prompt-file", prompt, "--cwd", repo, "--base", sha, "--head", head, "--model", "gpt-6-astra"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } }),
    /launches with codex in config.json, not claude/
  );
  await assert.rejects(
    exec(process.execPath, [cli, "machines", "invoke", "cursor", "--prompt-file", prompt, "--cwd", repo, "--kind", "review"], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } }),
    /Invoke launcher must be codex or claude/
  );
});

test("claude inner command checks HEAD and a clean worktree before invoking claude", async () => {
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
  await exec("sh", ["-c", claudeInvokeInner({ promptFile: prompt, cwd: repo, baseSha: realHead, headSha: realHead })], { env });
  const logged = await readFile(log, "utf8");
  assert.ok(logged.includes(repo));
  assert.match(logged, /claude-opus-5-5/);
  await assert.rejects(exec("sh", ["-c", claudeInvokeInner({ promptFile: prompt, cwd: repo, baseSha: realHead, headSha: head })], { env }));
  await writeFile(path.join(repo, "file.txt"), "dirty\n");
  await assert.rejects(exec("sh", ["-c", claudeInvokeInner({ promptFile: prompt, cwd: repo, baseSha: realHead, headSha: realHead })], { env }));
});

test("cursor-launched seats send the brief on stdin with the configured Cursor model id", () => {
  const launch = cursorReviewCommand({ model: "grok-4.6" });
  assert.equal(launch, "fr-cursor-review --model cursor-grok-4.6-high --print --output-format stream-json --sandbox enabled --trust < <prompt>");
  assert.doesNotMatch(launch, /\$\(</);
  assert.match(cursorReviewCommand({ promptFile: "/tmp/a b.txt", model: "grok-4.6" }), /< "\/tmp\/a b.txt"$/);
  assert.throws(() => cursorReviewCommand({ model: "grok-4.7-high" }), /no seat lists it/);
  assert.throws(() => cursorReviewCommand({ model: "gpt-6-astra" }), /launches with codex/);
});

test("agy and devin seats get read-only launch commands pinned to the review diff", async (t) => {
  const example = JSON.parse(await readFile(process.env.FIELD_REPORT_CONFIG, "utf8"));
  useSeatConfig({ ...example, seats: { ...example.seats, design: { models: [{ id: "gemini-4-neon", launch: "agy", cliModel: "gemini-4-neon-high" }, { id: "swe-2", launch: "devin" }] } } });
  t.after(() => useSeatConfig(null));
  const repo = "/tmp/work repo";
  const prompt = "/tmp/brief's.txt";
  const settings = JSON.stringify({ permissions: { allow: [`command(git diff --no-ext-diff --no-textconv ${sha} ${head} --)`], deny: ["write_file(*)", "mcp(*)"] } });
  assert.equal(agyInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head }), `zsh -ic ${quote(`cd "/tmp/work repo" && test "$(git rev-parse HEAD)" = "${head}" && test -z "$(git status --porcelain)" && agy --mode plan --sandbox --output-format json --model gemini-4-neon-high --settings ${quote(settings)} -p "$(< "/tmp/brief's.txt")"`)}`);
  assert.equal(devinInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head }), `zsh -ic ${quote(`cd "/tmp/work repo" && test "$(git rev-parse HEAD)" = "${head}" && test -z "$(git status --porcelain)" && fr-devin-review --base ${sha} --head ${head} --model swe-2 --prompt-file "/tmp/brief's.txt"`)}`);
  assert.doesNotMatch(devinInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head }), /--sandbox/);
  assert.throws(() => agyInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: "BASE_SHA", headSha: head }), /base SHA must be a 40-character SHA/);
  assert.throws(() => devinInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: "HEAD_SHA" }), /head SHA must be a 40-character SHA/);
  assert.throws(() => agyInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head, model: "swe-2" }), /launches with devin in config.json, not agy/);
});
