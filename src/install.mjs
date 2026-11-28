import { lstat, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SKILL_NAMES = ["field-report", "brr", "fr-grill-me", "fr-ask-questions"];
export const REMOVED_SKILL_NAMES = ["repo-coordinator", "workstream-orchestrator"];

export const HOST_MARKER_START = "<!-- field-report-host -->";
export const HOST_MARKER_END = "<!-- /field-report-host -->";
export const ONBOARDING_VERSION_TAG = "field-report-onboarding:v4";

export const SHELL_RC_FILES = [".zshrc", ".zprofile", ".bashrc", ".bash_profile"];

export function skillHostDirs(home = os.homedir()) {
  return [
    path.join(home, ".codex", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".config", "devin", "skills"),
    path.join(home, ".gemini", "config", "plugins", "field-report", "skills")
  ];
}

async function writeTextAtomic(file, content, mode) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.next`;
  await writeFile(temporary, content, mode ? { mode } : undefined);
  await rename(temporary, file);
}

export async function linkSkills(repoRoot, home = os.homedir()) {
  const ownPluginSkillsDir = path.join(home, ".gemini", "config", "plugins", "field-report", "skills");
  const destinations = [];
  for (const host of skillHostDirs(home)) {
    const isOwnPlugin = path.resolve(host) === path.resolve(ownPluginSkillsDir);
    for (const removed of REMOVED_SKILL_NAMES) {
      const stale = path.join(host, removed);
      try {
        const currentStat = await lstat(stale);
        if (currentStat.isSymbolicLink()) {
          const target = await readlink(stale);
          if (target.includes("field-report")) await rm(stale, { force: true });
        } else if (isOwnPlugin) {
          await rm(stale, { recursive: true, force: true });
        }
      } catch {}
    }
    for (const name of SKILL_NAMES) {
      const skill = path.join(host, name);
      try {
        const current = await lstat(skill);
        if (!current.isSymbolicLink()) {
          if (isOwnPlugin) await rm(skill, { recursive: true, force: true });
          else throw new Error(`Refusing to replace non-symlink skill path: ${skill}`);
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      destinations.push(skill);
    }
  }
  const linked = [];
  for (const skill of destinations) {
    await mkdir(path.dirname(skill), { recursive: true });
    const temporary = `${skill}.${process.pid}.next`;
    await symlink(path.join(repoRoot, "skills", path.basename(skill)), temporary);
    await rename(temporary, skill);
    linked.push(skill);
  }
  return linked;
}

export function buildHostBlock(onboardingPath) {
  return [
    HOST_MARKER_START,
    `<!-- ${ONBOARDING_VERSION_TAG} -->`,
    "Field Report rules (applies to audits, gap analyses, BRR, TRR, CRR, MRR, coding, PRs, and subagent briefs):",
    "- Whenever the user asks for or names `BRR`, `MRR`, `TRR`, `CRR`, or `Field Report`, load the installed `brr` or `field-report` skill and use the configured multi-provider panel (`fr seats`) — never invent custom definitions or single-model substitutes.",
    `- Before committing or opening/readying a PR in any repository, check the \`SessionStart\` banner or run \`fr status\` (full reference: \`${onboardingPath}\`). If \`fr status\` prints \`No Field Report project matches this checkout\`, skip Field Report and do not register it unless asked.`,
    "- In enabled repositories, include Field Report in every builder/worker/subagent brief, stage changes and run `fr crr` before `git commit` (enforced by `hooks/pre-commit`), run 3-seat `fr mrr` until `fr gate open` is `READY` before any non-draft PR (`gh pr create --draft` allowed for early CI if you tell the user MRR has not run), always invoke `gh` on `PATH`, and never merge.",
    "- Bounded `fr crr` / `fr mrr` reviewers follow only their supplied brief (read-only exact diff, no `fr` commands, no MCP).",
    HOST_MARKER_END
  ].join("\n");
}

export function upsertMarkedBlock(existingText, block) {
  const current = String(existingText || "");
  const start = current.indexOf(HOST_MARKER_START);
  const endIdx = current.indexOf(HOST_MARKER_END);
  if (start >= 0 && endIdx > start) {
    const end = endIdx + HOST_MARKER_END.length;
    return `${current.slice(0, start)}${block}${current.slice(end)}`.replace(/\n{3,}/g, "\n\n");
  }
  const legacyLine = /^-\s*For repository delivery work, read [^\n]*field-report\/host-onboarding\.md[^\n]*\n?/m;
  if (legacyLine.test(current)) {
    return current.replace(legacyLine, `${block}\n\n`);
  }
  if (!current.trim()) return `${block}\n`;
  return `${block}\n\n${current.trimStart()}`;
}

export function mergeHostOnboardingDoc(existingText, rulesBody) {
  const managed = [
    HOST_MARKER_START,
    `<!-- ${ONBOARDING_VERSION_TAG} -->`,
    rulesBody.trim(),
    HOST_MARKER_END
  ].join("\n");

  const current = String(existingText || "");
  const start = current.indexOf(HOST_MARKER_START);
  const endIdx = current.indexOf(HOST_MARKER_END);
  if (start >= 0 && endIdx > start) {
    const before = current.slice(0, start).trim();
    const after = current.slice(endIdx + HOST_MARKER_END.length).trim();
    return [before, managed, after].filter(Boolean).join("\n\n") + "\n";
  }
  const authIdx = current.indexOf("## Standing review authorization");
  if (authIdx >= 0) {
    return `${managed}\n\n${current.slice(authIdx).trim()}\n`;
  }
  return `${managed}\n`;
}

// Repairs `alias claude='... --system-prompt-file ...'` -> `--append-system-prompt-file`
// in shell rc files so user aliases never wipe Claude Code's built-in skill & tool prompt.
export async function repairShellRcFiles(home = os.homedir()) {
  const repaired = [];
  const pattern = /^(\s*alias\s+claude=(['"])[^\r\n]*?)(?<!append-)--system-prompt-file(\b[^\r\n]*\2.*)$/gm;
  for (const name of SHELL_RC_FILES) {
    const file = path.join(home, name);
    let text;
    let fileInfo;
    try {
      fileInfo = await stat(file);
      if (fileInfo.isSymbolicLink?.()) continue;
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const updated = text.replace(pattern, "$1--append-system-prompt-file$3");
    if (updated !== text) {
      await writeTextAtomic(file, updated, fileInfo.mode & 0o777);
      repaired.push(file);
    }
  }
  return repaired;
}

export function detectShellRcFootguns(rawText) {
  const issues = [];
  const lines = String(rawText || "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    if (/^\s*alias\s+claude=/.test(line) && /(?<!append-)--system-prompt(?:-file)?\b/.test(line)) {
      issues.push({ line: i + 1, kind: "claude-system-prompt-override", detail: "aliases 'claude' with --system-prompt/-file (wipes Claude Code's built-in skill & tool system prompt); use --append-system-prompt-file" });
    }
    if (/^\s*alias\s+gh=/.test(line) || /^\s*(?:function\s+)?gh\s*\(\)/.test(line)) {
      issues.push({ line: i + 1, kind: "gh-alias", detail: "defines a shell alias/function for 'gh', bypassing the ~/.local/bin/gh PR-open gate" });
    }
  }
  return issues;
}

export async function installHostOnboarding({ repoRoot, home = os.homedir() }) {
  const rulesSource = path.join(repoRoot, "rules", "AGENTS.md");
  const pluginManifestSource = path.join(repoRoot, "plugin.json");
  const [rulesBody, pluginManifest] = await Promise.all([
    readFile(rulesSource, "utf8"),
    readFile(pluginManifestSource, "utf8")
  ]);

  const onboardingPath = path.join(home, ".local", "share", "field-report", "host-onboarding.md");
  const priorOnboarding = await readFile(onboardingPath, "utf8").catch(() => "");
  await writeTextAtomic(onboardingPath, mergeHostOnboardingDoc(priorOnboarding, rulesBody));

  const block = buildHostBlock(onboardingPath);

  const claudeMdPath = path.join(home, ".claude", "CLAUDE.md");
  const priorClaude = await readFile(claudeMdPath, "utf8").catch(() => "");
  await writeTextAtomic(claudeMdPath, upsertMarkedBlock(priorClaude, block));

  const codexMdPath = path.join(home, ".codex", "AGENTS.md");
  const priorCodex = await readFile(codexMdPath, "utf8").catch(() => "");
  await writeTextAtomic(codexMdPath, upsertMarkedBlock(priorCodex, block));

  const cursorRulePath = path.join(home, ".cursor", "rules", "field-report.mdc");
  const cursorMdc = [
    "---",
    "description: Field Report commit-time CRR gate, three-seat pre-PR MRR gate, and BRR/TRR/MRR skill rules",
    "alwaysApply: true",
    "---",
    "",
    `<!-- ${ONBOARDING_VERSION_TAG} -->`,
    rulesBody.trim(),
    ""
  ].join("\n");
  await writeTextAtomic(cursorRulePath, cursorMdc);

  const agyPluginDir = path.join(home, ".gemini", "config", "plugins", "field-report");
  const agyPluginJsonPath = path.join(agyPluginDir, "plugin.json");
  const agyRulesPath = path.join(agyPluginDir, "rules", "AGENTS.md");
  await writeTextAtomic(agyPluginJsonPath, `${pluginManifest.trim()}\n`);
  await writeTextAtomic(agyRulesPath, `<!-- ${ONBOARDING_VERSION_TAG} -->\n${rulesBody.trim()}\n`);

  const repairedShellFiles = await repairShellRcFiles(home);

  return {
    onboardingPath,
    claudeMdPath,
    codexMdPath,
    cursorRulePath,
    agyPluginJsonPath,
    agyRulesPath,
    repairedShellFiles
  };
}

export function hasInstalledOnboarding(rawText, kind = "markdown") {
  const text = String(rawText || "");
  if (!text.includes(ONBOARDING_VERSION_TAG)) return false;
  if (kind === "cursor-mdc") return /alwaysApply:\s*true/.test(text);
  return true;
}
