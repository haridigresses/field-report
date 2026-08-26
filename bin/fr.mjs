#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEnvelope, normalizeReview } from "../src/envelope.mjs";
import { createStore } from "../src/store.mjs";
import { botsReasons, CRR_ROLE, evaluateGate, evaluateMergeReady, identityKey, lastReadyMrr, latestClaimReviews, matchingWaiver, noGoHasEvidence, outstandingFindings, preferredAlreadyAttempted, preferredAttemptFailed, reviewKind, REVIEW_ROLES, seatingFor, validateReview, workstreamBotsReasons } from "../src/policy.mjs";
import { checkout, crrTarget, diffInventory, mrrTarget, pullRequest } from "../src/repository.mjs";
import { hookText, isManagedHook, marker, quote, shouldRunPreserved } from "../src/hooks.mjs";

const exec = promisify(execFile);
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createStore();
const REVIEW_EXECUTION = Object.freeze({ conversationInheritance: "none", mcp: "none" });
const LAUNCH = Object.freeze({
  "gpt-5.6-sol": "codex exec -m gpt-5.6-sol -s read-only --ignore-user-config --json -o <output> -C <repo> - < <prompt>",
  "grok-4.6": "fr-cursor-review --model cursor-grok-4.6-high --print --output-format stream-json --sandbox enabled --trust -- \"$(< <prompt>)\"",
  "claude-fable-5": "claude --print --permission-mode dontAsk --allowedTools \"Read,Grep,Glob,Bash(git diff *)\" --strict-mcp-config --mcp-config '{\"mcpServers\":{}}' --output-format json --no-session-persistence --model claude-fable-5 \"$(< <prompt>)\""
});

function launchFor(seated) {
  if (seated.role === CRR_ROLE && seated.route === "native") {
    return `Launch a fresh ${seated.model} subagent with conversationInheritance=none and no MCP servers, including agent-fixes. Prefer a local model; use cloud only if local cannot produce an envelope. Do not pass the owner conversation.`;
  }
  if (seated.route === "native") return `Launch a fresh native ${seated.model} subagent with conversationInheritance=none and no MCP servers, including agent-fixes; do not pass the owner conversation.`;
  return LAUNCH[seated.model] || `Launch ${seated.model} without MCP servers or AF. Prefer local; cloud only if needed.`;
}

function usage() {
  return `Field Report control loop

fr init
fr project add <id> --label <label> --repo <path> [--github owner/repo] [--base main]
fr project update <id> [--label <label>] [--repo <path>] [--github owner/repo] [--base main]
fr project list
fr identity --role coordinator|owner
fr create <id> --project <id> --title <title> --outcome <text> [--branch <branch>] [--owner-task <id>]
fr list [--project <id>]
fr show <id> [--json]
fr context [id]
fr update <id> [--status planned|active|blocked|complete] [--summary <text>] [--claim <text>] [--branch <branch>] [--owner-task <id>] [--prs 1,2]
fr review brief <id> --kind crr|mrr --role crr|deep-code-review|structural-challenge|fable-challenge [--model <id>] [--route native|cli] [--reconcile]
fr review bind <id> --delegation <uuid> --task-id <native-task-or-provider-run-id>
fr review fail <id> --delegation <uuid> --task-id <native-task-or-provider-run-id> --reason <text>
fr review record <id> --file <review.json>
fr review waive <id> --reason <text> [--actor <id>]
fr review status <id> --kind crr|mrr
fr gate checkout [id]
fr gate crr [id]
fr gate open [id]
fr gate bots <id>
fr hook install|status|uninstall <project-id>
fr workflow [shared|coordinator|workstream|reviewer]

Field Report binds a delivery unit and records review evidence. It does not launch reviewers, open pull requests, or merge.`;
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
  if (explicit) return store.workstream(explicit);
  const [project, state, streams] = await Promise.all([projectForCheckout(), checkout(), store.workstreams()]);
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
    ? "CRR: is this commit competent, and are there any gaps the owner should fix before keeping it? Stay short. Do not invent product or design decisions."
    : delegation.role === "deep-code-review"
      ? "Inspect correctness, security, data integrity, error paths, regressions, and test adequacy."
      : delegation.role === "structural-challenge"
        ? "Inspect necessity, simplicity, authority boundaries, scope, maintainability, and whether you would select the mechanism from scratch."
        : "Inspect the candidate as the independent challenge lane. Prefer Fable 5; a backup model is allowed when Fable cannot produce an envelope.";
  const outstanding = delegation.outstanding?.length
    ? `\n\nOutstanding MRR findings requiring explicit reconciliation, judged against the current exact target:\n${delegation.outstanding.map((finding) => `- ${finding.id} (${finding.category}): ${finding.text}`).join("\n")}\nAccount for every delivered ID in reconciled: use disposition=resolved when fixed, rejected when inapplicable to the current claim, or still_present when it remains. Give evidence-based rationale. Findings and unresolved are only for newly discovered issues; do not restate a delivered issue there. A NO_GO may rest on still_present reconciliations alone. Do not clear an issue on the owner's assurance alone.`
    : "";
  const files = (inventory.files || []).map((file) => `- ${file}`).join("\n") || "- none listed";
  const envelope = kind === "crr"
    ? `Return only one JSON object containing: reviewComplete=true, independent=true, delegationId=${delegation.id}, reviewerTaskId, claim exactly as stated above, kind=crr, role=crr, head, baseHead, tree, provider, model=${delegation.model}, route=${delegation.route}, verdict=GO|NO_GO, findings as a string array, summary, scores {mergeReadiness, structuralRisk, implementationQuality, evidenceConfidence, outcomeConfidence}, each an integer 0-100, and scoreRationale with one concise string for each score. No prose or Markdown fences.`
    : `Return only one JSON object containing: reviewComplete=true, independent=true, delegationId=${delegation.id}, reviewerTaskId, claim exactly as stated above, kind=mrr, role=${delegation.role}, head, baseHead, provider, model=${delegation.model}, route=${delegation.route}, verdict=GO|NO_GO, findings as a string array, unresolved as a string array,${delegation.outstanding?.length ? " reconciled as an array of {findingId, disposition, rationale} objects," : ""} summary, scores {mergeReadiness, structuralRisk, implementationQuality, evidenceConfidence, outcomeConfidence}, each an integer 0-100, scoreRationale with one concise string for each score, necessity=necessary|questionable_roi, simplerPath explaining considered alternatives or that none were found, scopeDrift=none|minor|material, contractIntegrity=sound|mixed|broken, and evidenceQuality=strong|mixed|weak. No prose or Markdown fences.`;
  return `Independently review Field Report workstream ${stream.id} as ${delegation.role} using model ${delegation.model}. Target ${target}. Stated outcome: ${stream.outcome}. Current claim JSON string (copy its decoded value exactly): ${JSON.stringify(delegation.claim)}\n${rubric}\n\nInspect the exact target with this read-only command:\n${inspectCommand(delegation)}\n\nChanged files (${inventory.files.length}; +${inventory.additions} −${inventory.deletions}):\n${files}\n\nDo not run fr, owner skills, MCP servers, or AF. Inspect repository files and the inspect command only. Do not inherit or request the owner's conversation. A fresh subagent is independent even when it uses the builder's model. Do not make product or design decisions. Return only the JSON envelope.\n\nThe claim describes the intended outcome; it does not limit review scope.${kind === "mrr" ? " Review the complete changed authority boundary, derive its relevant behavioral state space, trace affected consumers and call paths, and judge the accumulated mechanism rather than only the latest repair or reported cases. Attempt to falsify the candidate; do not defer to the owner's framing, passing tests, implementation effort, or other reviewers. Any material defect or missing evidence is a finding, as is a candidate too broad or incoherent to assess reliably." : ""} Put deferred scope, optional improvements, and other nonblocking observations in the summary, not findings. A GO with observations is valid. Do not modify the candidate.${outstanding}\n\n${envelope}`;
}

async function gateFor(stream, kind) {
  const project = await store.project(stream.project);
  const target = await targetFor(stream, kind);
  const [reviews, delegations] = await Promise.all([store.reviews(stream.id), store.delegations(stream.id)]);
  const gate = evaluateGate({ kind, target, workstream: stream, project, reviews, delegations });
  return { project, target, gate };
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
    if (review.reconciled?.length) lines.push(`  Reconciled: ${review.reconciled.map((entry) => `${entry.findingId} ${entry.disposition} — ${entry.rationale}`).join(" | ")}`);
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

async function mergeReadyFor(stream) {
  const project = await store.project(stream.project);
  const target = await targetFor(stream, "mrr");
  const [reviews, delegations, waivers] = await Promise.all([store.reviews(stream.id), store.delegations(stream.id), store.waivers(stream.id)]);
  const gate = evaluateMergeReady({ target, workstream: stream, reviews, delegations, waivers });
  return { project, target, gate };
}

function printMergeReady(gate) {
  if (gate.phase === "ready") return `READY on this HEAD`;
  if (gate.phase === "waived") return `merge-ready via skip — ${gate.waiver.reason} (prior MRR ${(gate.waiver.priorHead || "").slice(0, 12)})`;
  if (gate.phase === "churn") return gate.reasons.join("; ");
  return `BLOCKED — ${gate.reasons.join("; ")}`;
}

function printGate(stream, result, includeEvidence = false) {
  const { gate, target } = result;
  const label = target.tree || target.head;
  const lines = [`${stream.id} ${gate.kind} gate at ${label.slice(0, 12)}: ${gate.ready ? "READY" : "BLOCKED"}`];
  if (gate.reasons.length) lines.push(...gate.reasons.map((reason) => `- ${reason}`));
  if (includeEvidence) lines.push(...evidenceLines(gate));
  return lines.join("\n");
}

async function openGate(stream) {
  const result = await gateFor(stream, "mrr");
  const state = await checkout();
  const reasons = [...result.gate.reasons, ...(state.dirty ? ["checkout has uncommitted changes"] : [])];
  return { ...result, reasons, ready: reasons.length === 0 };
}

async function botsGate(stream) {
  const result = await mergeReadyFor(stream);
  const state = await checkout();
  let pr = null;
  try { pr = await pullRequest(result.project, stream); } catch { pr = null; }
  const ci = botsReasons({ project: result.project, target: result.target, checkout: state, pr });
  const reasons = [
    ...result.gate.reasons,
    ...ci,
    ...workstreamBotsReasons({ workstream: stream, workstreams: await store.workstreams(), pr })
  ];
  const checks = pr?.statusCheckRollup || [];
  const observations = pr && !checks.length ? ["No GitHub checks observed; this is not evidence that CI ran"] : [];
  return { ...result, pr, reasons, observations, ready: reasons.length === 0 };
}

async function main() {
  const command = process.argv[2] || "help";
  const { positional, flags } = parse(process.argv.slice(3));
  if (["help", "--help", "-h"].includes(command)) return process.stdout.write(`${usage()}\n`);
  if (command === "init") { const root = await store.init(); return process.stdout.write(`Initialized Field Report state at ${root}\n`); }

  if (command === "project" && positional[0] === "add") {
    const record = await store.saveProject({ id: positional[1], label: flags.label, repoPath: flags.repo, githubRepo: flags.github, baseBranch: flags.base });
    return process.stdout.write(`Saved project ${record.id}. Install its checkout hook explicitly with: fr hook install ${record.id}\n`);
  }
  if (command === "project" && positional[0] === "update") {
    const record = await store.updateProject(positional[1], { label: flags.label, repoPath: flags.repo, githubRepo: flags.github, baseBranch: flags.base });
    return process.stdout.write(`Updated project ${record.id}.\n`);
  }
  if (command === "project" && positional[0] === "list") return process.stdout.write(`${(await store.projects()).map((project) => `${project.id}\t${project.baseBranch}\t${project.repoPath}`).join("\n")}\n`);

  if (command === "identity") {
    const role = requireValue(flags.role, "Specify --role coordinator|owner");
    const project = await projectForCheckout();
    const identity = identityKey(project.id, role);
    return process.stdout.write(`${JSON.stringify({
      project: project.id,
      role,
      ...identity,
      instruction: "If AF whoami has no name, save this session as key. If that name is held by a live session, use fallback. Do not ask the user to name you. Reviewers must not save."
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
    return process.stdout.write(`${stream.id}\n${stream.title}\nStatus: ${stream.status}\nClaim: ${stream.claim}\n${stream.summary}\nBranch: ${stream.branch || "not assigned"}\n`);
  }
  if (command === "context") {
    const stream = await streamForCheckout(positional[0]);
    const project = await store.project(stream.project);
    const state = await checkout();
    const identity = identityKey(project.id, stream.ownerTaskId ? "owner" : "coordinator");
    let mrr;
    try { mrr = await mergeReadyFor(stream); } catch (error) { mrr = { gate: { phase: "blocked", reasons: [error.message] } }; }
    const reviews = await store.reviews(stream.id);
    return process.stdout.write(`Repository: ${project.label} (${project.id})\nCheckout: ${state.branch} @ ${state.head.slice(0, 12)}${state.dirty ? " · dirty" : ""}\nWorkstream: ${stream.id} — ${stream.title}\nStatus: ${stream.status}\nClaim: ${stream.claim}\nAF namespace: ${identity.key} (fallback ${identity.fallback})\nMRR: ${printMergeReady(mrr.gate)}\n${scoreLines(reviews, stream, state.head).join("\n")}\nDo not auto-open a pull request. After pre-open MRR is READY, you may open one or leave that to the user. Do not commission MRR because HEAD moved; wait until the user asks for final MRR.\n`);
  }
  if (command === "update") {
    const stream = await store.workstream(requireValue(positional[0], "Specify a workstream ID"));
    const pullRequests = flags.prs ? flags.prs.split(",").map(Number) : stream.pullRequests;
    const eventText = flags.claim ? `Delivery claim set to ${flags.claim}` : flags.summary || (flags.status ? `Status set to ${flags.status}` : flags.prs ? `Linked PRs ${flags.prs}` : flags.branch ? `Branch set to ${flags.branch}` : flags["owner-task"] ? `Owner task set to ${flags["owner-task"]}` : "Updated workstream metadata");
    const next = await store.saveWorkstream({ ...stream, status: flags.status || stream.status, summary: flags.summary || stream.summary, claim: flags.claim ?? stream.claim, branch: flags.branch ?? stream.branch, ownerTaskId: flags["owner-task"] ?? stream.ownerTaskId, pullRequests }, { type: "status", text: eventText, actor: process.env.CODEX_THREAD_ID });
    if (flags.claim && flags.claim !== stream.claim) process.stdout.write("Delivery claim changed; prior MRR evidence for the old claim is stale.\n");
    return process.stdout.write(`Updated ${next.id}.\n`);
  }

  if (command === "review" && positional[0] === "brief") {
    const stream = await store.workstream(positional[1]);
    const kind = reviewKind(requireValue(flags.kind, "Specify --kind crr|mrr"));
    if (!kind) throw new Error("Review kind must be crr or mrr");
    const role = requireValue(flags.role, kind === "crr" ? "Specify --role crr" : "Specify --role deep-code-review|structural-challenge|fable-challenge");
    if (kind === "crr" && role !== CRR_ROLE) throw new Error("CRR briefs use --role crr");
    if (kind === "mrr" && !REVIEW_ROLES.includes(role)) throw new Error("MRR briefs use a persona role");
    if (flags.route && !["native", "cli"].includes(flags.route)) throw new Error("Review route must be native or cli");
    const seated = seatingFor(role, flags.model, flags.route);
    const target = await targetFor(stream, kind);
    const scope = { role, kind, target, claim: stream.claim, claimRevision: stream.claimRevision };
    const [delegations, reviews] = kind === "mrr" ? await Promise.all([store.delegations(stream.id), store.reviews(stream.id)]) : [[], []];
    if (kind === "mrr" && seated.model === seated.preferred && preferredAlreadyAttempted(delegations, scope, reviews)) {
      throw new Error(preferredAttemptFailed(delegations, scope)
        ? `${role} preferred ${seated.preferred} already failed on this claim and target; do not retry that provider`
        : `${role} preferred ${seated.preferred} was already attempted on this claim and target`);
    }
    if (kind === "mrr" && seated.model === seated.backup && seated.model !== seated.preferred && !preferredAttemptFailed(delegations, scope)) {
      throw new Error(`${role} backup requires a terminal ${seated.preferred} failure on this target first`);
    }
    const outstanding = kind === "mrr" && (role === "deep-code-review" || flags.reconcile) ? outstandingFindings(await store.reviews(stream.id), stream.claim).map(({ id, category, text }) => ({ id, category, text })) : [];
    const inventory = await diffInventory(target);
    const delegation = await store.addDelegation(stream.id, { type: "review", kind, role, model: seated.model, route: seated.route, claim: stream.claim, claimRevision: stream.claimRevision, head: target.head, baseHead: target.baseHead, ...(target.tree ? { tree: target.tree } : {}), ...(outstanding.length ? { outstanding } : {}), ownerTaskIdAtBrief: stream.ownerTaskId || null });
    const execution = { ...REVIEW_EXECUTION, preferred: seated.preferred, backup: seated.backup, model: seated.model, route: seated.route, launch: launchFor(seated) };
    return process.stdout.write(`${JSON.stringify({ delegation, execution, inspection: inspection(delegation, inventory), prompt: reviewPrompt(stream, delegation, inventory) }, null, 2)}\n`);
  }
  if (command === "review" && positional[0] === "bind") {
    const stream = await store.workstream(positional[1]);
    const event = await store.addDelegationEvent(stream.id, requireValue(flags.delegation, "Specify --delegation"), { event: "bound", taskId: requireValue(flags["task-id"], "Specify --task-id") });
    return process.stdout.write(`Bound review ${event.id} to ${event.taskId}.\n`);
  }
  if (command === "review" && positional[0] === "fail") {
    const stream = await store.workstream(positional[1]);
    const delegationId = requireValue(flags.delegation, "Specify --delegation");
    const taskId = requireValue(flags["task-id"], "Specify --task-id");
    const reason = requireValue(flags.reason, "Specify --reason");
    const events = await store.delegations(stream.id);
    const delegation = events.find((item) => item.id === delegationId && item.event === "created" && item.type === "review");
    if (!delegation) throw new Error(`Unknown review delegation: ${delegationId}`);
    if ((await store.reviews(stream.id)).some((review) => review.delegationId === delegationId)) throw new Error("A recorded review attempt is already terminal");
    const bound = events.findLast((item) => item.id === delegationId && item.event === "bound");
    if (!bound) await store.addDelegationEvent(stream.id, delegationId, { event: "bound", taskId });
    else if (bound.taskId !== taskId) throw new Error("Failed review task ID must match its explicit delegation binding");
    await store.addDelegationEvent(stream.id, delegationId, { event: "failed", taskId, reason });
    return process.stdout.write(`Recorded terminal ${delegation.role} review failure for ${delegationId}. Do not retry that provider.${reviewKind(delegation.kind) === "mrr" ? " Use the named backup only if you still need that persona; two finding-free GOs already pass when this lane is unavailable." : ""}\n`);
  }
  if (command === "review" && positional[0] === "record") {
    const stream = await store.workstream(positional[1]);
    const parsed = parseEnvelope(await readFile(path.resolve(requireValue(flags.file, "Specify --file <review.json>")), "utf8"));
    const delegationEvents = await store.delegations(stream.id);
    let delegation = delegationEvents.find((item) => item.id === parsed.delegationId && item.event === "created" && item.type === "review");
    if (!delegation && parsed.reviewerTaskId) {
      const boundByTask = delegationEvents.findLast((item) => item.event === "bound" && item.taskId === parsed.reviewerTaskId);
      if (boundByTask) delegation = delegationEvents.find((item) => item.id === boundByTask.id && item.event === "created" && item.type === "review");
    }
    const envelope = normalizeReview(parsed, delegation);
    if (!delegation) throw new Error("Review must reference its Field Report delegation. Repair the envelope from the brief; do not relaunch the reviewer for a schema mismatch.");
    const bound = delegationEvents.findLast((item) => item.id === envelope.delegationId && item.event === "bound");
    if (!bound || bound.taskId !== envelope.reviewerTaskId) throw new Error("Review task ID must match its explicit delegation binding. Repair the envelope from the brief; do not relaunch the reviewer for a schema mismatch.");
    if (delegationEvents.some((item) => item.id === envelope.delegationId && item.event === "failed")) throw new Error("A failed review attempt is terminal; create a new brief to retry");
    const validated = validateReview(envelope, delegation);
    const currentTarget = await targetFor(stream, delegation.kind);
    const stale = (delegation.claimRevision ?? 1) !== (stream.claimRevision ?? 1) || delegation.head !== currentTarget.head || delegation.baseHead !== currentTarget.baseHead || (reviewKind(delegation.kind) === "crr" && delegation.tree !== currentTarget.tree);
    if (stale && (validated.verdict !== "NO_GO" || !noGoHasEvidence(validated))) throw new Error("A stale review may record new adverse evidence only; it may not record a GO");
    if (stale && (validated.reconciled || []).some((entry) => entry.disposition !== "still_present")) throw new Error("A stale review may mark delivered findings still_present but may not resolve or reject them");
    const packet = new Set((delegation.outstanding || []).map((finding) => finding.id));
    for (const entry of validated.reconciled || []) if (!packet.has(entry.findingId)) throw new Error(`reconciled may only reference IDs from this brief's outstanding packet; out-of-packet ID: ${entry.findingId}`);
    for (const delivered of delegation.outstanding || []) if (!(validated.reconciled || []).some((entry) => entry.findingId === delivered.id)) throw new Error(`reconciled must account for delivered issue ${delivered.id} as resolved, rejected, or still_present`);
    const { review, assignedFindingIds: assigned } = await store.addReview(stream.id, { ...validated, expectedClaimRevision: stream.claimRevision ?? 1, claimRevision: delegation.claimRevision ?? 1, ...(stale ? { staleAtRecord: true } : {}), ownerTaskIdAtBrief: delegation.ownerTaskIdAtBrief || null }, { beforeAppend: async () => {
      const latest = await targetFor(stream, delegation.kind);
      if (latest.head !== currentTarget.head || latest.baseHead !== currentTarget.baseHead || (reviewKind(delegation.kind) === "crr" && latest.tree !== currentTarget.tree)) throw new Error("Repository target changed while the review was being recorded; retry against current state");
    } });
    return process.stdout.write(`Recorded ${review.role} ${review.verdict} for ${review.kind} target ${(review.tree || review.head).slice(0, 12)}.${assigned.length ? ` Assigned finding IDs: ${assigned.join(", ")}.` : ""}\n`);
  }
  if (command === "review" && positional[0] === "waive") {
    const stream = await store.workstream(positional[1]);
    const reason = requireValue(flags.reason, "Specify --reason");
    const target = await targetFor(stream, "mrr");
    const [reviews, waivers] = await Promise.all([store.reviews(stream.id), store.waivers(stream.id)]);
    const exact = await gateFor(stream, "mrr");
    if (exact.gate.ready) throw new Error("Exact-head MRR is already READY; no skip is needed");
    const last = lastReadyMrr(reviews, stream, await store.delegations(stream.id));
    if (!last) throw new Error("A skip requires a prior finding-free MRR on this claim");
    const outstanding = outstandingFindings(reviews, stream.claim);
    if (outstanding.length) throw new Error(`Reconcile outstanding MRR findings before skipping the panel: ${outstanding.map((item) => item.id).join(", ")}`);
    if (matchingWaiver(waivers, { target, workstream: stream })) throw new Error("A skip is already recorded for this exact head");
    const actor = String(flags.actor || process.env.CODEX_THREAD_ID || stream.ownerTaskId || "").trim();
    if (!actor) throw new Error("A skip requires a recorded actor: pass --actor, set CODEX_THREAD_ID, or bind an owner session");
    const waiver = await store.addWaiver(stream.id, { head: target.head, baseHead: target.baseHead, claim: stream.claim, claimRevision: stream.claimRevision ?? 1, priorHead: last.head, reason, actor });
    return process.stdout.write(`Recorded MRR skip for ${waiver.head.slice(0, 12)} (prior MRR ${waiver.priorHead.slice(0, 12)}, actor ${waiver.actor}). This skip dies if HEAD moves. Do not record a skip unless the user explicitly agreed.\n`);
  }
  if (command === "review" && positional[0] === "status") {
    const stream = await store.workstream(positional[1]);
    const kind = requireValue(flags.kind, "Specify --kind crr|mrr");
    const result = await gateFor(stream, kind);
    const reviews = await store.reviews(stream.id);
    const lines = [printGate(stream, result, true), ...scoreLines(reviews, stream, result.target.head)];
    if (kind === "mrr") {
      const merge = await mergeReadyFor(stream);
      lines.push(`Merge-ready: ${printMergeReady(merge.gate)}`);
    }
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
      const lines = [`${stream.id} open gate at ${result.target.head.slice(0, 12)}: ${result.ready ? "READY" : "BLOCKED"}`, "Field Report does not open the pull request.", ...result.reasons.map((reason) => `- ${reason}`), ...evidenceLines(result.gate)];
      if (!result.ready) throw new Error(lines.join("\n"));
      return process.stdout.write(`${lines.join("\n")}\n`);
    }
    if (action === "bots") {
      const stream = await store.workstream(requireValue(streamId, "Specify a workstream ID"));
      const result = await botsGate(stream);
      const prLine = result.pr ? `PR #${result.pr.number}: ${result.pr.isDraft ? "draft" : "ready"}` : "No pull request";
      const lines = [`${stream.id} bots gate at ${result.target.head.slice(0, 12)}: ${result.ready ? "READY" : "BLOCKED"}`, prLine, ...result.reasons.map((reason) => `- ${reason}`), ...(result.observations || []).map((reason) => `- ${reason}`), ...evidenceLines(result.gate)];
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
    if (action === "status") return process.stdout.write(`${project.id}: ${existing?.includes(marker) ? "installed" : "missing"} at ${hook}\n`);
    if (action === "install") {
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
      if (!existing?.includes(marker)) throw new Error("Field Report checkout hook is not installed");
      try { await rename(preserved, hook); } catch (error) { if (error.code === "ENOENT") await rm(hook); else throw error; }
      return process.stdout.write(`${project.id}: removed checkout hook.\n`);
    }
    throw new Error("Use fr hook install|status|uninstall <project-id>");
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
