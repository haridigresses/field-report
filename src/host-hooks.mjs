import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { quote } from "./hooks.mjs";
import { capturePromptFromHook, readConfiguredProjects } from "./prompts.mjs";
import { ancestorHeads, checkout, gitCommonDir, gitRemoteSlugs, mrrTarget, parseGitHubSlug, resolvePullRequestRef } from "./repository.mjs";
import { describePlans, describeTodos, plansFor, todosFor } from "./store.mjs";
import { evaluateMrrGate, openReasons } from "./policy.mjs";

const HOOK_MARKER = " _hook ";

function stripOwnerPrefix(headSpec) {
  if (!headSpec) return null;
  const text = String(headSpec).trim();
  const colon = text.indexOf(":");
  return colon >= 0 ? text.slice(colon + 1) : text;
}

const PR_CREATE_VALUE_FLAGS = new Set(["-R", "--repo", "-h", "--hostname", "-a", "--assignee", "-B", "--base", "-b", "--body", "-F", "--body-file", "-H", "--head", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "-t", "--title"]);

// Single-pass option-aware classifier for the normal gh PR-open paths
// (`gh pr create` without `--draft` and `gh pr ready`). Raw HTTP tools (`gh api`,
// `curl`) are intentionally out of scope of local command classification.
export function classifyGhArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  let index = 0;
  let explicitRepo = null;

  while (index < args.length) {
    const token = args[index];
    if ((token === "-R" || token === "--repo") && args[index + 1] != null) {
      explicitRepo = args[index + 1];
      index += 2;
      continue;
    }
    if (token.startsWith("--repo=")) {
      explicitRepo = token.slice("--repo=".length);
      index += 1;
      continue;
    }
    if ((token === "-h" || token === "--hostname") && args[index + 1] != null) {
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

  if (command !== "pr" || !subcommand) return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };
  if (rest.includes("--help") || rest.includes("-h")) return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };

  if (subcommand === "create") {
    let isDraft = false;
    let explicitHead = null;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--") break;
      if ((arg === "-R" || arg === "--repo") && rest[i + 1] != null) { explicitRepo = rest[i + 1]; i += 1; continue; }
      if (arg.startsWith("--repo=")) { explicitRepo = arg.slice("--repo=".length); continue; }
      if ((arg === "-H" || arg === "--head") && rest[i + 1] != null) { explicitHead = stripOwnerPrefix(rest[i + 1]); i += 1; continue; }
      if (arg.startsWith("--head=")) { explicitHead = stripOwnerPrefix(arg.slice("--head=".length)); continue; }
      if (PR_CREATE_VALUE_FLAGS.has(arg)) { i += 1; continue; }
      if (arg === "--draft" || arg === "-d" || arg === "--draft=true") { isDraft = true; continue; }
      if (arg === "--draft=false") { isDraft = false; continue; }
      if (/^-[A-Za-z]{2,}$/.test(arg) && !PR_CREATE_VALUE_FLAGS.has(arg.slice(0, 2)) && arg.includes("d")) { isDraft = true; continue; }
    }
    return { action: isDraft ? "draft-pr" : "open-pr", cleanedArgs: args, explicitRepo, explicitHead, selector: null };
  }

  if (subcommand === "ready") {
    let selector = null;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--") break;
      if (arg === "--undo") return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };
      if ((arg === "-R" || arg === "--repo") && rest[i + 1] != null) { explicitRepo = rest[i + 1]; i += 1; continue; }
      if (arg.startsWith("--repo=")) { explicitRepo = arg.slice("--repo=".length); continue; }
      if (!arg.startsWith("-") && !selector) selector = arg;
    }
    return { action: "ready-pr", cleanedArgs: args, explicitRepo, explicitHead: null, selector };
  }

  return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };
}

// Quote-, command-substitution-, and heredoc-aware shell command splitter so
// multi-line bodies (`--body "$(cat <<'EOF'\n- a; b\nEOF\n)" --draft`) and
// quoted operators (`--title "a | b" --head feat/other`) never truncate argv.
export function extractShellGhInvocations(commandText) {
  const commands = splitAndTokenizeShell(String(commandText || ""));
  const invocations = [];
  for (const tokens of commands) {
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

function splitAndTokenizeShell(input) {
  const commands = [];
  let cmdTokens = [];
  let current = "";
  let hasToken = false;
  const stack = []; // "SQ" | "DQ" | "SUBST" | "BT"
  const heredocs = [];

  const flushToken = () => {
    if (hasToken || current.length > 0) {
      cmdTokens.push(current);
      current = "";
      hasToken = false;
    }
  };
  const flushCommand = () => {
    flushToken();
    if (cmdTokens.length) {
      commands.push(cmdTokens);
      cmdTokens = [];
    }
  };

  const consumeHeredocs = (newlineIndex) => {
    let cursor = newlineIndex;
    while (heredocs.length > 0) {
      const delim = heredocs.shift();
      let lineStart = cursor + 1;
      while (lineStart <= input.length) {
        const nl = input.indexOf("\n", lineStart);
        const lineEnd = nl < 0 ? input.length : nl;
        if (input.slice(lineStart, lineEnd).trim() === delim) {
          cursor = nl < 0 ? input.length : nl;
          break;
        }
        if (nl < 0) { cursor = input.length; break; }
        lineStart = nl + 1;
      }
    }
    return cursor;
  };

  const tryQueueHeredoc = (pos) => {
    if (input[pos] !== "<" || input[pos + 1] !== "<" || input[pos + 2] === "<") return 0;
    let rest = input.slice(pos + 2);
    let consumed = 2;
    if (rest.startsWith("-")) { rest = rest.slice(1); consumed += 1; }
    const match = rest.match(/^\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!match) return 0;
    heredocs.push(match[2]);
    return consumed + match[0].length;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const top = stack[stack.length - 1] || null;

    if (top === "SQ") {
      if (ch === "'") stack.pop();
      else current += ch;
      continue;
    }
    if (top === "BT") {
      if (ch === "\\" && i + 1 < input.length) { current += input[i + 1]; i += 1; }
      else if (ch === "`") stack.pop();
      else current += ch;
      continue;
    }
    if (top === "DQ") {
      if (ch === "\"") stack.pop();
      else if (ch === "$" && input[i + 1] === "(") { current += "$("; stack.push("SUBST"); i += 1; }
      else if (ch === "`") { current += "`"; stack.push("BT"); }
      else if (ch === "\\" && i + 1 < input.length) { current += input[i + 1]; i += 1; }
      else current += ch;
      continue;
    }
    if (top === "SUBST") {
      const hdLen = tryQueueHeredoc(i);
      if (hdLen > 0) {
        current += input.slice(i, i + hdLen);
        i += hdLen - 1;
        continue;
      }
      if (ch === "\n" && heredocs.length > 0) {
        const endIdx = consumeHeredocs(i);
        current += input.slice(i, Math.min(endIdx + 1, input.length));
        i = endIdx;
        continue;
      }
      if (ch === ")") { stack.pop(); current += ch; continue; }
      if (ch === "'") { stack.push("SQ"); current += ch; continue; }
      if (ch === "\"") { stack.push("DQ"); current += ch; continue; }
      if (ch === "$" && input[i + 1] === "(") { stack.push("SUBST"); current += "$("; i += 1; continue; }
      if (ch === "`") { stack.push("BT"); current += ch; continue; }
      if (ch === "\\" && i + 1 < input.length) { current += input.slice(i, i + 2); i += 1; continue; }
      current += ch;
      continue;
    }

    // Top-level unquoted shell context:
    if (ch === "'") { hasToken = true; stack.push("SQ"); continue; }
    if (ch === "\"") { hasToken = true; stack.push("DQ"); continue; }
    if (ch === "$" && input[i + 1] === "(") { hasToken = true; current += "$("; stack.push("SUBST"); i += 1; continue; }
    if (ch === "`") { hasToken = true; current += "`"; stack.push("BT"); continue; }
    if (ch === "\\" && i + 1 < input.length) { hasToken = true; current += input[i + 1]; i += 1; continue; }

    const topHdLen = tryQueueHeredoc(i);
    if (topHdLen > 0) {
      flushToken();
      i += topHdLen - 1;
      continue;
    }

    if (ch === "\n") {
      flushCommand();
      if (heredocs.length > 0) i = consumeHeredocs(i);
      continue;
    }

    if ((ch === "&" && input[i + 1] === "&") || (ch === "|" && input[i + 1] === "|")) {
      flushCommand();
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|") {
      flushCommand();
      continue;
    }
    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }
    hasToken = true;
    current += ch;
  }
  flushCommand();
  return commands;
}

export async function checkBranchOpenGate({ store, cwd = process.cwd(), explicitRepo = null, explicitBranch = null, selector = null, ghBin = "gh" }) {
  const projects = await readConfiguredProjects(store.root, { strict: true });
  if (!projects.length) return { managed: false };

  let matched = null;
  const currentCommon = await gitCommonDir(cwd);
  let cwdProject = null;
  if (currentCommon) {
    for (const project of projects) {
      const projectCommon = project.commonDir || await gitCommonDir(project.repoPath);
      if (projectCommon && projectCommon === currentCommon) { cwdProject = project; break; }
    }
  }

  if (explicitRepo) {
    const wanted = (parseGitHubSlug(explicitRepo) || String(explicitRepo).trim()).toLowerCase();
    for (const project of projects) {
      const configuredSlug = project.githubRepo ? (parseGitHubSlug(project.githubRepo) || project.githubRepo).toLowerCase() : null;
      if (configuredSlug === wanted) { matched = project; break; }
      const slugs = await gitRemoteSlugs(project.repoPath);
      if (slugs.has(wanted)) { matched = project; break; }
    }
    if (!matched && cwdProject) {
      const cwdSlugs = await gitRemoteSlugs(cwdProject.repoPath);
      if (cwdProject.githubRepo) {
        cwdSlugs.add((parseGitHubSlug(cwdProject.githubRepo) || cwdProject.githubRepo).toLowerCase());
      }
      // Only treat explicitRepo as unmanaged when cwdProject has known GitHub
      // remote slug(s) and NONE of them match explicitRepo.
      if (cwdSlugs.size === 0 || cwdSlugs.has(wanted)) matched = cwdProject;
    }
    if (!matched) return { managed: false };
  } else {
    matched = cwdProject;
  }
  if (!matched) return { managed: false };

  const targetCwd = currentCommon && (!explicitRepo || (await gitCommonDir(matched.repoPath)) === currentCommon) ? cwd : matched.repoPath;
  let state;
  let target;
  try {
    state = await checkout(targetCwd);
    let resolvedBranch = explicitBranch || null;
    let resolvedHeadOid = null;

    if (!resolvedBranch && selector) {
      if (/^\d+$/.test(selector) || /^https?:\/\//i.test(selector)) {
        const prInfo = await resolvePullRequestRef(matched, selector, targetCwd, { ghBin });
        resolvedBranch = prInfo.headRefName;
        resolvedHeadOid = prInfo.headRefOid;
      } else {
        resolvedBranch = stripOwnerPrefix(selector);
      }
    }

    target = await mrrTarget(matched, targetCwd, resolvedBranch, resolvedHeadOid);
  } catch (error) {
    return { managed: true, project: matched, ready: false, reasons: [error.message] };
  }

  const [reviews, dispositions] = await Promise.all([
    store.reviews(matched.id, target.branch),
    store.dispositions(matched.id, target.branch)
  ]);
  const ancestors = await ancestorHeads(target.repoRoot, reviews.map((r) => r.head), target.head, target.baseHead);
  const gate = evaluateMrrGate({ target, reviews, dispositions, ancestors });
  const extra = state.branch === target.branch ? openReasons({ checkout: state, target }) : [];
  const reasons = [...gate.reasons, ...extra];
  return { managed: true, project: matched, branch: target.branch, target, gate, ready: reasons.length === 0, reasons };
}

export async function handleHostHook(event, rawStdin, { store, cwd = process.cwd(), env = process.env, ghBin = "gh" } = {}) {
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
    const hookEventName = String(payload.hook_event_name || "");
    const toolName = String(payload.tool_name || payload.toolName || "");
    let rawInput = payload.tool_input ?? payload.arguments ?? payload.input ?? {};
    if (typeof rawInput === "string") {
      try { rawInput = JSON.parse(rawInput); } catch { rawInput = {}; }
    }
    const toolInput = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
    const isMcpEvent = hookEventName === "beforeMCPExecution" || (toolName !== "" && !/^(?:Bash|Shell|Terminal|run_command)$/i.test(toolName));
    const commandText = !isMcpEvent ? (toolInput.command || payload.command || "") : "";
    let needsGate = false;
    let explicitRepo = null;
    let explicitBranch = null;
    let selector = null;

    if (!isMcpEvent && commandText) {
      for (const ghArgs of extractShellGhInvocations(commandText)) {
        const classified = classifyGhArgs(ghArgs);
        if (classified.action === "open-pr" || classified.action === "ready-pr") {
          needsGate = true;
          explicitRepo = classified.explicitRepo;
          explicitBranch = classified.explicitHead;
          selector = classified.selector;
          break;
        }
      }
    } else if (isMcpEvent && /(?:create|open)_pull_request|pull_request_write/i.test(toolName) && toolInput.draft !== true) {
      if (!/pull_request_write/i.test(toolName) || !toolInput.method || /create|open|ready/i.test(String(toolInput.method))) {
        needsGate = true;
        if (toolInput.owner && toolInput.repo) explicitRepo = `${toolInput.owner}/${toolInput.repo}`;
        if (toolInput.head) explicitBranch = stripOwnerPrefix(toolInput.head);
        if (toolInput.pull_number || toolInput.pullNumber || toolInput.number) {
          selector = String(toolInput.pull_number || toolInput.pullNumber || toolInput.number);
        }
      }
    } else if (/(?:ready_for_review|mark_pull_request_ready)/i.test(toolName) || (/update_pull_request/i.test(toolName) && toolInput.draft === false)) {
      needsGate = true;
      if (toolInput.owner && toolInput.repo) explicitRepo = `${toolInput.owner}/${toolInput.repo}`;
      if (toolInput.pull_number || toolInput.pullNumber || toolInput.number) {
        selector = String(toolInput.pull_number || toolInput.pullNumber || toolInput.number);
      }
    }

    if (!needsGate) {
      return { exitCode: 0, stdout: isCursor ? `${JSON.stringify({ permission: "allow" })}\n` : "", stderr: "" };
    }

    try {
      const check = await checkBranchOpenGate({ store, cwd: hookCwd, explicitRepo, explicitBranch, selector, ghBin });
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
    } catch (error) {
      const errMsg = `Field Report PreToolUse check failed closed: ${error.message}`;
      if (isCursor) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ permission: "deny", user_message: errMsg, agent_message: errMsg })}\n`,
          stderr: ""
        };
      }
      return { exitCode: 2, stdout: "", stderr: `${errMsg}\n` };
    }
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
  setClaudeHook("PreToolUse", "Bash|mcp__.*(?:pull_request|ready_for_review).*", "pre-tool");
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
