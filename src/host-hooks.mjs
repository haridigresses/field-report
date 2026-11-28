import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { quote } from "./hooks.mjs";
import { capturePromptFromHook, readConfiguredProjects } from "./prompts.mjs";
import { ancestorHeads, checkout, gitCommonDir, mrrTarget } from "./repository.mjs";
import { describePlans, describeTodos, plansFor, todosFor } from "./store.mjs";
import { evaluateMrrGate, openReasons } from "./policy.mjs";

const HOOK_MARKER = " _hook ";

function stripOwnerPrefix(headSpec) {
  if (!headSpec) return null;
  const text = String(headSpec).trim();
  const colon = text.indexOf(":");
  return colon >= 0 ? text.slice(colon + 1) : text;
}

// Parse a gh argv array (excluding leading "gh") and classify whether it opens
// a non-draft PR, opens a draft PR, or marks a draft PR ready for review.
// Handles -R/--repo and -H/--head anywhere in argv (before or after `pr create|ready`).
export function classifyGhArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  let explicitRepo = null;
  let explicitHead = null;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--") break;
    if ((token === "-R" || token === "--repo") && args[i + 1]) { explicitRepo = args[i + 1]; i += 1; continue; }
    if (token.startsWith("--repo=")) { explicitRepo = token.slice("--repo=".length); continue; }
    if ((token === "-H" || token === "--head") && args[i + 1]) { explicitHead = stripOwnerPrefix(args[i + 1]); i += 1; continue; }
    if (token.startsWith("--head=")) { explicitHead = stripOwnerPrefix(token.slice("--head=".length)); continue; }
  }

  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "-R" || token === "--repo" || token === "-h" || token === "--hostname") {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }

  const command = args[index];
  const subcommand = args[index + 1];
  const rest = args.slice(index + 2);
  if (command !== "pr" || !subcommand) return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead, selector: null };
  if (rest.includes("--help") || rest.includes("-h")) return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead, selector: null };

  if (subcommand === "create") {
    const valueFlags = new Set(["-R", "--repo", "-a", "--assignee", "-B", "--base", "-b", "--body", "-F", "--body-file", "-H", "--head", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "-t", "--title"]);
    let isDraft = false;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--") break;
      if (valueFlags.has(arg)) { i += 1; continue; }
      if (arg === "--draft" || arg === "-d") { isDraft = true; break; }
      if (/^-[A-Za-z]{2,}$/.test(arg) && !valueFlags.has(arg.slice(0, 2)) && arg.includes("d")) { isDraft = true; break; }
    }
    return { action: isDraft ? "draft-pr" : "open-pr", cleanedArgs: args, explicitRepo, explicitHead, selector: null };
  }

  if (subcommand === "ready") {
    if (rest.includes("--undo")) return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead, selector: null };
    const selector = rest.find((arg, idx) => !arg.startsWith("-") && (idx === 0 || (rest[idx - 1] !== "-R" && rest[idx - 1] !== "--repo"))) || null;
    return { action: "ready-pr", cleanedArgs: args, explicitRepo, explicitHead, selector };
  }

  return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead, selector: null };
}

export function extractShellGhInvocations(commandText) {
  const segments = String(commandText || "").split(/(?:&&|\|\||;|\||\n)/);
  const invocations = [];
  for (const segment of segments) {
    const tokens = tokenizeShell(segment.trim());
    if (!tokens.length) continue;
    let start = 0;
    while (start < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]) || tokens[start] === "env" || tokens[start] === "command")) {
      start += 1;
    }
    if (start < tokens.length && (tokens[start] === "gh" || tokens[start].endsWith("/gh"))) {
      invocations.push(tokens.slice(start + 1));
    }
  }
  return invocations;
}

function tokenizeShell(input) {
  const tokens = [];
  let current = "";
  let quoteChar = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoteChar) {
      if (ch === quoteChar) quoteChar = null;
      else if (ch === "\\" && quoteChar === "\"" && i + 1 < input.length) { current += input[i + 1]; i += 1; }
      else current += ch;
    } else if (ch === "'" || ch === "\"") {
      quoteChar = ch;
    } else if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[i + 1];
      i += 1;
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export async function checkBranchOpenGate({ store, cwd = process.cwd(), explicitRepo = null, explicitBranch = null }) {
  const projects = await readConfiguredProjects(store.root);
  if (!projects.length) return { managed: false };

  let matched = null;
  const currentCommon = await gitCommonDir(cwd);
  if (explicitRepo) {
    matched = projects.find((project) => project.githubRepo?.toLowerCase() === String(explicitRepo).toLowerCase()) || null;
  }
  if (!matched && currentCommon) {
    for (const project of projects) {
      const projectCommon = project.commonDir || await gitCommonDir(project.repoPath);
      if (projectCommon && projectCommon === currentCommon) { matched = project; break; }
    }
  }
  if (!matched) return { managed: false };

  const targetCwd = currentCommon && (!explicitRepo || (await gitCommonDir(matched.repoPath)) === currentCommon) ? cwd : matched.repoPath;
  let state;
  let target;
  try {
    state = await checkout(targetCwd);
    const branchToCheck = explicitBranch && !/^\d+$/.test(explicitBranch) ? explicitBranch : null;
    if (explicitBranch && /^\d+$/.test(explicitBranch) && state.branch === (matched.baseBranch || "main")) {
      return { managed: true, project: matched, ready: false, reasons: [`check out PR #${explicitBranch}'s branch before marking it ready so Field Report can verify its MRR`] };
    }
    target = await mrrTarget(matched, targetCwd, branchToCheck);
  } catch (error) {
    return { managed: true, project: matched, ready: false, reasons: [error.message] };
  }

  const [reviews, dispositions] = await Promise.all([
    store.reviews(matched.id, target.branch),
    store.dispositions(matched.id, target.branch)
  ]);
  const ancestors = await ancestorHeads(target.repoRoot, reviews.map((r) => r.head), target.head);
  const gate = evaluateMrrGate({ target, reviews, dispositions, ancestors });
  const extra = explicitBranch && state.branch !== target.branch
    ? []
    : openReasons({ checkout: state, target });
  const reasons = [...gate.reasons, ...extra];
  return { managed: true, project: matched, branch: target.branch, target, gate, ready: reasons.length === 0, reasons };
}

export async function handleHostHook(event, rawStdin, { store, cwd = process.cwd(), env = process.env } = {}) {
  let payload = {};
  try { payload = JSON.parse(String(rawStdin || "").trim() || "{}"); } catch { payload = {}; }
  const hookCwd = payload.cwd || (Array.isArray(payload.workspace_roots) ? payload.workspace_roots[0] : null) || cwd;
  const isCursor = String(payload.hook_event_name || "").startsWith("before") || Array.isArray(payload.workspace_roots);

  if (event === "prompt-submit") {
    await capturePromptFromHook(rawStdin, { store, cwd: hookCwd, env }).catch(() => {});
    return { exitCode: 0, stdout: isCursor ? `${JSON.stringify({ continue: true })}\n` : "", stderr: "" };
  }

  if (event === "session-start") {
    const sessionId = payload.session_id || payload.conversation_id || payload.sessionId || null;
    if (sessionId && env.CLAUDE_ENV_FILE && /^[A-Za-z0-9._:-]+$/.test(String(sessionId))) {
      await appendFile(env.CLAUDE_ENV_FILE, `export FR_SESSION_ID=${quote(sessionId)}\n`).catch(() => {});
    }
    const projects = await readConfiguredProjects(store.root);
    const currentCommon = await gitCommonDir(hookCwd);
    let matched = null;
    if (currentCommon) {
      for (const project of projects) {
        const projectCommon = project.commonDir || await gitCommonDir(project.repoPath);
        if (projectCommon && projectCommon === currentCommon) { matched = project; break; }
      }
    }
    if (!matched) return { exitCode: 0, stdout: "", stderr: "" };
    const sessionHint = sessionId ? ` (session: ${sessionId})` : "";
    const message = [
      `Field Report enabled for project '${matched.id}'${sessionHint} (base: ${matched.baseBranch || "main"}).`,
      `- Todos: ${describeTodos(todosFor(matched), matched)}`,
      `- Plans: ${describePlans(plansFor(matched))}`,
      `- Rules: run 'fr crr' before keep-commits; run 'fr mrr'${sessionId ? ` --session ${sessionId}` : ""} before opening/readying a PR (draft PRs allowed for CI — tell the user MRR has not run if handing off); never merge.`
    ].join("\n");
    return { exitCode: 0, stdout: `${message}\n`, stderr: "" };
  }

  if (event === "pre-tool") {
    const toolName = String(payload.tool_name || payload.toolName || "");
    const commandText = payload.tool_input?.command || payload.command || "";
    let needsGate = false;
    let explicitRepo = null;
    let explicitBranch = null;

    if (commandText) {
      for (const ghArgs of extractShellGhInvocations(commandText)) {
        const classified = classifyGhArgs(ghArgs);
        if (classified.action === "open-pr" || classified.action === "ready-pr") {
          needsGate = true;
          explicitRepo = classified.explicitRepo;
          explicitBranch = classified.explicitHead || classified.selector;
          break;
        }
      }
    } else if (/(?:^|__)create_pull_request$/.test(toolName) && payload.tool_input?.draft !== true && payload.arguments?.draft !== true) {
      needsGate = true;
      const owner = payload.tool_input?.owner || payload.arguments?.owner;
      const repo = payload.tool_input?.repo || payload.arguments?.repo;
      const headArg = payload.tool_input?.head || payload.arguments?.head;
      if (owner && repo) explicitRepo = `${owner}/${repo}`;
      if (headArg) explicitBranch = stripOwnerPrefix(headArg);
    }

    if (!needsGate) {
      return { exitCode: 0, stdout: isCursor ? `${JSON.stringify({ permission: "allow" })}\n` : "", stderr: "" };
    }

    const check = await checkBranchOpenGate({ store, cwd: hookCwd, explicitRepo, explicitBranch });
    if (!check.managed || check.ready) {
      return { exitCode: 0, stdout: isCursor ? `${JSON.stringify({ permission: "allow" })}\n` : "", stderr: "" };
    }

    const blockMsg = `Field Report BLOCKED opening/readying a PR on ${check.project.id}${check.branch ? `/${check.branch}` : ""}: ${check.reasons.join("; ")}. Run 'fr mrr' on this branch until READY before opening a non-draft PR.`;
    if (isCursor) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ permission: "deny", user_message: blockMsg, agent_message: blockMsg })}\n`,
        stderr: ""
      };
    }
    return { exitCode: 2, stdout: "", stderr: `${blockMsg}\n` };
  }

  return { exitCode: 0, stdout: "", stderr: "" };
}

async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.next`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(temp, file);
}

export async function installHostHooks({ frBin, home = os.homedir() }) {
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  let claude = {};
  try { claude = JSON.parse(await readFile(claudeSettingsPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot parse ${claudeSettingsPath}: ${error.message}`); }
  if (!claude || typeof claude !== "object" || Array.isArray(claude)) claude = {};
  const hooks = claude.hooks && typeof claude.hooks === "object" && !Array.isArray(claude.hooks) ? { ...claude.hooks } : {};

  const isOurClaudeGroup = (group) => Array.isArray(group?.hooks) && group.hooks.some((h) => String(h?.command || "").includes(HOOK_MARKER));
  const setClaudeHook = (eventName, matcher, sub) => {
    const prior = Array.isArray(hooks[eventName]) ? hooks[eventName].filter((item) => !isOurClaudeGroup(item)) : [];
    const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `${quote(frBin)} _hook ${sub}` }] };
    hooks[eventName] = [...prior, entry];
  };
  setClaudeHook("SessionStart", "", "session-start");
  setClaudeHook("UserPromptSubmit", "", "prompt-submit");
  setClaudeHook("PreToolUse", "Bash|mcp__.*create_pull_request", "pre-tool");
  claude.hooks = hooks;
  await writeJsonAtomic(claudeSettingsPath, claude);

  const cursorHooksPath = path.join(home, ".cursor", "hooks.json");
  let cursor = { version: 1, hooks: {} };
  try { cursor = JSON.parse(await readFile(cursorHooksPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot parse ${cursorHooksPath}: ${error.message}`); }
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) cursor = { version: 1, hooks: {} };
  if (!cursor.version) cursor.version = 1;
  const chooks = cursor.hooks && typeof cursor.hooks === "object" && !Array.isArray(cursor.hooks) ? { ...cursor.hooks } : {};

  const isOurCursorEntry = (item) => String(item?.command || "").includes(HOOK_MARKER);
  const setCursorHook = (eventName, sub) => {
    const prior = Array.isArray(chooks[eventName]) ? chooks[eventName].filter((item) => !isOurCursorEntry(item)) : [];
    chooks[eventName] = [...prior, { command: `${quote(frBin)} _hook ${sub}` }];
  };
  setCursorHook("beforeSubmitPrompt", "prompt-submit");
  setCursorHook("beforeShellExecution", "pre-tool");
  setCursorHook("beforeMCPExecution", "pre-tool");
  cursor.hooks = chooks;
  await writeJsonAtomic(cursorHooksPath, cursor);

  return { claudeSettingsPath, cursorHooksPath };
}

export function hasInstalledHostHooks(rawJson, kind) {
  if (!rawJson) return false;
  try {
    const parsed = JSON.parse(rawJson);
    const serialized = JSON.stringify(parsed?.hooks || {});
    if (kind === "claude") {
      return serialized.includes("_hook session-start") && serialized.includes("_hook prompt-submit") && serialized.includes("_hook pre-tool");
    }
    if (kind === "cursor") {
      return serialized.includes("_hook prompt-submit") && serialized.includes("_hook pre-tool");
    }
    return false;
  } catch {
    return false;
  }
}
