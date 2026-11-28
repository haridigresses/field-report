import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { quote } from "./hooks.mjs";
import { capturePromptFromHook, readConfiguredProjects } from "./prompts.mjs";
import { ancestorHeads, checkout, gitCommonDir, mrrTarget, resolvePullRequestRef } from "./repository.mjs";
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
const API_VALUE_FLAGS = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--hostname"]);

// Single-pass option-aware classifier for gh invocations (`gh pr create`,
// `gh pr ready`, and `gh api` PR-create/ready mutations).
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

  if (command === "api") {
    const apiArgs = args.slice(index + 1);
    let endpoint = null;
    let method = null;
    const fields = [];
    for (let i = 0; i < apiArgs.length; i += 1) {
      const arg = apiArgs[i];
      if (arg === "--") break;
      if ((arg === "-X" || arg === "--method") && apiArgs[i + 1] != null) { method = apiArgs[i + 1].toUpperCase(); i += 1; continue; }
      if (arg.startsWith("--method=")) { method = arg.slice("--method=".length).toUpperCase(); continue; }
      if ((arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field") && apiArgs[i + 1] != null) { fields.push(apiArgs[i + 1]); i += 1; continue; }
      if (API_VALUE_FLAGS.has(arg)) { i += 1; continue; }
      if (!arg.startsWith("-") && !endpoint) endpoint = arg;
    }
    const joinedFields = fields.join("\n");
    if (endpoint === "graphql" && /createPullRequest|markPullRequestReadyForReview/i.test(joinedFields) && !/isDraft\s*:\s*true/i.test(joinedFields)) {
      return { action: "open-pr", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };
    }
    const pullsMatch = String(endpoint || "").match(/^(?:\/)?repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+))?$/i);
    if (pullsMatch) {
      const repoSlug = pullsMatch[1] !== "{owner}/{repo}" ? pullsMatch[1] : explicitRepo;
      const hasFields = fields.length > 0;
      const effectiveMethod = method || (hasFields ? "POST" : "GET");
      const isDraftTrue = fields.some((f) => /^draft=(?:true|1)$/i.test(f));
      const isDraftFalse = fields.some((f) => /^draft=(?:false|0)$/i.test(f));
      const headField = fields.find((f) => /^head=/i.test(f));
      const explicitHead = headField ? stripOwnerPrefix(headField.slice("head=".length)) : null;
      if (!pullsMatch[2] && effectiveMethod === "POST") {
        return { action: isDraftTrue ? "draft-pr" : "open-pr", cleanedArgs: args, explicitRepo: repoSlug, explicitHead, selector: null };
      }
      if (pullsMatch[2] && (effectiveMethod === "PATCH" || effectiveMethod === "POST") && isDraftFalse) {
        return { action: "ready-pr", cleanedArgs: args, explicitRepo: repoSlug, explicitHead: null, selector: pullsMatch[2] };
      }
    }
    return { action: "allow", cleanedArgs: args, explicitRepo, explicitHead: null, selector: null };
  }

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
      if (arg === "--draft" || arg === "-d") { isDraft = true; continue; }
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

export async function checkBranchOpenGate({ store, cwd = process.cwd(), explicitRepo = null, explicitBranch = null, selector = null, ghBin = "gh" }) {
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
  const ancestors = await ancestorHeads(target.repoRoot, reviews.map((r) => r.head), target.head);
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
    const toolName = String(payload.tool_name || payload.toolName || "");
    const toolInput = payload.tool_input || payload.arguments || payload.input || {};
    const commandText = toolInput.command || payload.command || "";
    let needsGate = false;
    let explicitRepo = null;
    let explicitBranch = null;
    let selector = null;

    if (commandText) {
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
    } else if (/(?:create|open)_pull_request/i.test(toolName) && toolInput.draft !== true) {
      needsGate = true;
      if (toolInput.owner && toolInput.repo) explicitRepo = `${toolInput.owner}/${toolInput.repo}`;
      if (toolInput.head) explicitBranch = stripOwnerPrefix(toolInput.head);
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
