import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const GLOBAL_VALUE_FLAGS = new Set(["-R", "--repo", "-h", "--hostname", "--jq", "-q", "--template", "-t"]);
const PR_CREATE_VALUE_FLAGS = new Set(["-R", "--repo", "-h", "--hostname", "-a", "--assignee", "-B", "--base", "-b", "--body", "-F", "--body-file", "-H", "--head", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "-t", "--title"]);

// Option-aware classifier for real argv passed to ~/.local/bin/gh (`gh pr create`
// without `--draft` and `gh pr ready`). Shell command strings are NOT parsed in
// PreToolUse — ~/.local/bin/gh executes in the actual working directory after any
// shell `cd` or worktree switch, avoiding false blocks against the session folder.
export function classifyGhArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  let index = 0;
  let explicitRepo = null;

  while (index < args.length) {
    const token = args[index];
    if (token === "--help" || token === "help") {
      return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };
    }
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
    if (GLOBAL_VALUE_FLAGS.has(token) && args[index + 1] != null) {
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

  if (subcommand === "create") {
    let isDraft = false;
    let explicitHead = null;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--") break;
      if (arg === "--help" || arg === "-h") return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };
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
      if (arg === "--help" || arg === "-h" || arg === "--undo") return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };
      if ((arg === "-R" || arg === "--repo") && rest[i + 1] != null) { explicitRepo = rest[i + 1]; i += 1; continue; }
      if (arg.startsWith("--repo=")) { explicitRepo = arg.slice("--repo=".length); continue; }
      if (!arg.startsWith("-") && !selector) selector = arg;
    }
    return { action: "ready-pr", cleanedArgs: args, explicitRepo, explicitHead: null, selector };
  }

  return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };
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

function hookAllowOutput({ isAntigravity, isCursor }) {
  if (isAntigravity) return { exitCode: 0, stdout: `${JSON.stringify({ decision: "allow" })}\n`, stderr: "" };
  if (isCursor) return { exitCode: 0, stdout: `${JSON.stringify({ permission: "allow" })}\n`, stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
}

function hookDenyOutput(message, { isAntigravity, isCursor }) {
  if (isAntigravity) return { exitCode: 0, stdout: `${JSON.stringify({ decision: "deny", reason: message })}\n`, stderr: "" };
  if (isCursor) return { exitCode: 0, stdout: `${JSON.stringify({ permission: "deny", user_message: message, agent_message: message })}\n`, stderr: "" };
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}

function buildEnabledSessionBanner(matched, sessionId) {
  const sessionHint = sessionId ? ` (session: ${sessionId})` : "";
  const sessionFlag = sessionId ? ` --session ${sessionId}` : "";
  return [
    `Field Report ACTIVE for repository '${matched.id}'${sessionHint} (base: ${matched.baseBranch || "main"}).`,
    `- Applies to ALL work in this repo: audits, gap analyses, BRR, TRR, CRR, MRR, coding, PRs, and every delegated subagent/worker brief.`,
    `- Terminology mandate: whenever BRR, MRR, TRR, or CRR is requested, load the 'brr' or 'field-report' skill and use the configured multi-provider panel ('fr seats') — never invent custom definitions or single-model substitutes.`,
    `- Todos: ${describeTodos(todosFor(matched), matched)}`,
    `- Plans: ${describePlans(plansFor(matched))}`,
    `- Commit gate: stage changes ('git add') and run 'fr crr' before 'git commit' (enforced by hooks/pre-commit on staged tree SHA).`,
    `- PR-open gate: run 3-seat 'fr mrr${sessionFlag}' until 'fr gate open' is READY before any non-draft PR ('gh pr create --draft' allowed for early CI if you tell the user MRR has not run); never merge.`
  ].join("\n");
}

export async function handleHostHook(event, rawStdin, { store, cwd = process.cwd(), env = process.env, ghBin = "gh" } = {}) {
  let payload = {};
  try { payload = JSON.parse(String(rawStdin || "").trim() || "{}"); } catch { payload = {}; }
  const isAntigravity = Boolean(payload.hookEventName || Array.isArray(payload.workspacePaths) || payload.toolCall);
  const isCursor = !isAntigravity && (String(payload.hook_event_name || "").startsWith("before") || Array.isArray(payload.workspace_roots));
  const candidateDirs = [
    payload.cwd,
    ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []),
    ...(Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []),
    cwd
  ].filter((entry) => typeof entry === "string" && entry.trim());
  const hookCwd = candidateDirs[0] || cwd;

  if (event === "prompt-submit") {
    await capturePromptFromHook(rawStdin, { store, cwd: payload.cwd || null, env }).catch(() => {});
    if (isAntigravity) return { exitCode: 0, stdout: "{}\n", stderr: "" };
    return { exitCode: 0, stdout: isCursor ? `${JSON.stringify({ continue: true })}\n` : "", stderr: "" };
  }

  if (event === "session-start") {
    const sessionId = payload.session_id || payload.conversation_id || payload.conversationId || payload.sessionId || null;
    if (sessionId && env.CLAUDE_ENV_FILE && /^[A-Za-z0-9._:-]+$/.test(String(sessionId))) {
      await appendFile(env.CLAUDE_ENV_FILE, `export FR_SESSION_ID=${quote(sessionId)}\n`).catch(() => {});
    }
    const projects = await readConfiguredProjects(store.root);
    let matched = null;
    for (const dir of candidateDirs) {
      const currentCommon = await gitCommonDir(dir);
      if (!currentCommon) continue;
      for (const project of projects) {
        const projectCommon = project.commonDir || await gitCommonDir(project.repoPath);
        if (projectCommon && projectCommon === currentCommon) { matched = project; break; }
      }
      if (matched) break;
    }
    if (!matched) return { exitCode: 0, stdout: isAntigravity ? "{}\n" : "", stderr: "" };
    const message = buildEnabledSessionBanner(matched, sessionId);
    if (isAntigravity) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: message } }] })}\n`,
        stderr: ""
      };
    }
    return { exitCode: 0, stdout: `${message}\n`, stderr: "" };
  }

  // PreToolUse gates GitHub MCP PR-open/ready calls ONLY. Shell `gh` calls are
  // gated by ~/.local/bin/gh in the actual directory where `gh` executes.
  if (event === "pre-tool") {
    const hookEventName = String(payload.hook_event_name || payload.hookEventName || "");
    const toolName = String(payload.tool_name || payload.toolName || payload.toolCall?.name || "");
    if (hookEventName === "beforeShellExecution" || /^(?:Bash|Shell|Terminal|run_command|exec)$/i.test(toolName)) {
      return hookAllowOutput({ isAntigravity, isCursor });
    }

    let rawInput = payload.tool_input ?? payload.toolCall?.args ?? payload.arguments ?? payload.input ?? {};
    if (typeof rawInput === "string") {
      try { rawInput = JSON.parse(rawInput); } catch { rawInput = {}; }
    }
    const toolInput = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
    let needsGate = false;
    let explicitRepo = null;
    let explicitBranch = null;
    let selector = null;

    if (/(?:create|open)_pull_request|pull_request_write/i.test(toolName) && toolInput.draft !== true) {
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
      return hookAllowOutput({ isAntigravity, isCursor });
    }

    try {
      let gateCwd = hookCwd;
      for (const dir of candidateDirs) {
        if (await gitCommonDir(dir)) { gateCwd = dir; break; }
      }
      const check = await checkBranchOpenGate({ store, cwd: gateCwd, explicitRepo, explicitBranch, selector, ghBin });
      if (!check.managed || check.ready) {
        return hookAllowOutput({ isAntigravity, isCursor });
      }

      const blockMsg = `Field Report BLOCKED opening/readying a PR on ${check.project.id}${check.branch ? `/${check.branch}` : ""}: ${check.reasons.join("; ")}. Run 'fr mrr' on this branch until READY before opening a non-draft PR.`;
      return hookDenyOutput(blockMsg, { isAntigravity, isCursor });
    } catch (error) {
      const errMsg = `Field Report PreToolUse check failed closed: ${error.message}`;
      return hookDenyOutput(errMsg, { isAntigravity, isCursor });
    }
  }

  return { exitCode: 0, stdout: isAntigravity ? "{}\n" : "", stderr: "" };
}

async function writeJsonAtomic(file, data, { mode } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.next`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
  await rename(temp, file);
}

function buildClaudeStyleHooks(priorHooks, frBin, { includePreCompact = false } = {}) {
  const hooks = priorHooks && typeof priorHooks === "object" && !Array.isArray(priorHooks) ? { ...priorHooks } : {};
  const isOurGroup = (group) => Array.isArray(group?.hooks) && group.hooks.some((h) => String(h?.command || "").includes(HOOK_MARKER));
  const setHook = (eventName, matcher, sub) => {
    const prior = Array.isArray(hooks[eventName]) ? hooks[eventName].filter((item) => !isOurGroup(item)) : [];
    const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `${quote(frBin)} _hook ${sub}` }] };
    hooks[eventName] = [...prior, entry];
  };
  setHook("SessionStart", "", "session-start");
  if (includePreCompact) setHook("PreCompact", "", "session-start");
  setHook("UserPromptSubmit", "", "prompt-submit");
  setHook("PreToolUse", "mcp__.*(?:pull_request|ready_for_review).*", "pre-tool");
  return hooks;
}

export async function installHostHooks({ frBin, home = os.homedir() }) {
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  let claude = {};
  try { claude = JSON.parse(await readFile(claudeSettingsPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot parse ${claudeSettingsPath}: ${error.message}`); }
  if (!claude || typeof claude !== "object" || Array.isArray(claude)) claude = {};
  claude.hooks = buildClaudeStyleHooks(claude.hooks, frBin, { includePreCompact: true });
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
  // Remove any legacy beforeShellExecution hook so `cd worktree && gh ...` is handled by ~/.local/bin/gh.
  if (Array.isArray(chooks.beforeShellExecution)) {
    const cleaned = chooks.beforeShellExecution.filter((item) => !isOurCursorEntry(item));
    if (cleaned.length) chooks.beforeShellExecution = cleaned;
    else delete chooks.beforeShellExecution;
  }
  setCursorHook("beforeSubmitPrompt", "prompt-submit");
  setCursorHook("beforeMCPExecution", "pre-tool");
  cursor.hooks = chooks;
  await writeJsonAtomic(cursorHooksPath, cursor);

  // Antigravity plugin lifecycle hooks (~/.gemini/config/plugins/field-report/hooks.json).
  const agyHooksPath = path.join(home, ".gemini", "config", "plugins", "field-report", "hooks.json");
  let agy = {};
  try { agy = JSON.parse(await readFile(agyHooksPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot parse ${agyHooksPath}: ${error.message}`); }
  if (!agy || typeof agy !== "object" || Array.isArray(agy)) agy = {};
  agy["field-report"] = {
    SessionStart: [{ type: "command", command: `${quote(frBin)} _hook session-start` }],
    PreInvocation: [{ type: "command", command: `${quote(frBin)} _hook prompt-submit` }],
    PreToolUse: [
      {
        matcher: "mcp_.*(?:pull_request|ready_for_review).*",
        hooks: [{ type: "command", command: `${quote(frBin)} _hook pre-tool` }]
      }
    ]
  };
  await writeJsonAtomic(agyHooksPath, agy);

  // Local Devin CLI config (~/.config/devin/config.json): configure hooks only when
  // ~/.config/devin already exists so non-Devin machines stay clean, preserving 0o600.
  const devinDir = path.join(home, ".config", "devin");
  let devinConfigPath = null;
  const hasDevinDir = await access(devinDir).then(() => true, () => false);
  if (hasDevinDir) {
    devinConfigPath = path.join(devinDir, "config.json");
    let devin = {};
    try { devin = JSON.parse(await readFile(devinConfigPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot parse ${devinConfigPath}: ${error.message}`); }
    if (!devin || typeof devin !== "object" || Array.isArray(devin)) devin = {};
    devin.hooks = buildClaudeStyleHooks(devin.hooks, frBin, { includePreCompact: false });
    await writeJsonAtomic(devinConfigPath, devin, { mode: 0o600 });
  }

  return { claudeSettingsPath, cursorHooksPath, agyHooksPath, devinConfigPath };
}

export function hasInstalledHostHooks(rawJson, kind) {
  if (!rawJson) return false;
  try {
    const parsed = JSON.parse(rawJson);
    if (kind === "agy") {
      const serialized = JSON.stringify(parsed?.["field-report"] || {});
      return serialized.includes("_hook session-start") && serialized.includes("_hook prompt-submit") && serialized.includes("_hook pre-tool");
    }
    const hooksObj = parsed?.hooks || {};
    const serialized = JSON.stringify(hooksObj);
    if (kind === "claude") {
      return Array.isArray(hooksObj.SessionStart) && Array.isArray(hooksObj.PreCompact) && serialized.includes("_hook session-start") && serialized.includes("_hook prompt-submit") && serialized.includes("_hook pre-tool");
    }
    if (kind === "devin") {
      return serialized.includes("_hook session-start") && serialized.includes("_hook prompt-submit") && serialized.includes("_hook pre-tool");
    }
    if (kind === "cursor") {
      return serialized.includes("_hook prompt-submit") && serialized.includes("_hook pre-tool") && !JSON.stringify(hooksObj.beforeShellExecution || []).includes("_hook pre-tool");
    }
    return false;
  } catch {
    return false;
  }
}
