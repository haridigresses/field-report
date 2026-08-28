import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { quote } from "./hooks.mjs";

const exec = promisify(execFile);

export const DEFAULT_WORKER_NAME = "local";
export const LOGIN_SHELL = "zsh";
export const SOL_MODEL = "gpt-5.6-sol";
export const FABLE_MODEL = "claude-fable-5";
export const FABLE_ROUTE = "claude";
const SHA = /^[0-9a-f]{40}$/i;
const SIMPLE_COMMAND = /^[A-Za-z0-9._+-]+$/;

export function doubleQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

export function loginShellCommand(inner, shell = LOGIN_SHELL) {
  return `${shell} -ic ${quote(inner)}`;
}

function resolveWorkerDir(directory) {
  const resolved = path.resolve(directory);
  try { return realpathSync(resolved); } catch { return resolved; }
}

export function workerStartArgv({ name = DEFAULT_WORKER_NAME, workerDir, workerDirs: dirs }) {
  const directories = [];
  const seen = new Set();
  for (const directory of dirs || (workerDir == null ? [] : [workerDir])) {
    const resolved = resolveWorkerDir(directory);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    directories.push(resolved);
  }
  if (!directories.length) throw new Error("worker-dir is required");
  const argv = ["agent", "worker", "start", "--name", name];
  for (const directory of directories) argv.push("--worker-dir", directory);
  return argv;
}

export function workerStartCommand(options) {
  return workerStartArgv(options).map((token) => /^[A-Za-z0-9/._=-]+$/.test(token) ? token : quote(token)).join(" ");
}

export function workerDirs(projects = [], cwd = process.cwd()) {
  const dirs = [];
  const seen = new Set();
  for (const project of projects) {
    const directory = resolveWorkerDir(project.repoPath);
    if (seen.has(directory)) continue;
    seen.add(directory);
    dirs.push({ id: project.id, dir: directory });
  }
  const current = resolveWorkerDir(cwd);
  if (!seen.has(current)) dirs.push({ id: path.basename(current), dir: current });
  return dirs;
}

function requireSha(value, label) {
  const text = String(value || "").trim();
  if (!SHA.test(text)) throw new Error(`${label} must be a 40-character SHA`);
  return text;
}

export function solInvokeInner({ promptFile, cwd, kind = "review", lastMessageFile = null }) {
  if (!["review", "work"].includes(kind)) throw new Error("Sol invoke kind must be review or work");
  const sandbox = kind === "work" ? "workspace-write" : "read-only";
  const prompt = path.resolve(promptFile);
  const lastMessage = path.resolve(lastMessageFile || `${prompt}.last.txt`);
  return `cd ${doubleQuote(path.resolve(cwd))} && codex exec --model ${SOL_MODEL} --ephemeral --sandbox ${sandbox} --ask-for-approval never --output-last-message ${doubleQuote(lastMessage)} - < ${doubleQuote(prompt)}`;
}

export function solInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(solInvokeInner(options), shell);
}

function fableCli({ promptFile, cwd, baseSha, headSha }) {
  const diff = `git diff --no-ext-diff --no-textconv ${baseSha} ${headSha} --`;
  return `cd ${doubleQuote(path.resolve(cwd))} && claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(${diff})" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json --no-session-persistence --model ${FABLE_MODEL} "$(< ${doubleQuote(path.resolve(promptFile))})"`;
}

export function fableInvokeInner({ promptFile, cwd, baseSha, headSha }) {
  return fableCli({
    promptFile,
    cwd,
    baseSha: requireSha(baseSha, "base SHA"),
    headSha: requireSha(headSha, "head SHA")
  });
}

export function fableInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(fableInvokeInner(options), shell);
}

export async function resolveCommand(name, { run = exec, env = process.env, shell = LOGIN_SHELL } = {}) {
  if (!SIMPLE_COMMAND.test(name)) throw new Error("CLI name must be a simple command");
  const attempts = [
    [shell, ["-ic", `command -v ${name}`]],
    ["sh", ["-c", `command -v ${name}`]]
  ];
  for (const [bin, args] of attempts) {
    try {
      const { stdout } = await run(bin, args, { env, timeout: 8_000 });
      const resolved = String(stdout || "").trim().split("\n").filter(Boolean).at(-1);
      if (resolved) return resolved;
    } catch {}
  }
  return null;
}

function cliRecord(name, resolved) {
  return { name, available: Boolean(resolved), path: resolved };
}

export async function machinesStatus({
  run = exec,
  env = process.env,
  shell = LOGIN_SHELL,
  workerName = DEFAULT_WORKER_NAME,
  projects = [],
  cwd = process.cwd(),
  promptFile = "/path/to/prompt.txt",
  baseSha = "BASE_SHA",
  headSha = "HEAD_SHA"
} = {}) {
  const names = ["agent", "codex", FABLE_ROUTE];
  const resolved = {};
  for (const name of names) resolved[name] = await resolveCommand(name, { run, env, shell });
  const clis = Object.fromEntries(names.map((name) => [name, cliRecord(name, resolved[name])]));
  const dirs = workerDirs(projects, cwd);
  const workerCommand = workerStartCommand({ name: workerName, workerDirs: dirs.map((entry) => entry.dir) });
  const workers = dirs.map((entry) => ({
    project: entry.id,
    dir: entry.dir,
    argv: workerStartArgv({ name: workerName, workerDir: entry.dir }),
    command: workerStartCommand({ name: workerName, workerDir: entry.dir })
  }));
  const accessible = Boolean(resolved.codex && resolved[FABLE_ROUTE]);
  const prompt = path.resolve(cwd, promptFile);
  const fableInner = SHA.test(baseSha) && SHA.test(headSha)
    ? fableInvokeInner({ promptFile: prompt, cwd, baseSha, headSha })
    : fableCli({ promptFile: prompt, cwd, baseSha: "BASE_SHA", headSha: "HEAD_SHA" });
  return {
    accessible,
    workerName,
    workerCommand,
    shell,
    clis,
    workers,
    invoke: {
      sol: {
        review: solInvokeCommand({ promptFile: prompt, cwd, kind: "review" }, shell),
        work: solInvokeCommand({ promptFile: prompt, cwd, kind: "work" }, shell),
        model: SOL_MODEL
      },
      fable: loginShellCommand(fableInner, shell),
      fableModel: FABLE_MODEL,
      fableRoute: FABLE_ROUTE
    },
    missing: names.filter((name) => !resolved[name])
  };
}

export function printMachinesStatus(status) {
  const lines = [
    `My Machines worker name: ${status.workerName}`,
    `Local Sol+Fable CLIs: ${status.accessible ? "ACCESSIBLE" : "UNAVAILABLE"}`,
    ...Object.values(status.clis).map((cli) => `- ${cli.name}: ${cli.available ? cli.path : "missing"}`),
    "",
    "Start one worker daemon and keep it running. Extra checkouts are repeatable --worker-dir flags:",
    `- ${status.workerCommand}`,
    ...status.workers.map((worker) => `  ${worker.project}: ${worker.dir}`),
    "",
    "Route Cloud Agents to this host with worker=" + status.workerName + " or machine=" + status.workerName + " while it is online.",
    "Sol reviews use gpt-5.6-sol through `codex exec` in the login shell.",
    "Fable reviews use claude-fable-5 through ordinary `claude` in the login shell.",
    "Cursor-hosted models are not a substitute for those required routes."
  ];
  if (status.missing.length) {
    lines.push("", `Missing on this host: ${status.missing.join(", ")}.`);
    if (status.missing.includes("agent")) lines.push("Install the Cursor CLI with curl https://cursor.com/install -fsS | bash, then run agent login.");
    if (status.missing.includes("codex")) lines.push("Install and authenticate the Codex CLI so `zsh -ic 'command -v codex'` succeeds.");
    if (status.missing.includes(FABLE_ROUTE)) lines.push("Expose ordinary `claude` on the login-shell PATH used by Field Report Fable reviews.");
  }
  return lines.join("\n");
}
