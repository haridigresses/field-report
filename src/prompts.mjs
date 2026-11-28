import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { checkout, gitCommonDir } from "./repository.mjs";

// Session-keyed mechanical prompt capture via documented UserPromptSubmit /
// beforeSubmitPrompt hooks. Prompts are stored by (projectId, sessionId) — no
// branch guessing at capture time and no private transcript JSONL scraping.

export const MAX_DIALOGUE_BYTES = 40_000;

export function resolveEnvSessionId(env = process.env) {
  return [
    env.FR_SESSION_ID,
    env.CLAUDE_CODE_SESSION_ID,
    env.CLAUDE_SESSION_ID,
    env.CODEX_THREAD_ID,
    env.CURSOR_TRACE_ID
  ].find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

export function parseHookInput(rawText, env = process.env) {
  let payload = {};
  try { payload = JSON.parse(String(rawText || "").trim() || "{}"); }
  catch { payload = {}; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};

  const prompt = [payload.prompt, payload.user_prompt, payload.message, payload.text]
    .find((value) => typeof value === "string" && value.trim())?.trim() || null;

  const sessionId = [
    payload.session_id,
    payload.conversation_id,
    payload.sessionId,
    payload.thread_id,
    resolveEnvSessionId(env)
  ].find((value) => typeof value === "string" && value.trim())?.trim() || null;

  const cwd = [
    payload.cwd,
    Array.isArray(payload.workspace_roots) ? payload.workspace_roots[0] : null,
    env.PWD
  ].find((value) => typeof value === "string" && value.trim())?.trim() || process.cwd();

  const event = String(payload.hook_event_name || payload.event || "");
  const host = event === "beforeSubmitPrompt" || Array.isArray(payload.workspace_roots)
    ? "cursor"
    : event === "UserPromptSubmit" || payload.session_id
      ? "claude"
      : env.CODEX_THREAD_ID
        ? "codex"
        : "hook";

  return { prompt, sessionId, cwd, host, payload };
}

export async function readConfiguredProjects(stateRoot) {
  let files;
  try { files = (await readdir(path.join(stateRoot, "projects"))).filter((name) => name.endsWith(".json")).sort(); }
  catch { return []; }
  const projects = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(path.join(stateRoot, "projects", file), "utf8"));
      if (parsed?.id && parsed?.repoPath) projects.push(parsed);
    } catch {}
  }
  return projects;
}

export async function capturePromptFromHook(rawText, { store, cwd = null, env = process.env } = {}) {
  const parsed = parseHookInput(rawText, env);
  if (!parsed.prompt) return { captured: false, reason: "empty-prompt" };
  const targetCwd = cwd || parsed.cwd;
  const currentCommon = await gitCommonDir(targetCwd);
  if (!currentCommon) return { captured: false, reason: "not-git" };

  const projects = await readConfiguredProjects(store.root);
  let matched = null;
  for (const project of projects) {
    const projectCommon = project.commonDir || await gitCommonDir(project.repoPath);
    if (projectCommon && projectCommon === currentCommon) { matched = project; break; }
  }
  if (!matched) return { captured: false, reason: "unregistered-repo" };

  let gitState = { branch: "HEAD", head: null };
  try { gitState = await checkout(targetCwd); } catch {}

  const record = await store.appendPrompt(matched.id, {
    host: parsed.host,
    sessionId: parsed.sessionId || "default",
    branch: gitState.branch,
    head: gitState.head,
    prompt: parsed.prompt
  });
  return { captured: true, project: matched.id, sessionId: record.sessionId, record };
}

function cleanPrompt(text) {
  return String(text || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .replace(/<\/?USER_REQUEST>/g, "")
    .trim();
}

export function formatCappedPrompts(entries, maxBytes = MAX_DIALOGUE_BYTES) {
  if (!entries.length) return "";
  const blocks = entries.map((entry, index) => `[Prompt ${index + 1}${entry.ts ? ` · ${entry.ts}` : ""}]\n${cleanPrompt(entry.prompt)}`);
  const full = blocks.join("\n\n");
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;

  const first = `${blocks[0]}\n\n… (middle prompts omitted to fit ${maxBytes}B budget) …\n\n`;
  const tail = [];
  let bytes = Buffer.byteLength(first, "utf8");
  for (let index = blocks.length - 1; index >= 1; index -= 1) {
    const candidate = `${blocks[index]}\n\n`;
    const size = Buffer.byteLength(candidate, "utf8");
    if (bytes + size > maxBytes) break;
    tail.unshift(blocks[index]);
    bytes += size;
  }
  return `${first}${tail.join("\n\n")}`.trim();
}

// Resolve prompts for the session running MRR:
// 1. Explicit `--session <id>` or session env var (`FR_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`).
// 2. Otherwise, if the project has exactly one active session (or most recent session), use it.
export async function buildUserContract({ store, project, sessionId = null, env = process.env, brr = null, intentFileText = null, maxBytes = MAX_DIALOGUE_BYTES }) {
  let resolvedSession = sessionId || resolveEnvSessionId(env);
  let selected = [];
  if (resolvedSession) {
    selected = await store.prompts(project.id, resolvedSession);
  } else {
    const sessions = await store.promptSessions(project.id);
    if (sessions.length === 1) {
      resolvedSession = sessions[0].sessionId;
      selected = await store.prompts(project.id, resolvedSession);
    } else if (sessions.length > 1) {
      // Multiple sessions exist and host did not export sessionId: only auto-pick if
      // the newest session is unambiguous (updated >30m after the runner-up); otherwise
      // require --session <id> rather than silently mixing sessions.
      const newestMs = Date.parse(sessions[0].lastTs);
      const secondMs = Date.parse(sessions[1].lastTs);
      if (Number.isFinite(newestMs) && Number.isFinite(secondMs) && newestMs - secondMs > 30 * 60 * 1000) {
        resolvedSession = sessions[0].sessionId;
        selected = await store.prompts(project.id, resolvedSession);
      }
    }
  }

  const sections = [];
  if (brr?.text) {
    sections.push(`### AUTHORITATIVE BRR PLAN (${brr.source}) — DOMINATES\n${brr.text.trim()}`);
  }
  if (selected.length) {
    const budget = Math.max(8_000, maxBytes - Buffer.byteLength(sections.join("\n\n"), "utf8"));
    sections.push(`### VERBATIM USER PROMPTS (session ${resolvedSession}; chronological — later user instructions override earlier ones; note that one session may span multiple branches/PRs, so do NOT flag asks belonging to other branches or deferred follow-up PRs as missing here)\n${formatCappedPrompts(selected, budget)}`);
  } else if (intentFileText?.trim()) {
    sections.push(`### SUPPLIED INTENT CONTEXT (--intent-file; verify carefully against scope creep)\n${intentFileText.trim().slice(0, maxBytes)}`);
  } else {
    sections.push("### NO CAPTURED USER PROMPTS OR BRR (host may not offer a prompt hook)\nNo BRR plan or hook-captured user prompts were found for this session (hosts such as Codex, Devin, and Agy may not emit a prompt hook). Note this absence as a limitation in `summary` and review intent against the commit messages and builder notes in BUILDER TECHNICAL RATIONALE (putting unsettled product choices in `questions`), rather than returning `NO_GO` solely because prompts were not captured.");
  }
  return {
    text: sections.join("\n\n"),
    sessionId: resolvedSession || null,
    hasBrr: Boolean(brr?.text),
    promptCount: selected.length
  };
}
