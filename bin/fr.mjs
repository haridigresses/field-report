#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEnvelope, normalizeReview } from "../src/envelope.mjs";
import { createStore, defaultStateRoot, describePlans, describeTodos, destinationTarget, plansFor, todosFor } from "../src/store.mjs";
import { assertSeatOpen, botsReasons, CRR_ROLE, evaluateGate, findingLedger, identityKey, latestClaimReviews, openReasons, reviewKind, REVIEW_ROLES, seatingFor, seatStatus, validateReview, workstreamBotsReasons } from "../src/policy.mjs";
import { ancestorHeads, checkout, crrTarget, diffInventory, mrrTarget, pullRequest } from "../src/repository.mjs";
import { hookManagerPath, hookState, hookText, isManagedHook, quote, shouldRunPreserved } from "../src/hooks.mjs";
import { claudeInvokeCommand, codexInvokeCommand, cursorReviewCommand, HOST_LAUNCHERS } from "../src/machines.mjs";
import { configSource, launchEntry, REVIEW_ROLES as SEATS, seatConfig, seatFor } from "../src/seats.mjs";
import { doctor, formatDoctor } from "../src/doctor.mjs";

const exec = promisify(execFile);
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createStore();
const REVIEW_EXECUTION = Object.freeze({ conversationInheritance: "none", mcp: "none" });

function launchFor(seated, { cwd, promptFile = "<prompt>", baseSha, headSha } = {}) {
  if (seated.role === CRR_ROLE && seated.route === "native") {
    return `Launch a fresh ${seated.model} subagent with conversationInheritance=none and no MCP servers. Prefer a local model; use cloud only if local cannot produce an envelope. Do not pass the owner conversation.`;
  }
  if (seated.route === "native") return `Launch a fresh native ${seated.model} subagent with conversationInheritance=none and no MCP servers; do not pass the owner conversation.`;
  // The config's cliModel decides the exact launch id.
  const model = seated.requested || seated.model;
  const launch = launchEntry(model)?.launch;
  if (!launch) throw new Error(`${seated.model} has no launcher in ${configSource()}. List it in a seat's models there, or use --route native.`);
  if (launch === "codex") return codexInvokeCommand({ promptFile, cwd: cwd || "<repo>", kind: "review", model });
  if (launch === "claude") return claudeInvokeCommand({ promptFile, cwd: cwd || "<repo>", baseSha: baseSha || "BASE_SHA", headSha: headSha || "HEAD_SHA", model });
  return cursorReviewCommand({ promptFile, model });
}

function usage() {
  return `Field Report control loop

fr version
fr ui [--port <n>]
fr init
fr doctor
fr project add <id> --label <label> --repo <path> [--github owner/repo] [--base main] [--todos github|linear|notion|ref] [--todos-reference <text>|--clear-todos-reference] [--plans repo|linear|notion|ref] [--plans-reference <text>|--clear-plans-reference]
fr project update <id> [--label <label>] [--repo <path>] [--github owner/repo] [--base main] [--todos github|linear|notion|ref] [--todos-reference <text>|--clear-todos-reference] [--plans repo|linear|notion|ref] [--plans-reference <text>|--clear-plans-reference]
fr project list
fr project remove <id> [--with-workstreams]
fr identity --role coordinator|owner
fr create <id> --project <id> --title <title> --outcome <text> [--branch <branch>] [--owner-task <id>]
fr list [--project <id>]
fr show <id> [--json]
fr context [id]
fr update <id> [--status planned|active|blocked|complete] [--summary <text>] [--claim <text>] [--next <text>] [--branch <branch>] [--owner-task <id>] [--prs 1,2]
fr review brief <id> --kind crr|mrr --role crr|correctness|design|intent [--model <id>] [--route native|cli]
fr review bind <id> --delegation <uuid> --task-id <native-task-or-provider-run-id>
fr review record <id> --file <review.json> [--delegation <uuid>]
fr review accept <id> --finding <F-id> --reason <text> --actor <who>
fr decide <id> <decision text>
fr review status <id> --kind crr|mrr
fr gate checkout [id]
fr gate crr [id]
fr gate open [id]
fr gate bots <id>
fr hook install|status|uninstall <project-id>
fr seats
fr machines invoke codex|claude --prompt-file <path> [--cwd <path>] [--kind review|work] [--base <sha>] [--head <sha>] [--model <id>]
fr workflow [shared|coordinator|workstream|reviewer]

Field Report binds a delivery unit and records review evidence. It does not launch reviewers, open pull requests, or merge. Config (fr seats) chooses the model for each MRR seat. Cursor Cloud Agents reach the host codex and claude CLIs through My Machines when a worker for that checkout is online.`;
}

// --todos/--plans pick a service; --<name>-reference says where in it.
function destinationFlags(flags, name) {
  for (const flag of [name, `${name}-reference`]) if (flags[flag] === true) throw new Error(`Specify --${flag} <value>`);
  const clear = flags[`clear-${name}-reference`];
  if (clear != null && clear !== true) throw new Error(`--clear-${name}-reference takes no value`);
  if (flags[name] == null && flags[`${name}-reference`] == null && !clear) return null;
  return { service: flags[name], reference: flags[`${name}-reference`], clearReference: Boolean(clear) };
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

function requireValue(value, message) { if (!value) throw new Error(message); return value; }

async function gitCommon(cwd) {
  try { return (await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: 10_000 })).stdout.trim(); }
  catch { return null; }
}

async function projectForCheckout() {
  const current = await gitCommon(process.cwd());
  if (!current) throw new Error("Current directory is not a configured Git checkout");
  for (const project of await store.projects()) if (await gitCommon(project.repoPath) === current) return project;
  throw new Error("No Field Report project matches this checkout");
}

async function streamForCheckout(explicit = null) {
  const [project, state] = await Promise.all([projectForCheckout(), checkout()]);
  if (explicit) {
    const stream = await store.workstream(explicit);
    if (stream.project !== project.id || stream.branch !== state.branch) {
      throw new Error(`${stream.id} is not bound to this checkout (${project.id}/${state.branch})`);
    }
    return stream;
  }
  const streams = await store.workstreams();
  const matches = streams.filter((stream) => stream.project === project.id && stream.branch === state.branch);
  if (matches.length !== 1) {
    if (matches.length) throw new Error(`Multiple workstreams match ${state.branch}; keep one branch binding and move the others with fr update <id> --branch <branch>`);
    const owner = process.env.CODEX_THREAD_ID || "<your-task-id>";
    throw new Error(`No workstream matches ${project.id}/${state.branch}. Self-register without coordinator approval: fr create ${quote("<id>")} --project ${project.id} --title ${quote("<title>")} --outcome ${quote("<outcome>")} --branch ${quote(state.branch)} --owner-task ${quote(owner)}. To self-bind an existing outcome: fr update ${quote("<id>")} --branch ${quote(state.branch)} --owner-task ${quote(owner)}`);
  }
  return matches[0];
}

async function targetFor(stream, kind) {
  const project = await store.project(stream.project);
  const expected = reviewKind(kind);
  if (expected === "crr") return crrTarget(project, stream);
  if (expected === "mrr") return mrrTarget(project, stream);
  throw new Error("Review kind must be crr or mrr");
}

function inspectCommand(delegation) {
  return `git diff --no-ext-diff --no-textconv ${delegation.baseHead} ${delegation.tree || delegation.head} --`;
}

function inspection(delegation, inventory) {
  return { command: inspectCommand(delegation), files: inventory.files, additions: inventory.additions, deletions: inventory.deletions };
}

function reviewPrompt(stream, delegation, inventory) {
  const kind = reviewKind(delegation.kind);
  const target = kind === "crr"
    ? `base HEAD ${delegation.baseHead} and staged tree ${delegation.tree}`
    : `base ${delegation.baseHead} and exact MRR head ${delegation.head}`;
  const rubric = kind === "crr"
    ? "CRR: is this commit competent, and are there any gaps the owner should fix before keeping it? Stay short."
    : delegation.role === "correctness"
      ? "Inspect correctness, security, data integrity, error paths, regressions, and test adequacy."
      : delegation.role === "design"
        ? "Inspect how the change is built: necessity, simplicity, authority boundaries, maintainability, and whether you would select the mechanism from scratch."
        : "Inspect what the change does: whether it does what the stated outcome, claim, and user decisions ask, and only that. Look for assumptions about requirements they do not state, scope drift beyond the claim, and behavior a user would not expect. Return unsettled product choices as questions, not findings.";
  const decisions = (stream.decisions || []).length
    ? `\n\nUser decisions. These are settled product choices; do not re-litigate them:\n${stream.decisions.map((text) => `- ${text}`).join("\n")}`
    : "";
  const prior = delegation.prior?.length
    ? `\n\nThis seat's open findings from an earlier head. Verify whether the current target addresses each; any that remain are findings again:\n${delegation.prior.map((finding) => `- ${finding.id}: ${finding.text}`).join("\n")}`
    : "";
  const files = (inventory.files || []).map((file) => `- ${file}`).join("\n") || "- none listed";
  const envelope = kind === "crr"
    ? `Return only one JSON object containing: reviewComplete=true, independent=true, delegationId=${delegation.id}, verdict=GO|NO_GO, findings as a string array, summary, scores {mergeReadiness, structuralRisk, implementationQuality, evidenceConfidence, outcomeConfidence}, each an integer 0-100, and scoreRationale with one concise string for each score. No prose or Markdown fences.`
    : `Return only one JSON object containing: reviewComplete=true, independent=true, delegationId=${delegation.id}, verdict=GO|NO_GO, findings as a string array, unresolved as a string array, questions as a string array, summary, scores {mergeReadiness, structuralRisk, implementationQuality, evidenceConfidence, outcomeConfidence}, each an integer 0-100, scoreRationale with one concise string for each score, necessity=necessary|questionable_roi, simplerPath explaining considered alternatives or that none were found, scopeDrift=none|minor|material, contractIntegrity=sound|mixed|broken, and evidenceQuality=strong|mixed|weak. No prose or Markdown fences.`;
  const mrr = kind === "mrr"
    ? " Review the complete changed authority boundary and judge the accumulated mechanism, not only the latest repair. Do not defer to the owner's framing, passing tests, or other reviewers. Findings are defects in the candidate that should block it: bugs, broken invariants, security or data problems, or a candidate too broad to assess. Weigh likelihood and blast radius; an unlikely edge case that fails safely belongs in the summary, not findings. If accepting the change depends on a product choice the user has not settled and the user decisions above do not cover, put it in questions as a plain question for the user; a question alone is not a NO_GO, and you must not pick the answer."
    : "";
  return `Independently review Field Report workstream ${stream.id} as ${delegation.role} using model ${delegation.model}. Target ${target}. Stated outcome: ${stream.outcome}. Current claim JSON string: ${JSON.stringify(delegation.claim)}\n${rubric}\n\nInspect the exact target with this read-only command:\n${inspectCommand(delegation)}\n\nChanged files (${inventory.files.length}; +${inventory.additions} −${inventory.deletions}):\n${files}\n\nDo not run fr, owner skills, or MCP servers. Inspect repository files and the inspect command only. Do not inherit or request the owner's conversation. A fresh subagent is independent even when it uses the builder's model. Return only the substantive JSON envelope below and echo delegationId. Target and routing identity are supplied by this brief and the task binding when recording; do not duplicate them.\n\nThe claim describes the intended outcome; it does not limit review scope.${mrr} Put deferred scope, optional improvements, and other nonblocking observations in the summary, not findings. A GO with observations is valid. Do not modify the candidate.${decisions}${prior}\n\n${envelope}`;
}

async function gateFor(stream, kind) {
  const project = await store.project(stream.project);
  const target = await targetFor(stream, kind);
  const [reviews, dispositions] = await Promise.all([store.reviews(stream.id), store.dispositions(stream.id)]);
  const ancestors = reviewKind(kind) === "mrr" ? await ancestorHeads(target.repoRoot, reviews.map((review) => review.head), target.head) : null;
  const gate = evaluateGate({ kind, target, workstream: stream, reviews, dispositions, ancestors });
  return { project, target, gate, reviews, dispositions, ancestors };
}

function evidenceLines(gate) {
  return Object.values(gate.lanes).filter(Boolean).flatMap((review) => {
    const lines = [
      `${review.role}: ${review.verdict} by ${review.reviewerTaskId}`,
      `  Scores: readiness ${review.scores?.mergeReadiness}% · structural risk ${review.scores?.structuralRisk}% · implementation quality ${review.scores?.implementationQuality}% · evidence confidence ${review.scores?.evidenceConfidence}% · outcome confidence ${review.scores?.outcomeConfidence}%`,
      `  Summary: ${review.summary}`
    ];
    if (review.necessity) lines.splice(2, 0, `  Signals: necessity ${review.necessity} · scope drift ${review.scopeDrift} · contract integrity ${review.contractIntegrity} · evidence quality ${review.evidenceQuality}`, `  Simpler path: ${review.simplerPath}`);
    if (review.findings?.length) lines.push(`  Findings: ${review.findings.join(" | ")}`);
    if (review.unresolved?.length) lines.push(`  Unresolved: ${review.unresolved.join(" | ")}`);
    if (review.questions?.length) lines.push(`  Questions for the user: ${review.questions.join(" | ")}`);
    return lines;
  });
}

function scoreLine(review, currentHead) {
  const at = (review.tree || review.head || "").slice(0, 12);
  const stale = currentHead && review.head && review.head !== currentHead && reviewKind(review.kind) === "mrr" ? " (not this HEAD)" : "";
  return `  ${review.role}: ${review.verdict} @ ${at}${stale} — readiness ${review.scores?.mergeReadiness}% · structural risk ${review.scores?.structuralRisk}% · quality ${review.scores?.implementationQuality}% · evidence ${review.scores?.evidenceConfidence}% · outcome ${review.scores?.outcomeConfidence}%`;
}

function scoreLines(reviews, workstream, currentHead) {
  const latest = Object.values(latestClaimReviews(reviews, workstream)).filter(Boolean);
  if (!latest.length) return ["Scores: none recorded on this claim"];
  return ["Scores (latest per seat on this claim; structural risk is higher = more risk):", ...latest.map((review) => scoreLine(review, currentHead))];
}

// Agents act on the first word, so a READY that rests on carried reviews must say so there.
function readyLabel(gate) {
  if (!gate.ready) return "BLOCKED";
  const carried = Object.values(gate.seats || {}).filter((seat) => seat.carried).map((seat) => seat.role);
  return carried.length ? `READY (carried; not reviewed on this HEAD by: ${carried.join(", ")})` : "READY on this HEAD";
}

function printMrr(gate) {
  if (gate.ready) return [readyLabel(gate), ...gate.notes].join("; ");
  return `BLOCKED — ${gate.reasons.join("; ")}`;
}

function printGate(stream, result, includeEvidence = false) {
  const { gate, target } = result;
  const label = target.tree || target.head;
  const lines = [`${stream.id} ${gate.kind} gate at ${label.slice(0, 12)}: ${gate.ready ? "READY" : "BLOCKED"}`];
  if (gate.reasons.length) lines.push(...gate.reasons.map((reason) => `- ${reason}`));
  if (gate.notes?.length) lines.push(...gate.notes.map((note) => `- ${note}`));
  if (includeEvidence) lines.push(...evidenceLines(gate));
  return lines.join("\n");
}

async function openGate(stream) {
  const result = await gateFor(stream, "mrr");
  const state = await checkout();
  const reasons = [...result.gate.reasons, ...openReasons({ checkout: state, target: result.target })];
  return { ...result, reasons, ready: reasons.length === 0 };
}

async function botsGate(stream) {
  const result = await gateFor(stream, "mrr");
  const state = await checkout();
  let pr = null;
  let githubError = null;
  try { pr = await pullRequest(result.project, stream); }
  catch (error) { githubError = error.message; }
  const ci = githubError ? [`GitHub lookup failed: ${githubError}`] : botsReasons({ project: result.project, target: result.target, checkout: state, pr });
  const reasons = [
    ...result.gate.reasons,
    ...ci,
    ...workstreamBotsReasons({ workstream: stream, workstreams: await store.workstreams(), pr })
  ];
  return { ...result, pr, githubError, reasons, ready: reasons.length === 0 };
}

async function main() {
  const command = process.argv[2] || "help";
  const { positional, flags } = parse(process.argv.slice(3));
  if (["help", "--help", "-h"].includes(command)) return process.stdout.write(`${usage()}\n`);
  if (command === "ui") {
    const port = flags.port == null ? Number(process.env.PORT || 4177) : typeof flags.port === "string" ? Number(flags.port) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Specify --port <1-65535>");
    const { startServer } = await import("../src/server.mjs");
    startServer(port);
    return;
  }
  if (command === "version") {
    const { version } = JSON.parse(await readFile(path.join(runtimeRoot, "package.json"), "utf8"));
    let revision = "unavailable (runtime has no Git revision)";
    try { revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: runtimeRoot, timeout: 10_000 })).stdout.trim(); } catch {}
    return process.stdout.write(`Field Report ${version}\nRuntime source: ${runtimeRoot}\nGit revision: ${revision}\n`);
  }
  if (command === "doctor") {
    const results = await doctor({ runtimeRoot, stateRoot: path.resolve(defaultStateRoot()), loadConfig: seatConfig });
    process.stdout.write(`${formatDoctor(results)}\n`);
    if (results.some((item) => item.level === "fail")) process.exitCode = 1;
    return;
  }
  if (command === "init") { const root = await store.init(); return process.stdout.write(`Initialized Field Report state at ${root}\n`); }

  if (command === "project" && positional[0] === "add") {
    const record = await store.saveProject({ id: positional[1], label: flags.label, repoPath: flags.repo, githubRepo: flags.github, baseBranch: flags.base, todos: destinationFlags(flags, "todos"), plans: destinationFlags(flags, "plans") });
    return process.stdout.write(`Saved project ${record.id}. Install its checkout hook explicitly with: fr hook install ${record.id}\n`);
  }
  if (command === "project" && positional[0] === "update") {
    const record = await store.updateProject(positional[1], { label: flags.label, repoPath: flags.repo, githubRepo: flags.github, baseBranch: flags.base, todos: destinationFlags(flags, "todos"), plans: destinationFlags(flags, "plans") });
    return process.stdout.write(`Updated project ${record.id}.\n`);
  }
  if (command === "project" && positional[0] === "remove") {
    const removed = await store.removeProject(requireValue(positional[1], "Specify a project ID"), { withWorkstreams: flags["with-workstreams"] === true });
    return process.stdout.write(`Removed project ${removed.project}${removed.workstreams.length ? ` and its workstreams: ${removed.workstreams.join(", ")}` : ""}.\n`);
  }
  if (command === "project" && positional[0] === "list") return process.stdout.write(`${(await store.projects()).map((project) => `${project.id}\t${project.baseBranch}\t${project.repoPath}\ttodos:${destinationTarget(todosFor(project))}\tplans:${destinationTarget(plansFor(project))}`).join("\n")}\n`);

  if (command === "identity") {
    const role = requireValue(flags.role, "Specify --role coordinator|owner");
    const project = await projectForCheckout();
    const identity = identityKey(project.id, role);
    return process.stdout.write(`${JSON.stringify({
      project: project.id,
      role,
      ...identity,
      todos: describeTodos(todosFor(project), project),
      plans: describePlans(plansFor(project)),
      instruction: "Use key as this session's title where the host lets you set one, so the user can find it; if another open session already has that title, use fallback. It is a label only; nothing looks sessions up by it. Do not ask the user to name you. Reviewers do not take a title."
    }, null, 2)}\n`);
  }

  if (command === "create") {
    const record = await store.saveWorkstream({ id: positional[0], project: flags.project, title: flags.title, outcome: flags.outcome, summary: flags.outcome, branch: flags.branch, ownerTaskId: flags["owner-task"] }, { type: "created", text: `Created outcome: ${flags.outcome}`, actor: process.env.CODEX_THREAD_ID });
    return process.stdout.write(`Created ${record.id}.\n`);
  }
  if (command === "list") {
    const streams = (await store.workstreams()).filter((stream) => !flags.project || stream.project === flags.project);
    return process.stdout.write(`${streams.map((stream) => `${stream.id}\t${stream.status}\t${stream.title}`).join("\n")}\n`);
  }
  if (command === "show") {
    const stream = await store.workstream(requireValue(positional[0], "Specify a workstream ID"));
    if (flags.json) return process.stdout.write(`${JSON.stringify({ ...stream, reviews: await store.reviews(stream.id), delegations: await store.delegations(stream.id) }, null, 2)}\n`);
    return process.stdout.write(`${stream.id}\n${stream.title}\nStatus: ${stream.status}\nClaim: ${stream.claim}\n${stream.summary}\nNext: ${stream.next || "not recorded"}\nBranch: ${stream.branch || "not assigned"}\n`);
  }
  if (command === "context") {
    const stream = await streamForCheckout(positional[0]);
    const project = await store.project(stream.project);
    const state = await checkout();
    const identity = identityKey(project.id, stream.ownerTaskId ? "owner" : "coordinator");
    let mrr;
    try { mrr = await gateFor(stream, "mrr"); } catch (error) { mrr = { gate: { ready: false, notes: [], reasons: [error.message] } }; }
    const reviews = await store.reviews(stream.id);
    return process.stdout.write(`Repository: ${project.label} (${project.id})\nCheckout: ${state.branch} @ ${state.head.slice(0, 12)}${state.dirty ? " · dirty" : ""}\nWorkstream: ${stream.id} — ${stream.title}\nStatus: ${stream.status}\nClaim: ${stream.claim}\nNext: ${stream.next || "not recorded"}\nTodos: ${describeTodos(todosFor(project), project)}\nPlans: ${describePlans(plansFor(project))}\nSession title: ${identity.key} (fallback ${identity.fallback})\nMRR: ${printMrr(mrr.gate)}\n${(stream.decisions || []).length ? `Decisions: ${stream.decisions.join(" | ")}\n` : ""}${scoreLines(reviews, stream, state.head).join("\n")}\nReviews never require permission. Do not auto-open a pull request. After pre-open MRR is READY, you may open one or leave that to the user. Do not commission MRR because HEAD moved; earlier seat reviews carry forward, and the user asks for final MRR. Product and domain questions go to the user; do not infer them from schema or code.\n`);
  }
  if (command === "update") {
    const stream = await store.workstream(requireValue(positional[0], "Specify a workstream ID"));
    if (flags.next === true) throw new Error("Specify --next <text>");
    const pullRequests = flags.prs ? flags.prs.split(",").map(Number) : stream.pullRequests;
    const eventText = flags.claim ? `Delivery claim set to ${flags.claim}` : flags.next ? `Next action: ${flags.next}` : flags.summary || (flags.status ? `Status set to ${flags.status}` : flags.prs ? `Linked PRs ${flags.prs}` : flags.branch ? `Branch set to ${flags.branch}` : flags["owner-task"] ? `Owner task set to ${flags["owner-task"]}` : "Updated workstream metadata");
    const next = await store.saveWorkstream({ ...stream, status: flags.status || stream.status, summary: flags.summary || stream.summary, claim: flags.claim ?? stream.claim, next: flags.next === undefined ? stream.next : flags.next, branch: flags.branch ?? stream.branch, ownerTaskId: flags["owner-task"] ?? stream.ownerTaskId, pullRequests }, { type: "status", text: eventText, actor: process.env.CODEX_THREAD_ID });
    if (flags.claim && flags.claim !== stream.claim) process.stdout.write("Delivery claim changed; prior MRR evidence for the old claim is stale.\n");
    return process.stdout.write(`Updated ${next.id}.\n`);
  }

  if (command === "decide") {
    const stream = await store.workstream(requireValue(positional[0], "Specify a workstream ID"));
    const text = requireValue(positional.slice(1).join(" ").trim(), "Specify the decision text");
    const next = await store.saveWorkstream({ ...stream, decisions: [...(stream.decisions || []), text] }, { type: "decision", text: `User decision: ${text}`, actor: process.env.CODEX_THREAD_ID });
    return process.stdout.write(`Recorded decision ${next.decisions.length} on ${next.id}. Review briefs now carry it as settled.\n`);
  }

  if (command === "review" && positional[0] === "brief") {
    const stream = await store.workstream(positional[1]);
    const kind = reviewKind(requireValue(flags.kind, "Specify --kind crr|mrr"));
    if (!kind) throw new Error("Review kind must be crr or mrr");
    const role = requireValue(flags.role, kind === "crr" ? "Specify --role crr" : "Specify --role correctness|design|intent");
    if (kind === "crr" && role !== CRR_ROLE) throw new Error("CRR briefs use --role crr");
    if (kind === "mrr" && !REVIEW_ROLES.includes(role)) throw new Error("MRR briefs use a persona role");
    if (flags.route && !["native", "cli"].includes(flags.route)) throw new Error("Review route must be native or cli");
    const seated = { ...seatingFor(role, flags.model, flags.route), requested: flags.model || null };
    const target = await targetFor(stream, kind);
    let prior = [];
    if (kind === "mrr") {
      const [reviews, dispositions] = await Promise.all([store.reviews(stream.id), store.dispositions(stream.id)]);
      const scope = { target, claim: stream.claim, claimRevision: stream.claimRevision };
      assertSeatOpen(reviews, { role, ...scope });
      // A rerun after a fix verifies this seat's own open findings.
      const ancestors = await ancestorHeads(target.repoRoot, reviews.map((review) => review.head), target.head);
      prior = seatStatus(reviews, role, { ...scope, ancestors, dispositions }).open.map(({ id, text }) => ({ id, text }));
    }
    // Resolve the launch before writing anything, so an unlaunchable model leaves no brief.
    const launch = launchFor(seated, { cwd: target.repoRoot, baseSha: target.baseHead, headSha: target.head });
    const inventory = await diffInventory(target);
    const project = await store.project(stream.project);
    const delegation = await store.addDelegation(stream.id, {
      type: "review", kind, role, model: seated.model, route: seated.route, claim: stream.claim, claimRevision: stream.claimRevision,
      ...(kind === "mrr" ? { seatModels: seated.seatModels } : {}),
      head: target.head, baseHead: target.baseHead, ...(target.tree ? { tree: target.tree } : {}),
      ...(prior.length ? { prior } : {}),
      ownerTaskIdAtBrief: stream.ownerTaskId || null
    });
    const execution = { ...REVIEW_EXECUTION, intended: seated.intended, model: seated.model, route: seated.route, launch };
    return process.stdout.write(`${JSON.stringify({ delegation, execution, inspection: inspection(delegation, inventory), prompt: reviewPrompt(stream, delegation, inventory) }, null, 2)}\n`);
  }
  if (command === "review" && positional[0] === "bind") {
    const stream = await store.workstream(positional[1]);
    const event = await store.addDelegationEvent(stream.id, requireValue(flags.delegation, "Specify --delegation"), { event: "bound", taskId: requireValue(flags["task-id"], "Specify --task-id") });
    return process.stdout.write(`Bound review ${event.id} to ${event.taskId}.\n`);
  }
  if (command === "review" && positional[0] === "fail") {
    throw new Error("Field Report does not record provider failure. Repair or resume a started run. If a model cannot start before it records a review, brief another model from the seat's valid list.");
  }
  if (command === "review" && positional[0] === "record") {
    const stream = await store.workstream(positional[1]);
    const sourceText = await readFile(path.resolve(requireValue(flags.file, "Specify --file <review.json>")), "utf8");
    const parsed = parseEnvelope(sourceText);
    const delegationEvents = await store.delegations(stream.id);
    if (flags.delegation && Object.hasOwn(parsed, "delegationId") && parsed.delegationId !== flags.delegation) throw new Error("Review delegationId conflicts with --delegation");
    const hasDelegationId = Object.hasOwn(parsed, "delegationId");
    const delegationId = hasDelegationId ? parsed.delegationId : flags.delegation;
    let delegation = delegationEvents.find((item) => item.id === delegationId && item.event === "created" && item.type === "review");
    if (!hasDelegationId && !flags.delegation && parsed.reviewerTaskId) {
      const reviewIds = new Set(delegationEvents.filter((item) => item.event === "created" && item.type === "review").map((item) => item.id));
      const bindings = delegationEvents.filter((item) => item.event === "bound" && item.taskId === parsed.reviewerTaskId && reviewIds.has(item.id));
      if (new Set(bindings.map((item) => item.id)).size > 1) throw new Error("Review task is bound to multiple delegations; specify --delegation");
      if (bindings.length) delegation = delegationEvents.find((item) => item.id === bindings[0].id && item.event === "created" && item.type === "review");
    }
    if (!delegation) throw new Error("Review must reference a known Field Report review delegation. Use --delegation for original output without a delegationId.");
    const bound = delegationEvents.findLast((item) => item.id === delegation.id && item.event === "bound");
    if (!bound) throw new Error("Review requires an explicit delegation task binding before recording");
    const envelope = normalizeReview(parsed, delegation, bound);
    const validated = validateReview(envelope, delegation);
    const { review, assignedFindingIds: assigned } = await store.addReview(stream.id, { ...validated, sourceText, expectedClaimRevision: stream.claimRevision ?? 1, claimRevision: delegation.claimRevision ?? 1, ownerTaskIdAtBrief: delegation.ownerTaskIdAtBrief || null });
    return process.stdout.write(`Recorded ${review.role} ${review.verdict} for ${review.kind} target ${(review.tree || review.head).slice(0, 12)}.${assigned.length ? ` Assigned finding IDs: ${assigned.join(", ")}.` : ""}\n`);
  }
  if (command === "review" && positional[0] === "accept") {
    const stream = await store.workstream(positional[1]);
    const findingId = requireValue(flags.finding, "Specify --finding <F-id>");
    // A bare flag parses as `true`; only a real string counts.
    const text = (value) => (typeof value === "string" ? value.trim() : "");
    const reason = requireValue(text(flags.reason), "Specify --reason");
    const finding = findingLedger(await store.reviews(stream.id)).find((item) => item.id === findingId);
    if (!finding) throw new Error(`Unknown MRR finding: ${findingId}`);
    // No default: the agent's own task ID would make every acceptance self-vouched.
    const actor = requireValue(text(flags.actor), "Specify --actor: who accepted the finding (normally the user)");
    const disposition = await store.addDisposition(stream.id, { findingId, reason, actor });
    return process.stdout.write(`Recorded acceptance of ${disposition.findingId} (${finding.role}) by ${disposition.actor}. Record it only when the user explicitly accepted the finding.\n`);
  }
  if (command === "review" && positional[0] === "status") {
    const stream = await store.workstream(positional[1]);
    const kind = requireValue(flags.kind, "Specify --kind crr|mrr");
    const result = await gateFor(stream, kind);
    const lines = [printGate(stream, result, true), ...scoreLines(result.reviews, stream, result.target.head)];
    return process.stdout.write(`${lines.join("\n")}\n`);
  }

  if (command === "gate") {
    const action = positional[0] == null || positional[0] === "commit" ? "checkout" : positional[0];
    const streamId = positional[1];
    if (action === "checkout") {
      const stream = await streamForCheckout(streamId);
      return process.stdout.write(`${stream.id} is bound to this checkout.\n`);
    }
    if (action === "crr") {
      const stream = await streamForCheckout(streamId);
      const result = await gateFor(stream, "crr");
      const output = printGate(stream, result);
      if (!result.gate.ready) throw new Error(output);
      return process.stdout.write(`${output}\n`);
    }
    if (action === "open") {
      const stream = await streamForCheckout(streamId);
      const result = await openGate(stream);
      const lines = [`${stream.id} open gate at ${result.target.head.slice(0, 12)}: ${result.ready ? readyLabel(result.gate) : "BLOCKED"}`, "Field Report does not open the pull request.", ...result.reasons.map((reason) => `- ${reason}`), ...result.gate.notes.map((note) => `- ${note}`), ...evidenceLines(result.gate)];
      if (!result.ready) throw new Error(lines.join("\n"));
      return process.stdout.write(`${lines.join("\n")}\n`);
    }
    if (action === "bots") {
      const stream = await store.workstream(requireValue(streamId, "Specify a workstream ID"));
      const result = await botsGate(stream);
      const prLine = result.pr ? `PR #${result.pr.number}: ${result.pr.isDraft ? "draft" : "ready"}` : result.githubError ? `GitHub lookup failed: ${result.githubError}` : "No pull request";
      const lines = [`${stream.id} bots gate at ${result.target.head.slice(0, 12)}: ${result.ready ? readyLabel(result.gate) : "BLOCKED"}`, prLine, ...result.reasons.map((reason) => `- ${reason}`), ...result.gate.notes.map((note) => `- ${note}`), ...evidenceLines(result.gate)];
      if (!result.ready) throw new Error(lines.join("\n"));
      return process.stdout.write(`${lines.join("\n")}\n`);
    }
    throw new Error(`Unknown gate: ${action}\n\n${usage()}`);
  }

  if (command === "hook") {
    const action = positional[0];
    const project = await store.project(requireValue(positional[1], "Specify a project ID"));
    const hook = (await exec("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: project.repoPath })).stdout.trim();
    const preserved = `${hook}.field-report-preserved`;
    let existing = null;
    try { existing = await readFile(hook, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (action === "status") {
      const state = hookState(existing);
      const label = { installed: "installed", outdated: "outdated (rerun fr hook install)", gate: "installed (runs fr gate checkout)", missing: "missing" }[state];
      return process.stdout.write(`${project.id}: ${label} at ${hook}\n`);
    }
    if (action === "install") {
      // A tracked hook belongs to the repository or its hook manager; never rewrite it.
      let tracked = false;
      try { await exec("git", ["ls-files", "--error-unmatch", "--", hook], { cwd: project.repoPath }); tracked = true; } catch {}
      if (tracked) throw new Error(`${hook} is tracked by the repository (a hook manager such as husky owns it). Add \`fr gate checkout\` to that hook instead of running fr hook install.`);
      let hooksPath = "";
      try { hooksPath = (await exec("git", ["config", "--get", "core.hooksPath"], { cwd: project.repoPath })).stdout.trim(); } catch {}
      const commonDir = hooksPath ? (await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: project.repoPath })).stdout.trim() : "";
      const manager = hookManagerPath({ hook, hooksPath, commonDir });
      if (manager) throw new Error(`core.hooksPath=${manager}: a hook manager such as husky or lefthook owns ${hook} and may regenerate it. Add \`fr gate checkout\` to that manager's pre-commit hook instead of running fr hook install.`);
      await mkdir(path.dirname(hook), { recursive: true });
      let preservedExists = true;
      try { await access(preserved); } catch { preservedExists = false; }
      const preserveExisting = shouldRunPreserved(existing, preservedExists);
      if (preserveExisting && !isManagedHook(existing)) { await access(hook); await copyFile(hook, preserved); await chmod(preserved, 0o755); }
      const temporary = `${hook}.${process.pid}.next`;
      let launcher = process.argv[1];
      try { launcher = (await exec("which", ["fr"])).stdout.trim() || launcher; } catch {}
      await writeFile(temporary, hookText(launcher, preserveExisting ? preserved : null), { mode: 0o755 });
      await rename(temporary, hook);
      return process.stdout.write(`${project.id}: installed or refreshed checkout hook at ${hook}.\n`);
    }
    if (action === "uninstall") {
      if (!isManagedHook(existing)) throw new Error("Field Report checkout hook is not installed");
      try { await rename(preserved, hook); } catch (error) { if (error.code === "ENOENT") await rm(hook); else throw error; }
      return process.stdout.write(`${project.id}: removed checkout hook.\n`);
    }
    throw new Error("Use fr hook install|status|uninstall <project-id>");
  }

  if (command === "seats") {
    const lines = [`Config: ${configSource()}`];
    for (const role of SEATS) {
      const seat = seatFor(role);
      lines.push(`${role}:`);
      seat.models.forEach((model, index) => lines.push(`  ${index === 0 ? "default" : "also valid"}: ${model.id} via ${model.launch}${model.cliModel !== model.id ? ` (${model.cliModel})` : ""}`));
    }
    lines.push("A seat accepts only the models listed for it; the first is the default. Edit the config file to change them; no code change is needed.");
    return process.stdout.write(`${lines.join("\n")}\n`);
  }

  if (command === "machines") {
    const action = positional[0];
    const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();
    if (action === "status" || action === "worker") {
      throw new Error("Field Report does not probe host accessibility or start My Machines workers. Start a worker for this checkout with Cursor's agent CLI. Print a host codex or claude command with fr machines invoke.");
    }
    if (action === "invoke") {
      const launcher = requireValue(positional[1], "Specify codex or claude");
      const promptFile = path.resolve(requireValue(flags["prompt-file"], "Specify --prompt-file"));
      if (launcher === "codex") return process.stdout.write(`${codexInvokeCommand({ promptFile, cwd, kind: flags.kind || "review", model: flags.model })}\n`);
      if (launcher === "claude") return process.stdout.write(`${claudeInvokeCommand({ promptFile, cwd, baseSha: requireValue(flags.base, "Specify --base <sha>"), headSha: requireValue(flags.head, "Specify --head <sha>"), model: flags.model })}\n`);
      throw new Error(`Invoke launcher must be ${HOST_LAUNCHERS.join(" or ")}`);
    }
    throw new Error(`Use fr machines invoke ${HOST_LAUNCHERS.join("|")} --prompt-file <path>`);
  }

  if (command === "workflow") {
    const role = positional[0] || "shared";
    const markdown = await readFile(path.join(runtimeRoot, "docs", "fr-workflow.md"), "utf8");
    if (role === "shared") return process.stdout.write(markdown);
    const heading = { coordinator: "Repository coordinator", workstream: "Workstream owner", reviewer: "Reviewer" }[role];
    if (!heading) throw new Error("Workflow role must be shared, coordinator, workstream, or reviewer");
    const sections = markdown.split(/^## /m).slice(1).map((part) => ({ title: part.slice(0, part.indexOf("\n")).trim(), body: part.slice(part.indexOf("\n") + 1).trim() }));
    return process.stdout.write(`${sections.filter((section) => ["Shared contract", heading].includes(section.title)).map((section) => `## ${section.title}\n\n${section.body}`).join("\n\n")}\n`);
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => { console.error(`fr: ${error.message}`); process.exitCode = 1; });
