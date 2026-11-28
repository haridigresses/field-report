import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeReview, parseEnvelope } from "./envelope.mjs";
import { launchCommandFor } from "./machines.mjs";
import { CRR_ROLE, validateReview } from "./policy.mjs";
import { configSource, normalizeId, seatFor } from "./seats.mjs";

export function inspectCommandFor(target) {
  if (target.kind === "crr") {
    return target.tree
      ? `git diff --no-ext-diff --no-textconv ${target.baseHead} ${target.tree} --`
      : "git diff --no-ext-diff --no-textconv HEAD --";
  }
  return `git diff --no-ext-diff --no-textconv ${target.baseHead} ${target.head} --`;
}

export function buildReviewPrompt({ brief, target, inventory, mergeRules = null, priorFindings = [], userContract = null, builderRationale = null }) {
  const isCrr = brief.kind === "crr";
  const targetDesc = isCrr
    ? (brief.tree ? `HEAD ${brief.baseHead} vs staged tree ${brief.tree}` : `HEAD ${brief.head} vs working tree`)
    : `base ${brief.baseHead}..head ${brief.head} on branch ${brief.branch}`;

  const rubric = isCrr
    ? "CRR (pre-commit sanity check): is this change competent, and are there defects or gaps the builder should fix before keeping the commit? Stay concise."
    : brief.role === "correctness"
      ? "Seat: correctness. Inspect bugs, security, data integrity, race conditions, error handling, regressions, and test coverage."
      : brief.role === "design"
        ? "Seat: design. Inspect whether this mechanism is needed, whether a simpler shape exists, authority boundaries, and maintainability."
        : "Seat: intent. Compose `intentSummary` (concise Markdown: Goal + Settled Decisions/Pivots) from USER CONTRACT below (or, when USER CONTRACT states no prompts/BRR were captured because the host lacks a prompt hook, note that limitation in `summary`, derive `intentSummary` from BUILDER TECHNICAL RATIONALE, and review against commit messages/notes without returning NO_GO for missing prompts). A single session's prompts may cover multiple branches or follow-up PRs—judge only whether THIS branch's diff matches its relevant asks and do not flag work deferred to other branches/PRs as missing. Builder Technical Rationale may explain why technical dependencies/files were touched to fulfill the ask, NEVER justify unrequested product scope when user prompts are present. Put unsettled product choices in `questions` (a question alone is not a NO_GO).";

  const files = (inventory.files || []).map((file) => `- ${file}`).join("\n") || "- none listed";
  const rulesBlock = mergeRules ? `\n\n## Repository Merge Quality Rules (merge-ready-review.md)\n${mergeRules}` : "";
  const priorBlock = priorFindings?.length
    ? `\n\n## Prior Open Findings For This Seat\nVerify whether the current diff resolves each item; any defect that remains must be listed in findings again:\n${priorFindings.map((item) => `- ${item.id}: ${item.text}`).join("\n")}`
    : "";

  const intentSections = !isCrr && brief.role === "intent"
    ? [
        "\n\n## USER CONTRACT (AUTHORITATIVE — compose `intentSummary` strictly from this)",
        userContract?.text || "No user prompts or BRR captured; treat non-obvious product assumptions as unsettled `questions`.",
        "\n\n## BUILDER TECHNICAL RATIONALE (NON-CONTRACT CONTEXT — explains file/dependency mechanics only)",
        builderRationale?.trim() || "(none provided)"
      ].join("\n")
    : "";

  const mrrGuidance = !isCrr
    ? "\n\nReview the complete changed authority boundary, not just the latest commit. Attempt to falsify the candidate; do not defer to passing tests or builder framing. `findings` are blocking defects only (bugs, broken invariants, security/data loss, unrequested scope, or an unreviewably tangled diff). Put minor non-blocking observations in `summary`. A `GO` with observations in `summary` is valid."
    : "";

  const schemaDesc = isCrr
    ? `Return ONLY one JSON object (no prose or Markdown fences) with: reviewComplete=true, independent=true, runId="${brief.id}", verdict="GO"|"NO_GO", findings (string[] — MUST be [] when verdict="GO"; put non-blocking observations in summary), summary (string), scores ({mergeReadiness, structuralRisk, implementationQuality, evidenceConfidence, outcomeConfidence}, each integer 0-100), and scoreRationale ({mergeReadiness, structuralRisk, implementationQuality, evidenceConfidence, outcomeConfidence}, each concise string).`
    : `Return ONLY one JSON object (no prose or Markdown fences) with: reviewComplete=true, independent=true, runId="${brief.id}", verdict="GO"|"NO_GO", findings (string[] — MUST be [] when verdict="GO"), unresolved (string[] — MUST be [] when verdict="GO"), questions (string[]), summary (string),${brief.role === "intent" ? ' intentSummary (string: concise Markdown playback of Goal + Key User Decisions/Pivots derived strictly from USER CONTRACT),' : ""} scores ({mergeReadiness, structuralRisk, implementationQuality, evidenceConfidence, outcomeConfidence}, each integer 0-100), scoreRationale ({mergeReadiness, structuralRisk, implementationQuality, evidenceConfidence, outcomeConfidence}, each concise string), necessity="necessary"|"questionable_roi", simplerPath (string explaining simpler alternatives or that none were found), scopeDrift="none"|"minor"|"material", contractIntegrity="sound"|"mixed"|"broken", and evidenceQuality="strong"|"mixed"|"weak".`;

  return [
    `Independently review repository checkout (${targetDesc}) as ${brief.role} using model ${brief.model}.`,
    rubric,
    `\nInspect the exact diff with this read-only command:\n${inspectCommandFor(target)}`,
    `\nChanged files (${inventory.files.length}; +${inventory.additions} -${inventory.deletions}):\n${files}`,
    "\nDo not modify files, do not run fr, and do not use MCP servers.",
    mrrGuidance,
    rulesBlock,
    priorBlock,
    intentSections,
    `\n${schemaDesc}`
  ].filter(Boolean).join("\n");
}

function defaultShellRunner(command, { cwd, env = process.env, timeoutMs = 15 * 60 * 1000 } = {}) {
  const fallbackBins = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(path.delimiter);
  const childEnv = { ...env, PATH: [env.PATH, fallbackBins].filter(Boolean).join(path.delimiter) };
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let killTimer = null;
    const terminateTree = (sig) => {
      if (child.pid) {
        try { process.kill(-child.pid, sig); return; } catch {}
      }
      try { child.kill(sig); } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree("SIGTERM");
      killTimer = setTimeout(() => {
        terminateTree("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }, 2_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: 1, stdout: "", stderr: error.message, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut
      });
    });
  });
}

// Candidates for CRR: use the first CLI-backed model configured across seats.
export function crrModelCandidates(requestedModel = null) {
  const all = ["correctness", "design", "intent"].flatMap((role) => seatFor(role).models);
  const seen = new Set();
  const unique = all.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  if (requestedModel) {
    const norm = normalizeId(requestedModel) || requestedModel;
    const matched = unique.find((entry) => entry.id === norm || entry.cliModel === requestedModel);
    if (!matched) throw new Error(`Model ${requestedModel} is not listed in ${configSource()}`);
    return [matched];
  }
  const cliEntries = unique.filter((entry) => entry.launch !== "native");
  return cliEntries.length ? cliEntries : unique;
}

export function seatModelCandidates(role, requestedModel = null) {
  const models = seatFor(role).models;
  if (!requestedModel) return models;
  const norm = normalizeId(requestedModel);
  const matched = models.find((entry) => entry.id === norm);
  if (!matched) {
    throw new Error(`${requestedModel} is not a valid ${role} model (valid: ${models.map((m) => m.id).join(", ")}). Add it to seats.${role}.models in ${configSource()}.`);
  }
  return [matched];
}

// Execute one role (CRR or an MRR seat) across its ordered candidate models.
// Falls back to the next configured model ONLY if a launcher fails to start or
// exits without producing a valid review envelope (e.g. missing CLI, auth
// failure, out of credits). Once a valid GO or NO_GO envelope is returned, it
// settles immediately — never shopping after a NO_GO.
export async function executeRoleReview({
  kind,
  role,
  target,
  inventory,
  candidates,
  seatModels = null,
  mergeRules = null,
  priorFindings = [],
  userContract = null,
  builderRationale = null,
  runShell = defaultShellRunner,
  onWarn = () => {}
}) {
  if (candidates[0]?.launch === "native") {
    const hint = kind === "crr"
      ? "use 'fr crr --brief'"
      : `use 'fr mrr --brief --seat ${role}' and 'fr mrr --record <file> --brief-id <uuid>'`;
    throw new Error(`${kind === "crr" ? "CRR" : `Seat ${role}`} defaults to native subagent launch; ${hint}`);
  }
  const cliCandidates = candidates.filter((entry) => entry.launch !== "native");
  if (!cliCandidates.length) {
    const hint = kind === "crr"
      ? "use 'fr crr --brief'"
      : `use 'fr mrr --brief --seat ${role}' and 'fr mrr --record <file> --brief-id <uuid>'`;
    throw new Error(`${kind === "crr" ? "CRR" : `Seat ${role}`} has no CLI launcher configured; ${hint}`);
  }

  const errors = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `fr-run-${role}-`));
  try {
    for (let index = 0; index < cliCandidates.length; index += 1) {
      const entry = cliCandidates[index];
      const brief = {
        id: randomUUID(),
        kind,
        role: kind === "crr" ? CRR_ROLE : role,
        branch: target.branch,
        head: target.head,
        baseHead: target.baseHead,
        ...(kind === "crr" && target.tree ? { tree: target.tree } : {}),
        model: entry.id,
        route: "cli",
        ...(seatModels ? { seatModels } : {})
      };
      const promptText = buildReviewPrompt({ brief, target, inventory, mergeRules, priorFindings, userContract, builderRationale });
      const promptFile = path.join(tempDir, `${entry.id}.prompt.txt`);
      const lastMessageFile = path.join(tempDir, `${entry.id}.last.txt`);
      await writeFile(promptFile, promptText, { mode: 0o600 });

      const command = launchCommandFor(entry, {
        cwd: target.repoRoot,
        promptFile,
        lastMessageFile,
        baseSha: target.baseHead,
        headSha: target.head,
        treeSha: target.tree || null,
        requireClean: kind === "mrr"
      });

      const result = await runShell(command, { cwd: target.repoRoot });
      let rawOutput = result.stdout;
      if (entry.launch === "codex") {
        try { rawOutput = await readFile(lastMessageFile, "utf8"); } catch {}
      }

      if (result.code === 0 && String(rawOutput || "").trim()) {
        let parsed;
        let validated;
        try {
          parsed = parseEnvelope(rawOutput);
          const normalized = normalizeReview(parsed, brief, `cli:${entry.launch}:${entry.id}:${brief.id.slice(0, 8)}`);
          validated = validateReview(normalized, brief);
        } catch (parseError) {
          // Do NOT fall back to a second model when a CLI exited 0 with malformed
          // output — a malformed NO_GO must never shop to a fallback model.
          throw new Error(`${role} model ${entry.id} (${entry.launch}) returned an invalid review envelope: ${parseError.message}`);
        }
        return { review: { ...validated, rawSource: String(rawOutput).slice(0, 100_000) }, brief, attempted: errors };
      }

      if (result.timedOut) {
        throw new Error(`${role} model ${entry.id} (${entry.launch}) timed out`);
      }

      const snippet = (result.stderr || result.stdout || `exit code ${result.code}`).trim().split("\n").slice(-3).join(" ").slice(0, 240);
      const detail = `${entry.id} (${entry.launch}) failed to run: ${snippet}`;
      errors.push(detail);
      if (index + 1 < cliCandidates.length) onWarn(`${role}: ${detail}; trying fallback ${cliCandidates[index + 1].id}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  throw new Error(`${role} review could not run on any configured model:\n- ${errors.join("\n- ")}`);
}
