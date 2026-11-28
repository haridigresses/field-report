#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findRealGh } from "./fr-gh.mjs";
import { doctor, formatDoctor } from "../src/doctor.mjs";
import { normalizeReview, parseEnvelope } from "../src/envelope.mjs";
import { removeLegacyPreCommitHook } from "../src/hooks.mjs";
import { handleHostHook, installHostHooks } from "../src/host-hooks.mjs";
import {
  assertSeatOpen,
  botsReasons,
  CRR_ROLE,
  evaluateMrrGate,
  findingLedger,
  openReasons,
  readyLabel,
  renderFieldReportMarkdown,
  REVIEW_ROLES,
  seatingFor,
  seatStatus,
  validateReview
} from "../src/policy.mjs";
import { buildUserContract } from "../src/prompts.mjs";
import {
  ancestorHeads,
  checkout,
  commitLog,
  crrTarget,
  detectRepoBrr,
  diffInventory,
  mrrTarget,
  projectForCheckout,
  pullRequest,
  readMergeRules
} from "../src/repository.mjs";
import { buildReviewPrompt, crrModelCandidates, executeRoleReview, seatModelCandidates } from "../src/runner.mjs";
import { configSource, seatConfig, seatFor } from "../src/seats.mjs";
import { startServer } from "../src/server.mjs";
import { createStore, defaultStateRoot, describePlans, describeTodos, destinationTarget, plansFor, todosFor } from "../src/store.mjs";

const exec = promisify(execFile);
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createStore();

function usage() {
  return `Field Report — independent pre-PR review gate

fr version
fr init [--host-hooks]
fr doctor
fr seats
fr project add <id> --repo <path> [--label <label>] [--github owner/repo] [--base main] [--todos github|linear|notion|ref] [--todos-reference <text>|--clear-todos-reference] [--plans repo|linear|notion|ref] [--plans-reference <text>|--clear-plans-reference]
fr project update <id> [--label <label>] [--repo <path>] [--github owner/repo] [--base main] [--todos github|linear|notion|ref] [--todos-reference <text>|--clear-todos-reference] [--plans repo|linear|notion|ref] [--plans-reference <text>|--clear-plans-reference]
fr project list
fr project remove <id>
fr crr [--model <id>] [--brief]
fr mrr [--seat correctness|design|intent] [--all] [--model <id>] [--notes <text>] [--brr <file>] [--intent-file <file>] [--session <id>] [--brief] [--record <file> --brief-id <uuid>]
fr accept <F-id> --reason <text> --actor <who>
fr status
fr gate open
fr gate bots
fr ui [--port <n>]

Reviews are keyed automatically by repository + branch + commit HEAD.
No branch registration. Field Report never merges.`;
}

function parse(values) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const name = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) flags[name] = true;
    else { flags[name] = next; index += 1; }
  }
  return { positional, flags };
}

function requireValue(value, message) {
  if (!value || value === true) throw new Error(message);
  return value;
}

function destinationFlags(flags, name) {
  for (const flag of [name, `${name}-reference`]) if (flags[flag] === true) throw new Error(`Specify --${flag} <value>`);
  const clear = flags[`clear-${name}-reference`];
  if (clear != null && clear !== true) throw new Error(`--clear-${name}-reference takes no value`);
  if (flags[name] == null && flags[`${name}-reference`] == null && !clear) return null;
  return { service: flags[name], reference: flags[`${name}-reference`], clearReference: Boolean(clear) };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function requireActiveProject() {
  const matched = await projectForCheckout(await store.projects(), process.cwd());
  if (!matched) throw new Error("No Field Report project matches this checkout (register with 'fr project add <id> --repo <path>')");
  return matched;
}

function formatScoreRow(review, currentHead = null) {
  const sha = (review.tree || review.head || "").slice(0, 12);
  const carried = currentHead && review.head && review.head !== currentHead && review.kind === "mrr" ? " (carried)" : "";
  return `  ${review.role} [${review.model}]: ${review.verdict} @ ${sha}${carried} — readiness ${review.scores.mergeReadiness}% · risk ${review.scores.structuralRisk}% · quality ${review.scores.implementationQuality}% · evidence ${review.scores.evidenceConfidence}% · outcome ${review.scores.outcomeConfidence}%`;
}

async function evaluateBranchMrr(project, target) {
  const [reviews, dispositions] = await Promise.all([
    store.reviews(project.id, target.branch),
    store.dispositions(project.id, target.branch)
  ]);
  const ancestors = await ancestorHeads(target.repoRoot, reviews.map((r) => r.head), target.head, target.baseHead);
  const gate = evaluateMrrGate({ target, reviews, dispositions, ancestors });
  return { reviews, dispositions, ancestors, gate };
}

async function persistReport(project, target, gate) {
  const markdown = renderFieldReportMarkdown({ project, branch: target.branch, target, gate });
  return store.saveReport(project.id, target.branch, markdown);
}

function printGateSummary(project, target, gate, extraReasons = []) {
  const reasons = [...gate.reasons, ...extraReasons];
  const ready = reasons.length === 0;
  const header = ready ? readyLabel(gate) : "BLOCKED";
  const lines = [`${project.id}/${target.branch} @ ${target.head.slice(0, 12)}: ${header}`];
  if (gate.intentSummary) lines.push(`Intent Playback:\n${gate.intentSummary}`);
  for (const reason of reasons) lines.push(`- ${reason}`);
  for (const note of gate.notes || []) lines.push(`- ${note}`);
  for (const role of REVIEW_ROLES) {
    const review = gate.lanes?.[role];
    if (!review) continue;
    lines.push(formatScoreRow(review, target.head));
    lines.push(`    Summary: ${review.summary}`);
  }
  return { ready, text: lines.join("\n") };
}

async function cleanRegisteredPreCommitHooks() {
  let cleaned = 0;
  for (const project of await store.projects()) {
    try {
      const hookOut = (await exec("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: project.repoPath, timeout: 5_000 })).stdout.trim();
      const res = await removeLegacyPreCommitHook(hookOut, {
        readFileFn: (f) => readFile(f, "utf8").catch(() => null),
        existsFn: (f) => access(f).then(() => true, () => false)
      });
      if (res.removed) cleaned += 1;
    } catch {}
  }
  return cleaned;
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [command, subcommand, third] = positional;

  if (!command || flags.help || command === "help") {
    console.log(usage());
    return;
  }

  if (command === "_hook") {
    const raw = await readStdin().catch(() => "");
    try {
      const res = await handleHostHook(subcommand, raw, { store });
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exitCode = res.exitCode;
    } catch (error) {
      if (subcommand === "pre-tool") {
        const msg = `Field Report hook error (failing closed): ${error.message}`;
        const isCursor = /"hook_event_name"\s*:\s*"before|"workspace_roots"/.test(raw);
        if (isCursor) process.stdout.write(`${JSON.stringify({ permission: "deny", user_message: msg, agent_message: msg })}\n`);
        else { process.stderr.write(`${msg}\n`); process.exitCode = 2; }
      } else {
        process.exitCode = 0;
      }
    }
    return;
  }

  if (command === "version") {
    const pkg = JSON.parse(await readFile(path.join(runtimeRoot, "package.json"), "utf8"));
    let revision = "unavailable";
    try { revision = (await exec("git", ["rev-parse", "--short=12", "HEAD"], { cwd: runtimeRoot, timeout: 5_000 })).stdout.trim() || "unavailable"; }
    catch {}
    console.log(`field-report ${pkg.version}\nruntime ${runtimeRoot}\nrevision ${revision}`);
    return;
  }

  if (command === "ui") {
    const port = flags.port == null ? undefined : Number(flags.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("--port must be an integer between 1 and 65535");
    startServer(port);
    return;
  }

  if (command === "init") {
    const root = await store.init();
    const cleaned = await cleanRegisteredPreCommitHooks();
    let hooksNote = "";
    const customStateOnly = Boolean(process.env.FIELD_REPORT_STATE_ROOT && !flags["host-hooks"]);
    if (!customStateOnly) {
      const home = process.env.FIELD_REPORT_HOME || os.homedir();
      const hooks = await installHostHooks({ frBin: path.join(home, ".local", "bin", "fr"), home });
      hooksNote = `\nHost hooks: ${hooks.claudeSettingsPath}, ${hooks.cursorHooksPath}`;
    }
    console.log(`Initialized Field Report state at ${root}${cleaned ? ` (removed ${cleaned} legacy pre-commit hook(s))` : ""}${hooksNote}`);
    return;
  }

  if (command === "doctor") {
    const home = process.env.FIELD_REPORT_HOME || os.homedir();
    const results = await doctor({ runtimeRoot, stateRoot: defaultStateRoot(), home, loadConfig: seatConfig });
    console.log(formatDoctor(results));
    if (results.some((item) => item.level === "fail")) process.exitCode = 1;
    return;
  }

  if (command === "seats") {
    const config = seatConfig();
    console.log(`Config: ${configSource()}`);
    for (const role of REVIEW_ROLES) {
      const models = config.seats[role].models.map((entry, idx) => `${entry.id} (${entry.launch}${entry.cliModel !== entry.id ? `:${entry.cliModel}` : ""}${idx === 0 ? ", default" : ""})`).join(" -> ");
      console.log(`${role}: ${models}`);
    }
    return;
  }

  if (command === "project" && subcommand === "add") {
    const projectId = requireValue(third, "Specify project <id>");
    const repoPath = requireValue(flags.repo, "Specify --repo <path>");
    const project = await store.saveProject({
      id: projectId,
      label: flags.label === true ? null : flags.label || projectId,
      repoPath,
      githubRepo: flags.github === true ? null : flags.github,
      baseBranch: flags.base === true ? null : flags.base,
      todos: destinationFlags(flags, "todos"),
      plans: destinationFlags(flags, "plans")
    });
    console.log(JSON.stringify(project, null, 2));
    return;
  }

  if (command === "project" && subcommand === "update") {
    const projectId = requireValue(third, "Specify project <id>");
    const project = await store.updateProject(projectId, {
      label: flags.label === true ? undefined : flags.label,
      repoPath: flags.repo === true ? undefined : flags.repo,
      githubRepo: flags.github === true ? undefined : flags.github,
      baseBranch: flags.base === true ? undefined : flags.base,
      todos: destinationFlags(flags, "todos"),
      plans: destinationFlags(flags, "plans")
    });
    console.log(JSON.stringify(project, null, 2));
    return;
  }

  if (command === "project" && subcommand === "list") {
    for (const item of await store.projects()) {
      console.log(`${item.id}\t${item.label}\t${item.repoPath}\t${item.githubRepo || "-"}\tbase:${item.baseBranch}\ttodos:${destinationTarget(item.todos)}\tplans:${destinationTarget(item.plans)}`);
    }
    return;
  }

  if (command === "project" && subcommand === "remove") {
    const projectId = requireValue(third, "Specify project <id>");
    const removed = await store.removeProject(projectId);
    console.log(`Removed project ${removed.project}${removed.branches.length ? ` and ${removed.branches.length} branch review record(s)` : ""}.`);
    return;
  }

  if (command === "crr") {
    const project = await requireActiveProject();
    const target = await crrTarget(project, process.cwd());
    const [inventory, mergeRules] = await Promise.all([diffInventory(target), readMergeRules(target.repoRoot)]);

    if (flags.brief) {
      const seated = seatingFor(CRR_ROLE, flags.model === true ? null : flags.model || "local", "native");
      const brief = {
        id: randomUUID(),
        kind: "crr",
        role: CRR_ROLE,
        branch: target.branch,
        head: target.head,
        baseHead: target.baseHead,
        ...(target.tree ? { tree: target.tree } : {}),
        model: seated.model,
        route: "native"
      };
      console.log(JSON.stringify({ brief, prompt: buildReviewPrompt({ brief, target, inventory, mergeRules }) }, null, 2));
      return;
    }

    const candidates = crrModelCandidates(flags.model === true ? null : flags.model);
    const { review } = await executeRoleReview({
      kind: "crr",
      role: CRR_ROLE,
      target,
      inventory,
      candidates,
      mergeRules,
      onWarn: (msg) => console.error(`WARN ${msg}`)
    });
    console.log(`CRR (${review.model}): ${review.verdict}`);
    console.log(formatScoreRow(review));
    console.log(`  Summary: ${review.summary}`);
    for (const finding of review.findings) console.log(`  - ${finding}`);
    if (review.verdict !== "GO") process.exitCode = 1;
    return;
  }

  if (command === "mrr") {
    const project = await requireActiveProject();
    const state = await checkout(process.cwd());
    if (state.dirty) {
      throw new Error("Working tree has uncommitted changes; commit or stash before running MRR");
    }
    const target = await mrrTarget(project, process.cwd());

    // Native escape hatch: allowed ONLY when the seat's config explicitly lists a launch="native" model.
    if (flags.record) {
      const file = requireValue(flags.record, "Specify --record <review.json>");
      const briefId = requireValue(flags["brief-id"], "Specify --brief-id <uuid>");
      const savedBriefs = await store.briefs(project.id, target.branch);
      const brief = savedBriefs.find((item) => item.id === briefId);
      if (!brief) throw new Error(`Unknown brief ID ${briefId} on ${project.id}/${target.branch}`);
      if (!seatFor(brief.role).models.some((m) => m.launch === "native" && m.id === brief.model)) {
        throw new Error(`Seat ${brief.role} model ${brief.model} is not configured with launch="native" in ${configSource()}`);
      }
      const rawText = await readFile(file, "utf8");
      const parsed = parseEnvelope(rawText);
      const normalized = normalizeReview(parsed, brief, `native:${brief.model}:${brief.id.slice(0, 8)}`);
      const validated = validateReview(normalized, brief);
      await store.addReview(project.id, target.branch, { ...validated, rawSource: rawText.slice(0, 100_000) }, {
        beforeAppend: (prior) => assertSeatOpen(prior, { role: brief.role, target: brief })
      });
      const afterState = await checkout(process.cwd());
      const current = await evaluateBranchMrr(project, target);
      const reportFile = await persistReport(project, target, current.gate);
      const summary = printGateSummary(project, target, current.gate, openReasons({ checkout: afterState, target }));
      console.log(`${summary.text}\nField Report saved: ${reportFile}`);
      if (!summary.ready) process.exitCode = 1;
      return;
    }

    const [inventory, mergeRules, logText, existing] = await Promise.all([
      diffInventory(target),
      readMergeRules(target.repoRoot),
      commitLog(target.repoRoot, target.baseHead, target.head),
      evaluateBranchMrr(project, target)
    ]);

    let brr = null;
    if (flags.brr && flags.brr !== true) {
      brr = { source: flags.brr, text: await readFile(path.resolve(flags.brr), "utf8") };
    } else {
      brr = await detectRepoBrr(target.repoRoot, target.baseHead, inventory.files);
    }
    const intentFileText = flags["intent-file"] && flags["intent-file"] !== true
      ? await readFile(path.resolve(flags["intent-file"]), "utf8")
      : null;
    const userContract = await buildUserContract({
      store,
      project,
      sessionId: flags.session === true ? null : flags.session,
      brr,
      intentFileText
    });
    const notesText = flags.notes && flags.notes !== true ? String(flags.notes).trim() : "";
    const builderRationale = [
      logText ? `Commit log (${target.baseHead.slice(0, 12)}..${target.head.slice(0, 12)}):\n${logText}` : "",
      notesText ? `Builder notes:\n${notesText}` : ""
    ].filter(Boolean).join("\n\n");

    const requestedSeat = flags.seat === true ? null : flags.seat;
    if (requestedSeat && !REVIEW_ROLES.includes(requestedSeat)) {
      throw new Error(`Unknown seat '${requestedSeat}'; seats are ${REVIEW_ROLES.join(", ")}`);
    }

    // Native brief generation mode (--brief --seat <role>): requires launch="native" in config.
    if (flags.brief) {
      const role = requireValue(requestedSeat, "Specify --seat <correctness|design|intent> with --brief");
      assertSeatOpen(existing.reviews, { role, target });
      const nativeModels = seatFor(role).models.filter((m) => m.launch === "native");
      if (!nativeModels.length) {
        throw new Error(`Seat ${role} has no model with launch="native" in ${configSource()}; run 'fr mrr' directly instead of --brief`);
      }
      const chosenModel = flags.model && flags.model !== true ? flags.model : nativeModels[0].id;
      const seated = seatingFor(role, chosenModel, "native");
      if (!nativeModels.some((m) => m.id === seated.model)) {
        throw new Error(`Model ${seated.model} in seats.${role} does not use launch="native"`);
      }
      const priorFindings = existing.gate.seats?.[role]?.open || [];
      const brief = await store.addBrief(project.id, target.branch, {
        id: randomUUID(),
        kind: "mrr",
        role,
        branch: target.branch,
        head: target.head,
        baseHead: target.baseHead,
        model: seated.model,
        seatModels: seated.seatModels,
        route: "native"
      });
      const prompt = buildReviewPrompt({ brief, target, inventory, mergeRules, priorFindings, userContract, builderRationale });
      console.log(JSON.stringify({ brief, prompt }, null, 2));
      return;
    }

    // Determine which seats need to run:
    // - `--seat <role>`: run that specific seat (must not already be recorded on this exact HEAD).
    // - `--all`: run every seat not yet recorded on this exact HEAD (for user-requested final MRR).
    // - default (`fr mrr`): run only seats whose status is `missing` or `blocked` (convergent!).
    let rolesToRun;
    if (requestedSeat) {
      assertSeatOpen(existing.reviews, { role: requestedSeat, target });
      rolesToRun = [requestedSeat];
    } else if (flags.all) {
      rolesToRun = REVIEW_ROLES.filter((role) => !existing.reviews.some((r) => r.kind === "mrr" && r.role === role && r.head === target.head));
    } else {
      rolesToRun = REVIEW_ROLES.filter((role) => existing.gate.seats[role].state !== "satisfied" && !existing.reviews.some((r) => r.kind === "mrr" && r.role === role && r.head === target.head));
      if (!rolesToRun.length && !existing.gate.ready) {
        const blockedRole = REVIEW_ROLES.find((role) => existing.gate.seats[role].state === "blocked");
        if (blockedRole) assertSeatOpen(existing.reviews, { role: blockedRole, target });
      }
    }

    const failures = [];
    if (rolesToRun.length) {
      const requestedModel = flags.model === true ? null : flags.model;
      if (requestedModel && rolesToRun.length > 1) {
        throw new Error("Specify --seat <role> when passing --model <id>");
      }

      const outcomes = await Promise.allSettled(rolesToRun.map(async (role) => {
        const candidates = seatModelCandidates(role, requestedModel);
        const seatModels = seatFor(role).models.map((m) => m.id);
        const priorFindings = existing.gate.seats?.[role]?.open || [];
        return executeRoleReview({
          kind: "mrr",
          role,
          target,
          inventory,
          candidates,
          seatModels,
          mergeRules,
          priorFindings,
          userContract: role === "intent" ? userContract : null,
          builderRationale: role === "intent" ? builderRationale : null,
          onWarn: (msg) => console.error(`WARN ${msg}`)
        });
      }));

      for (let i = 0; i < rolesToRun.length; i += 1) {
        const outcome = outcomes[i];
        if (outcome.status === "rejected") {
          failures.push(outcome.reason?.message || String(outcome.reason));
          continue;
        }
        const { review } = outcome.value;
        await store.addReview(project.id, target.branch, review, {
          beforeAppend: (prior) => assertSeatOpen(prior, { role: review.role, target })
        });
      }
    }

    const afterState = await checkout(process.cwd());
    const updated = await evaluateBranchMrr(project, target);
    const reportFile = await persistReport(project, target, updated.gate);
    if (failures.length) {
      throw new Error(failures.join("\n"));
    }
    const summary = printGateSummary(project, target, updated.gate, openReasons({ checkout: afterState, target }));
    console.log(`${summary.text}\nField Report saved: ${reportFile}`);
    if (!summary.ready) process.exitCode = 1;
    return;
  }

  if (command === "accept") {
    const findingId = requireValue(subcommand, "Usage: fr accept <F-id> --reason <text> --actor <who>").toUpperCase();
    const reason = requireValue(flags.reason, "Specify --reason <the user's explicit acceptance reason>");
    const actor = requireValue(flags.actor, "Specify --actor <the human who accepted the finding>");
    const project = await requireActiveProject();
    const state = await checkout(process.cwd());
    if (state.branch === "HEAD" || state.branch === (project.baseBranch || "main")) {
      throw new Error(`Run 'fr accept' on the feature branch (currently on ${state.branch})`);
    }
    const reviews = await store.reviews(project.id, state.branch);
    const ledger = findingLedger(reviews);
    const validFindingIds = new Set(ledger.map((item) => item.id));
    await store.addDisposition(project.id, state.branch, { findingId, reason, actor }, { validFindingIds });

    const target = await mrrTarget(project, process.cwd());
    const updated = await evaluateBranchMrr(project, target);
    await persistReport(project, target, updated.gate);
    console.log(printGateSummary(project, target, updated.gate, openReasons({ checkout: state, target })).text);
    return;
  }

  if (command === "status") {
    const project = await requireActiveProject();
    const state = await checkout(process.cwd());
    console.log(`Project: ${project.id} (${project.label}) · base: ${project.baseBranch || "main"}`);
    console.log(`Branch: ${state.branch} @ ${state.head.slice(0, 12)}${state.dirty ? " (dirty)" : ""}`);
    console.log(`Todos: ${describeTodos(todosFor(project), project)}`);
    console.log(`Plans: ${describePlans(plansFor(project))}`);

    if (state.branch === "HEAD" || state.branch === (project.baseBranch || "main")) {
      console.log(`MRR: on ${state.branch} (switch to a feature branch to run MRR)`);
      return;
    }
    let target;
    try { target = await mrrTarget(project, process.cwd()); }
    catch (error) { console.log(`MRR: ${error.message}`); return; }

    const { gate } = await evaluateBranchMrr(project, target);
    console.log(printGateSummary(project, target, gate, openReasons({ checkout: state, target })).text);
    return;
  }

  if (command === "gate" && subcommand === "open") {
    const project = await requireActiveProject();
    const state = await checkout(process.cwd());
    const target = await mrrTarget(project, process.cwd());
    const { gate } = await evaluateBranchMrr(project, target);
    const summary = printGateSummary(project, target, gate, openReasons({ checkout: state, target }));
    console.log(summary.text);
    if (!summary.ready) process.exitCode = 1;
    return;
  }

  if (command === "gate" && subcommand === "bots") {
    const project = await requireActiveProject();
    const state = await checkout(process.cwd());
    const target = await mrrTarget(project, process.cwd());
    const { gate } = await evaluateBranchMrr(project, target);

    const realGh = findRealGh({ envPath: process.env.PATH, selfPath: path.join(os.homedir(), ".local", "bin", "gh") }) || "gh";
    let pr = null;
    let githubError = null;
    try { pr = await pullRequest(project, target.branch, process.cwd(), { ghBin: realGh }); }
    catch (error) { githubError = error.message; }

    const ciReasons = githubError
      ? [`GitHub lookup failed: ${githubError}`]
      : botsReasons({ project, target, checkout: state, pr });
    const allReasons = [...gate.reasons, ...ciReasons];
    const ready = allReasons.length === 0;
    console.log(`${project.id}/${target.branch} bots gate @ ${target.head.slice(0, 12)}: ${ready ? "READY" : "BLOCKED"}`);
    for (const reason of allReasons) console.log(`- ${reason}`);
    for (const note of gate.notes || []) console.log(`- ${note}`);
    if (!ready) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${positional.join(" ")}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
