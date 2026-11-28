import path from "node:path";
import { quote } from "./hooks.mjs";
import { launchEntry, modelsLaunchedBy } from "./seats.mjs";

export const LOGIN_SHELL = "zsh";
const SHA = /^[0-9a-f]{40}$/i;

export function doubleQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

export function loginShellCommand(inner, shell = LOGIN_SHELL) {
  const prefix = shell === "zsh" ? `${shell} +o banghist -ic` : `${shell} -ic`;
  return `${prefix} ${quote(inner)}`;
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

function headCheck(headSha) {
  return `test "$(git rev-parse HEAD)" = ${doubleQuote(headSha)} && test -z "$(git status --porcelain)" && `;
}

export function codexInvokeInner({ promptFile, cwd, kind = "review", headSha = null, requireClean = false, lastMessageFile = null, model = null, cliModel = null }) {
  if (!["review", "work"].includes(kind)) throw new Error("Codex invoke kind must be review or work");
  const selected = cliModel || launcherModel("codex", model);
  const sandbox = kind === "work" ? "workspace-write" : "read-only";
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  const lastMessage = resolveMaybe(lastMessageFile || `${prompt}.last.txt`);
  const guard = kind === "review" && requireClean && headSha ? headCheck(requireSha(headSha, "head SHA")) : "";
  return `cd ${doubleQuote(repo)} && ${guard}command codex exec -m ${selected} -s ${sandbox} --ignore-user-config --json --color never -o ${doubleQuote(lastMessage)} -C ${doubleQuote(repo)} - < ${doubleQuote(prompt)}`;
}

export function codexInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(codexInvokeInner(options), shell);
}

export function claudeInvokeInner({ promptFile, cwd, baseSha, headSha, treeSha = null, requireClean = true, model = null, cliModel = null }) {
  const selected = cliModel || launcherModel("claude", model);
  const base = requireSha(baseSha, "base SHA");
  const head = requireSha(headSha, "head SHA");
  const diff = treeSha
    ? `git diff --no-ext-diff --no-textconv ${base} ${requireSha(treeSha, "tree SHA")} --`
    : requireClean
      ? `git diff --no-ext-diff --no-textconv ${base} ${head} --`
      : "git diff --no-ext-diff --no-textconv HEAD --";
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  const claude = `command claude --print --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(${diff})" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json --no-session-persistence --model ${selected} "$(< ${doubleQuote(prompt)})"`;
  return `cd ${doubleQuote(repo)} && ${requireClean ? headCheck(head) : ""}${claude}`;
}

export function claudeInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(claudeInvokeInner(options), shell);
}

export function agyInvokeInner({ promptFile, cwd, baseSha, headSha, treeSha = null, requireClean = true, model = null, cliModel = null }) {
  const selected = cliModel || launcherModel("agy", model);
  const base = requireSha(baseSha, "base SHA");
  const head = requireSha(headSha, "head SHA");
  const diff = treeSha
    ? `git diff --no-ext-diff --no-textconv ${base} ${requireSha(treeSha, "tree SHA")} --`
    : requireClean
      ? `git diff --no-ext-diff --no-textconv ${base} ${head} --`
      : "git diff --no-ext-diff --no-textconv HEAD --";
  const settings = JSON.stringify({
    permissions: {
      allow: [`command(${diff})`],
      deny: ["write_file(*)", "edit_file(*)", "mcp(*)"]
    }
  });
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  return `cd ${doubleQuote(repo)} && ${requireClean ? headCheck(head) : ""}command agy --mode plan --sandbox --disable-slash-commands --output-format json --model ${selected} --settings ${quote(settings)} -p "$(< ${doubleQuote(prompt)})"`;
}

export function agyInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(agyInvokeInner(options), shell);
}

export function devinInvokeInner({ promptFile, cwd, baseSha, headSha, treeSha = null, requireClean = true, model = null, cliModel = null }) {
  const selected = cliModel || launcherModel("devin", model);
  const base = requireSha(baseSha, "base SHA");
  const head = requireSha(headSha, "head SHA");
  const modeArg = treeSha
    ? ` --tree ${requireSha(treeSha, "tree SHA")}`
    : !requireClean
      ? " --working"
      : "";
  const repo = resolveMaybe(cwd);
  const prompt = resolveMaybe(promptFile);
  return `cd ${doubleQuote(repo)} && ${requireClean ? headCheck(head) : ""}fr-devin-review --base ${base} --head ${head}${modeArg} --model ${selected} --prompt-file ${doubleQuote(prompt)}`;
}

export function devinInvokeCommand(options, shell = LOGIN_SHELL) {
  return loginShellCommand(devinInvokeInner(options), shell);
}

export function cursorReviewCommand({ promptFile = "<prompt>", model = null, cliModel = null }) {
  const selected = cliModel || launcherModel("cursor", model);
  return `fr-cursor-review --model ${selected} --print --output-format stream-json --sandbox enabled --trust < ${promptFile.includes("<") ? promptFile : doubleQuote(promptFile)}`;
}

export function launchCommandFor(entry, { cwd, promptFile, lastMessageFile = null, baseSha, headSha, treeSha = null, requireClean = true }) {
  const { launch, id: model, cliModel } = entry;
  if (launch === "codex") return codexInvokeCommand({ promptFile, lastMessageFile, cwd, kind: "review", headSha, requireClean, model, cliModel });
  if (launch === "claude") return claudeInvokeCommand({ promptFile, cwd, baseSha, headSha, treeSha, requireClean, model, cliModel });
  if (launch === "agy") return agyInvokeCommand({ promptFile, cwd, baseSha, headSha, treeSha, requireClean, model, cliModel });
  if (launch === "devin") return devinInvokeCommand({ promptFile, cwd, baseSha, headSha, treeSha, requireClean, model, cliModel });
  if (launch === "cursor") return loginShellCommand(`cd ${doubleQuote(resolveMaybe(cwd))} && ${requireClean ? headCheck(requireSha(headSha, "head SHA")) : ""}${cursorReviewCommand({ promptFile, model, cliModel })}`);
  throw new Error(`Unsupported CLI launcher: ${launch}`);
}
