import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { quote } from "../src/hooks.mjs";
import {
  DEFAULT_WORKER_NAME,
  fableInvokeCommand,
  machinesStatus,
  printMachinesStatus,
  solInvokeCommand,
  workerDirs,
  workerStartCommand
} from "../src/machines.mjs";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
const sha = "a".repeat(40);
const head = "b".repeat(40);

test("worker start commands dedupe checkouts and quote paths", () => {
  const dirs = workerDirs([{ id: "aon", repoPath: "/tmp/aon" }, { id: "dup", repoPath: "/tmp/aon" }], "/tmp/field-report");
  assert.deepEqual(dirs.map((entry) => entry.dir), ["/tmp/aon", "/tmp/field-report"]);
  assert.match(workerStartCommand({ workerDir: "/tmp/My Repo" }), /--name local/);
  assert.match(workerStartCommand({ workerDir: "/tmp/My Repo" }), /--worker-dir '\/tmp\/My Repo'/);
  const combined = workerStartCommand({ name: "desk", workerDirs: ["/tmp/aon", "/tmp/My Repo"] });
  assert.equal(combined, "agent worker start --name desk --worker-dir /tmp/aon --worker-dir '/tmp/My Repo'");
});

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

test("machines status probes only the login shell and reports Sol and Fable independently", async () => {
  const found = { codex: "/opt/codex", claude: "/opt/claude" };
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, args]);
    const needle = String(args.at(-1)).replace(/^command -v /, "");
    if (found[needle]) return { stdout: `${found[needle]}\n` };
    throw new Error("missing");
  };
  const missingAgent = await machinesStatus({ run, projects: [{ id: "aon", repoPath: "/tmp/aon" }], cwd: "/tmp/aon", promptFile: "/tmp/prompt.txt" });
  assert.equal(missingAgent.accessible.sol, true);
  assert.equal(missingAgent.accessible.fable, true);
  assert.equal(missingAgent.clis.agent.available, false);
  assert.equal(missingAgent.clis.codex.path, "/opt/codex");
  assert.equal(missingAgent.workerName, DEFAULT_WORKER_NAME);
  assert.equal(missingAgent.workers.length, 1);
  assert.equal(missingAgent.workerCommand, workerStartCommand({ workerDir: "/tmp/aon" }));
  assert.ok(calls.every((entry) => entry[0] === "zsh"));
  assert.ok(calls.every((entry) => entry[1][0] === "-ic"));
  found.agent = "/opt/agent";
  delete found.claude;
  const missingFable = await machinesStatus({ run, cwd: "/tmp/aon", promptFile: "/tmp/prompt.txt" });
  assert.equal(missingFable.accessible.sol, true);
  assert.equal(missingFable.accessible.fable, false);
  assert.match(printMachinesStatus(missingFable), /Local Fable CLI: UNAVAILABLE/);
  assert.match(printMachinesStatus(missingFable), /Local Sol CLI: ACCESSIBLE/);
  assert.match(printMachinesStatus(missingFable), /ordinary `claude`/);
  assert.match(printMachinesStatus(missingFable), /repeatable --worker-dir/);
  delete found.codex;
  found.claude = "/opt/claude";
  const fableOnly = await machinesStatus({ run, cwd: "/tmp/aon", promptFile: "/tmp/prompt.txt" });
  assert.equal(fableOnly.accessible.sol, false);
  assert.equal(fableOnly.accessible.fable, true);
  assert.match(printMachinesStatus(fableOnly), /Local Sol CLI: UNAVAILABLE/);
  assert.match(printMachinesStatus(fableOnly), /Local Fable CLI: ACCESSIBLE/);
});

test("CLI prints worker start commands and exact invoke lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-machines-"));
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  await exec("git", ["init", "-b", "main", repo]);
  await exec(process.execPath, [cli, "project", "add", "sample", "--label", "Sample", "--repo", repo], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } });
  const worker = (await exec(process.execPath, [cli, "machines", "worker", "--name", "desk"], { cwd: repo, env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.equal(worker, workerStartCommand({ name: "desk", workerDir: repo }));
  assert.doesNotMatch(worker, /\n/);
  const status = JSON.parse((await exec(process.execPath, [cli, "machines", "status", "--json"], { cwd: repo, env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout);
  assert.equal(status.workerName, "local");
  assert.equal(typeof status.accessible.sol, "boolean");
  assert.equal(typeof status.accessible.fable, "boolean");
  const prompt = path.join(root, "brief.txt");
  await writeFile(prompt, "review");
  const invoke = (await exec(process.execPath, [cli, "machines", "invoke", "fable", "--prompt-file", prompt, "--cwd", repo, "--base", sha, "--head", head], { env: { ...process.env, FIELD_REPORT_STATE_ROOT: state } })).stdout.trim();
  assert.equal(invoke, fableInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head }));
});
