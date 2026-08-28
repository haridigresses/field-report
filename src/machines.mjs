import path from "node:path";
import { quote } from "./hooks.mjs";

export const LOGIN_SHELL = "zsh";
export const SOL_MODEL = "gpt-5.6-sol";
export const FABLE_MODEL = "claude-fable-5";
export const FABLE_ROUTE = "claude";
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

export function solInvokeInner({ promptFile, cwd, kind = "review", lastMessageFile = null }) {
  if (!["review", "work"].includes(kind)) throw new Error("Sol invoke kind must be review or work");
  const sandbox = kind === "work" ? "workspace-write" : "read-only";
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  const lastMessage = resolveMaybe(lastMessageFile || `${prompt}.last.txt`);
  return `cd ${doubleQuote(repo)} && codex exec -m ${SOL_MODEL} -s ${sandbox} --ignore-user-config --json --color never -o ${doubleQuote(lastMessage)} -C ${doubleQuote(repo)} - < ${doubleQuote(prompt)}`;
}

export function solInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(solInvokeInner(options), shell);
}

function fableCli({ promptFile, cwd, baseSha, headSha }) {
  const diff = `git diff --no-ext-diff --no-textconv ${baseSha} ${headSha} --`;
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  const claude = `claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(${diff})" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json --no-session-persistence --model ${FABLE_MODEL} "$(< ${doubleQuote(prompt)})"`;
  const headCheck = SHA.test(headSha) ? `test "$(git rev-parse HEAD)" = ${doubleQuote(headSha)} && ` : "";
  return `cd ${doubleQuote(repo)} && ${headCheck}${claude}`;
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
