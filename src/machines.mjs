import path from "node:path";
import { quote } from "./hooks.mjs";
import { launchEntry, modelsLaunchedBy } from "./seats.mjs";

export const LOGIN_SHELL = "zsh";
export const HOST_LAUNCHERS = ["codex", "claude"];
const SHA = /^[0-9a-f]{40}$/i;

export function doubleQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

export function loginShellCommand(inner, shell = LOGIN_SHELL) {
  return `${shell} -ic ${quote(inner)}`;
}

function requireSha(value, label) {
  const text = String(value || "").trim();
  if (!SHA.test(text)) throw new Error(`${label} must be a 40-character SHA`);
  return text;
}

function resolveMaybe(value) {
  const text = String(value);
  if (text.includes("<")) return text;
  return path.resolve(text);
}

// The CLI model id for a launcher: the requested model, or the first seated
// model that launcher runs. The config file decides which launcher a model uses.
export function launcherModel(launcher, model = null) {
  if (model) {
    const entry = launchEntry(model);
    if (!entry) throw new Error(`Model ${model} has no launcher in config.json: no seat lists it`);
    if (entry.launch !== launcher) throw new Error(`Model ${entry.id} launches with ${entry.launch} in config.json, not ${launcher}`);
    return entry.cliModel;
  }
  const first = modelsLaunchedBy(launcher)[0];
  if (!first) throw new Error(`No seated model launches with ${launcher} in config.json`);
  return first.cliModel;
}

export function codexInvokeInner({ promptFile, cwd, kind = "review", lastMessageFile = null, model = null }) {
  if (!["review", "work"].includes(kind)) throw new Error("Codex invoke kind must be review or work");
  const selected = launcherModel("codex", model);
  const sandbox = kind === "work" ? "workspace-write" : "read-only";
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  const lastMessage = resolveMaybe(lastMessageFile || `${prompt}.last.txt`);
  return `cd ${doubleQuote(repo)} && codex exec -m ${selected} -s ${sandbox} --ignore-user-config --json --color never -o ${doubleQuote(lastMessage)} -C ${doubleQuote(repo)} - < ${doubleQuote(prompt)}`;
}

export function codexInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(codexInvokeInner(options), shell);
}

function headCheck(headSha) {
  return `test "$(git rev-parse HEAD)" = ${doubleQuote(headSha)} && test -z "$(git status --porcelain)" && `;
}

function claudeCli({ promptFile, cwd, baseSha, headSha, model = null }) {
  const selected = launcherModel("claude", model);
  const diff = `git diff --no-ext-diff --no-textconv ${baseSha} ${headSha} --`;
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  const claude = `claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(${diff})" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json --no-session-persistence --model ${selected} "$(< ${doubleQuote(prompt)})"`;
  return `cd ${doubleQuote(repo)} && ${SHA.test(headSha) ? headCheck(headSha) : ""}${claude}`;
}

export function claudeInvokeInner({ promptFile, cwd, baseSha, headSha, model = null }) {
  return claudeCli({
    promptFile,
    cwd,
    model,
    baseSha: requireSha(baseSha, "base SHA"),
    headSha: requireSha(headSha, "head SHA")
  });
}

export function claudeInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(claudeInvokeInner(options), shell);
}

// Antigravity: plan mode does not edit or run commands on its own, the
// session-only settings allow just the review diff and deny writes and every MCP
// tool, and headless runs deny anything else rather than prompt.
export function agyInvokeInner({ promptFile, cwd, baseSha, headSha, model = null }) {
  const selected = launcherModel("agy", model);
  const diff = `git diff --no-ext-diff --no-textconv ${requireSha(baseSha, "base SHA")} ${requireSha(headSha, "head SHA")} --`;
  const settings = JSON.stringify({ permissions: { allow: [`command(${diff})`], deny: ["write_file(*)", "mcp(*)"] } });
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  return `cd ${doubleQuote(repo)} && ${headCheck(headSha)}agy --mode plan --sandbox --output-format json --model ${selected} --settings ${quote(settings)} -p "$(< ${doubleQuote(prompt)})"`;
}

export function agyInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(agyInvokeInner(options), shell);
}

// Devin runs through fr-devin-review, which writes it a review-only config.
export function devinInvokeInner({ promptFile, cwd, baseSha, headSha, model = null }) {
  const selected = launcherModel("devin", model);
  const base = requireSha(baseSha, "base SHA");
  const head = requireSha(headSha, "head SHA");
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  return `cd ${doubleQuote(repo)} && ${headCheck(head)}fr-devin-review --base ${base} --head ${head} --model ${selected} --prompt-file ${doubleQuote(prompt)}`;
}

export function devinInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(devinInvokeInner(options), shell);
}

// Cursor-hosted reviewers run through the MCP-isolating wrapper. The brief goes
// on stdin: some hosts kill processes given an argument over about 1,000
// characters.
export function cursorReviewCommand({ promptFile = "<prompt>", model }) {
  const selected = launcherModel("cursor", model);
  return `fr-cursor-review --model ${selected} --print --output-format stream-json --sandbox enabled --trust < ${promptFile.includes("<") ? promptFile : doubleQuote(promptFile)}`;
}
