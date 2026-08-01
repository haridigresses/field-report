#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createStore } from "../src/store.mjs";
import { evaluateGate, miniEligibility, publicationReasons, SOL_ROLES, validateReview } from "../src/policy.mjs";
import { checkout, commitTarget, diffInventory, finalTarget, markReady, pullRequest } from "../src/repository.mjs";
import { hookText, marker, quote, shouldRunPreserved } from "../src/hooks.mjs";

const exec = promisify(execFile);
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createStore();
const SHA = /^[0-9a-f]{40}$/i;

function usage() {
  return `Field Report software-factory harness

fr init
fr project add <id> --label <label> --repo <path> [--github owner/repo] [--base main]
fr project update <id> [--label <label>] [--repo <path>] [--github owner/repo] [--base main]
fr project list
fr create <id> --project <id> --title <title> --outcome <text> [--branch <branch>] [--owner-task <id>]
fr list [--project <id>]
fr show <id> [--json]
fr context [id]
fr update <id> [--status planned|active|blocked|complete] [--summary <text>] [--next <text>] [--branch <branch>] [--owner-task <id>] [--prs 1,2]
fr question add <id> <question>
fr question resolve <id> <question-id> <decision>
fr classify <id> full|mini [--reason <text>]
fr delegate brief <id> --role workstream-owner|executor --slice <text>
fr delegate bind <id> --delegation <uuid> --task-id <native-task-id>
fr delegate complete <id> --delegation <uuid> --file <completion.json>
fr review brief <id> --kind commit|final --role deep-code-review|structural-challenge|fable-challenge
fr review bind <id> --delegation <uuid> --task-id <native-task-or-provider-run-id>
fr review record <id> --file <review.json>
fr review status <id> --kind commit|final
fr gate commit [id]
fr gate publish <id>
fr publish <id>
fr hook install|status|uninstall <project-id>
fr workflow [shared|coordinator|workstream|reviewer]

Field Report defines targets, policy, evidence, and gates. Native Codex delegation performs Sol reviews; invoke claude-aws through the user's shell entrypoint for Fable.`;
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
  return kind === "commit" ? commitTarget(project, stream) : finalTarget(project, stream);
}

function reviewPrompt(stream, delegation) {
  const target = delegation.kind === "commit"
    ? `base HEAD ${delegation.baseHead} and staged tree ${delegation.tree}`
    : `base ${delegation.baseHead} and exact final head ${delegation.head}`;
  const rubric = delegation.role === "deep-code-review"
    ? "Inspect correctness, security, data integrity, error paths, regressions, and test adequacy."
    : delegation.role === "structural-challenge"
    ? "Challenge necessity, simplicity, duplicated authority, scope drift, maintainability, and whether you would choose this mechanism from scratch."
    : "Invoke claude-aws through the user's shell entrypoint and perform an independent Fable structural and correctness challenge.";
  return `Review Field Report workstream ${stream.id} as ${delegation.role}. Target ${target}. ${rubric}\n\nReturn one JSON object containing: reviewComplete=true, independent=true, delegationId=${delegation.id}, reviewerTaskId, kind=${delegation.kind}, role=${delegation.role}, head, baseHead${delegation.tree ? ", tree" : ""}, provider, model, route when applicable, verdict=GO|NO_GO, findings[], unresolved[], summary, miniEligible${delegation.role === "fable-challenge" ? " (omit for Fable)" : " boolean"}, scores {mergeReadiness, structuralRisk, implementationQuality, evidenceConfidence}, each an integer 0-100, and scoreRationale with a concise explanation for each score. Do not modify the candidate.`;
}

async function gateFor(stream, kind) {
  const project = await store.project(stream.project);
  const target = await targetFor(stream, kind);
  const gate = evaluateGate({ kind, target, workstream: stream, project, reviews: await store.reviews(stream.id) });
  return { project, target, gate };
}

function printGate(stream, result) {
  const { gate, target } = result;
  const label = target.tree || target.head;
  const lines = [`${stream.id} ${gate.kind} gate at ${label.slice(0, 12)}: ${gate.ready ? "READY" : "BLOCKED"}`, `Review class: ${gate.reviewClass}`];
  if (gate.reasons.length) lines.push(...gate.reasons.map((reason) => `- ${reason}`));
  return lines.join("\n");
}

async function publishGate(stream) {
  const result = await gateFor(stream, "final");
  const state = await checkout();
  const pr = await pullRequest(result.project, stream);
  const reasons = [...result.gate.reasons, ...publicationReasons({ project: result.project, target: result.target, checkout: state, pr })];
  return { ...result, pr, reasons, ready: reasons.length === 0 };
}

async function main() {
  const command = process.argv[2] || "help";
  const { positional, flags } = parse(process.argv.slice(3));
  if (["help", "--help", "-h"].includes(command)) return process.stdout.write(`${usage()}\n`);
  if (command === "init") { const root = await store.init(); return process.stdout.write(`Initialized Field Report state at ${root}\n`); }

  if (command === "project" && positional[0] === "add") {
    const record = await store.saveProject({ id: positional[1], label: flags.label, repoPath: flags.repo, githubRepo: flags.github, baseBranch: flags.base });
    return process.stdout.write(`Saved project ${record.id}. Install its commit gate explicitly with: fr hook install ${record.id}\n`);
  }
  if (command === "project" && positional[0] === "update") {
    const record = await store.updateProject(positional[1], { label: flags.label, repoPath: flags.repo, githubRepo: flags.github, baseBranch: flags.base });
    return process.stdout.write(`Updated project ${record.id}.\n`);
  }
  if (command === "project" && positional[0] === "list") return process.stdout.write(`${(await store.projects()).map((project) => `${project.id}\t${project.baseBranch}\t${project.repoPath}`).join("\n")}\n`);

  if (command === "create") {
    const record = await store.saveWorkstream({ id: positional[0], project: flags.project, title: flags.title, outcome: flags.outcome, summary: flags.outcome, branch: flags.branch, ownerTaskId: flags["owner-task"] }, { type: "created", text: `Created outcome: ${flags.outcome}`, actor: process.env.CODEX_THREAD_ID });
    return process.stdout.write(`Created ${record.id}.\n`);
  }
  if (command === "list") {
    const streams = (await store.workstreams()).filter((stream) => !flags.project || stream.project === flags.project);
    return process.stdout.write(`${streams.map((stream) => `${stream.id}\t${stream.status}\t${stream.reviewClass}\t${stream.title}`).join("\n")}\n`);
  }
  if (command === "show") {
    const stream = await store.workstream(requireValue(positional[0], "Specify a workstream ID"));
    if (flags.json) return process.stdout.write(`${JSON.stringify({ ...stream, reviews: await store.reviews(stream.id), delegations: await store.delegations(stream.id) }, null, 2)}\n`);
    return process.stdout.write(`${stream.id}\n${stream.title}\nStatus: ${stream.status} · Review: ${stream.reviewClass}\n${stream.summary}\nNext: ${stream.next || "not recorded"}\nBranch: ${stream.branch || "not assigned"}\n`);
  }
  if (command === "context") {
    const stream = await streamForCheckout(positional[0]);
    const project = await store.project(stream.project);
    const state = await checkout();
    let final;
    try { final = await gateFor(stream, "final"); } catch (error) { final = { gate: { ready: false, reasons: [error.message] } }; }
    return process.stdout.write(`Repository: ${project.label} (${project.id})\nCheckout: ${state.branch} @ ${state.head.slice(0, 12)}${state.dirty ? " · dirty" : ""}\nWorkstream: ${stream.id} — ${stream.title}\nStatus: ${stream.status}\nNext: ${stream.next || "not recorded"}\nPublish review: ${final.gate.ready ? "READY" : `BLOCKED — ${final.gate.reasons.join("; ")}`}\n`);
  }
  if (command === "update") {
    const stream = await store.workstream(requireValue(positional[0], "Specify a workstream ID"));
    const pullRequests = flags.prs ? flags.prs.split(",").map(Number) : stream.pullRequests;
    const eventText = flags.summary || flags.next || (flags.status ? `Status set to ${flags.status}` : flags.prs ? `Linked PRs ${flags.prs}` : flags.branch ? `Branch set to ${flags.branch}` : flags["owner-task"] ? `Owner task set to ${flags["owner-task"]}` : "Updated workstream metadata");
    const next = await store.saveWorkstream({ ...stream, status: flags.status || stream.status, summary: flags.summary || stream.summary, next: flags.next ?? stream.next, branch: flags.branch ?? stream.branch, ownerTaskId: flags["owner-task"] ?? stream.ownerTaskId, pullRequests }, { type: "status", text: eventText, actor: process.env.CODEX_THREAD_ID });
    return process.stdout.write(`Updated ${next.id}.\n`);
  }

  if (command === "question" && positional[0] === "add") {
    const stream = await store.workstream(positional[1]);
    const text = positional.slice(2).join(" ");
    const number = Math.max(0, ...stream.questions.map((question) => Number(String(question.id).replace(/^Q/, "")) || 0)) + 1;
    const questions = [...stream.questions, { id: `Q${number}`, text: requireValue(text, "Provide a question"), status: "open", askedAt: new Date().toISOString() }];
    await store.saveWorkstream({ ...stream, questions }, { type: "question", text, actor: process.env.CODEX_THREAD_ID });
    return process.stdout.write(`Recorded Q${number}.\n`);
  }
  if (command === "question" && positional[0] === "resolve") {
    await store.addDecision(positional[1], positional[2], positional.slice(3).join(" "), process.env.CODEX_THREAD_ID);
    return process.stdout.write(`Resolved ${positional[2]}.\n`);
  }

  if (command === "classify") {
    const stream = await store.workstream(requireValue(positional[0], "Specify a workstream ID"));
    const mode = positional[1];
    if (mode === "full") { await store.saveWorkstream({ ...stream, reviewClass: "full", miniClassification: null }, { type: "review_class", text: "Full final review required", actor: process.env.CODEX_THREAD_ID }); return process.stdout.write(`${stream.id}: full review required.\n`); }
    if (mode !== "mini" || !flags.reason) throw new Error("Use fr classify <id> mini --reason <reason>");
    const project = await store.project(stream.project);
    const target = await finalTarget(project, stream);
    const classification = { ...miniEligibility({ ...(await diffInventory(target)), project }), head: target.head, baseHead: target.baseHead, reason: flags.reason, classifiedAt: new Date().toISOString(), classifiedBy: process.env.CODEX_THREAD_ID || os.userInfo().username };
    await store.saveWorkstream({ ...stream, reviewClass: "mini", miniClassification: classification }, { type: "review_class", text: `Mini review ${classification.eligible ? "eligible" : "rejected"}: ${flags.reason}`, actor: process.env.CODEX_THREAD_ID });
    return process.stdout.write(`${stream.id}: mini review ${classification.eligible ? "ELIGIBLE" : "REJECTED"}${classification.reasons.length ? ` — ${classification.reasons.join("; ")}` : ""}. Final Sol reviewers must independently affirm eligibility.\n`);
  }

  if (command === "delegate" && positional[0] === "brief") {
    const stream = await store.workstream(positional[1]);
    const role = requireValue(flags.role, "Specify --role workstream-owner|executor");
    if (!["workstream-owner", "executor"].includes(role)) throw new Error("Delegation role must be workstream-owner or executor");
    const slice = requireValue(flags.slice, "Specify the bounded --slice to delegate");
    const delegation = await store.addDelegation(stream.id, { type: "work", role, slice, coordinatorTaskId: process.env.CODEX_THREAD_ID || null });
    const prompt = `Work on Field Report outcome ${stream.id}: ${stream.outcome}\n\nYour bounded ${role} slice is: ${slice}\n\nWhen done, return a completion object with delegationId=${delegation.id}, taskId, completed=true|false, finalHead when code changed, checksRun[], unresolved[], and summary.`;
    return process.stdout.write(`${JSON.stringify({ delegation, prompt }, null, 2)}\n`);
  }
  if (command === "delegate" && positional[0] === "bind") {
    const stream = await store.workstream(positional[1]);
    const event = await store.addDelegationEvent(stream.id, requireValue(flags.delegation, "Specify --delegation"), { event: "bound", taskId: requireValue(flags["task-id"], "Specify --task-id") });
    return process.stdout.write(`Bound ${event.id} to native task ${event.taskId}.\n`);
  }
  if (command === "delegate" && positional[0] === "complete") {
    const stream = await store.workstream(positional[1]);
    const delegationId = requireValue(flags.delegation, "Specify --delegation");
    const envelope = JSON.parse(await readFile(path.resolve(requireValue(flags.file, "Specify --file <completion.json>")), "utf8"));
    if (envelope.delegationId !== delegationId || !String(envelope.taskId || "").trim()) throw new Error("Completion must match the delegation and identify the native task");
    const bound = (await store.delegations(stream.id)).findLast((item) => item.id === delegationId && item.event === "bound");
    if (!bound || bound.taskId !== envelope.taskId) throw new Error("Completion taskId must match the delegation's bound native task");
    if (typeof envelope.completed !== "boolean" || !Array.isArray(envelope.checksRun) || !Array.isArray(envelope.unresolved) || !String(envelope.summary || "").trim()) throw new Error("Completion requires completed, checksRun[], unresolved[], and summary");
    if (envelope.finalHead != null && !SHA.test(envelope.finalHead)) throw new Error("finalHead must be an exact SHA");
    await store.addDelegationEvent(stream.id, delegationId, { event: "completed", taskId: envelope.taskId, completed: envelope.completed, finalHead: envelope.finalHead || null, checksRun: [...envelope.checksRun], unresolved: [...envelope.unresolved], summary: envelope.summary });
    return process.stdout.write(`Recorded completion for ${delegationId}.\n`);
  }

  if (command === "review" && positional[0] === "brief") {
    const stream = await store.workstream(positional[1]);
    const kind = requireValue(flags.kind, "Specify --kind commit|final");
    const role = requireValue(flags.role, "Specify --role");
    if (![...SOL_ROLES, "fable-challenge"].includes(role)) throw new Error("Unknown review role");
    if (kind === "commit" && role === "fable-challenge") throw new Error("Commit review uses Sol roles only");
    const target = await targetFor(stream, kind);
    const delegation = await store.addDelegation(stream.id, { type: "review", kind, role, head: target.head, baseHead: target.baseHead, ...(target.tree ? { tree: target.tree } : {}) });
    return process.stdout.write(`${JSON.stringify({ delegation, prompt: reviewPrompt(stream, delegation) }, null, 2)}\n`);
  }
  if (command === "review" && positional[0] === "bind") {
    const stream = await store.workstream(positional[1]);
    const event = await store.addDelegationEvent(stream.id, requireValue(flags.delegation, "Specify --delegation"), { event: "bound", taskId: requireValue(flags["task-id"], "Specify --task-id") });
    return process.stdout.write(`Bound review ${event.id} to ${event.taskId}.\n`);
  }
  if (command === "review" && positional[0] === "record") {
    const stream = await store.workstream(positional[1]);
    const envelope = JSON.parse(await readFile(path.resolve(requireValue(flags.file, "Specify --file <review.json>")), "utf8"));
    const delegationEvents = await store.delegations(stream.id);
    const delegation = delegationEvents.find((item) => item.id === envelope.delegationId && item.event === "created" && item.type === "review");
    const bound = delegationEvents.findLast((item) => item.id === envelope.delegationId && item.event === "bound");
    if (!bound || bound.taskId !== envelope.reviewerTaskId) throw new Error("Review task ID must match its explicit delegation binding");
    const review = await store.addReview(stream.id, validateReview(envelope, delegation));
    return process.stdout.write(`Recorded ${review.role} ${review.verdict} for ${review.kind} target ${(review.tree || review.head).slice(0, 12)}.\n`);
  }
  if (command === "review" && positional[0] === "status") {
    const stream = await store.workstream(positional[1]);
    const result = await gateFor(stream, requireValue(flags.kind, "Specify --kind commit|final"));
    return process.stdout.write(`${printGate(stream, result)}\n`);
  }

  if (command === "gate" && positional[0] === "commit") {
    const stream = await streamForCheckout(positional[1]);
    const result = await gateFor(stream, "commit");
    const output = printGate(stream, result);
    if (!result.gate.ready) throw new Error(output);
    return process.stdout.write(`${output}\n`);
  }
  if (command === "gate" && positional[0] === "publish") {
    const stream = await store.workstream(requireValue(positional[1], "Specify a workstream ID"));
    const result = await publishGate(stream);
    const lines = [`${stream.id} publish gate at ${result.target.head.slice(0, 12)}: ${result.ready ? "PUBLISHABLE" : "BLOCKED"}`, `PR #${result.pr.number}: ${result.pr.isDraft ? "draft" : "ready"}`, ...result.reasons.map((reason) => `- ${reason}`)];
    if (!result.ready) throw new Error(lines.join("\n"));
    return process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (command === "publish") {
    const stream = await store.workstream(requireValue(positional[0], "Specify a workstream ID"));
    const result = await publishGate(stream);
    if (!result.ready) throw new Error(`${stream.id} is not publishable:\n${result.reasons.map((reason) => `- ${reason}`).join("\n")}`);
    const output = await markReady(result.project, result.pr);
    await store.saveWorkstream({ ...stream }, { type: "published", text: `Marked PR #${result.pr.number} ready at ${result.target.head}`, actor: process.env.CODEX_THREAD_ID || os.userInfo().username });
    return process.stdout.write(`${output}\n`);
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
      if (preserveExisting && !existing.includes(marker) && !existing.includes("field-report-managed-pre-commit:v2")) { await access(hook); await copyFile(hook, preserved); await chmod(preserved, 0o755); }
      const temporary = `${hook}.${process.pid}.next`;
      let launcher = process.argv[1];
      try { launcher = (await exec("which", ["fr"])).stdout.trim() || launcher; } catch {}
      await writeFile(temporary, hookText(launcher, preserveExisting ? preserved : null), { mode: 0o755 });
      await rename(temporary, hook);
      return process.stdout.write(`${project.id}: installed or refreshed commit gate at ${hook}.\n`);
    }
    if (action === "uninstall") {
      if (!existing?.includes(marker)) throw new Error("Field Report commit gate is not installed");
      try { await rename(preserved, hook); } catch (error) { if (error.code === "ENOENT") await rm(hook); else throw error; }
      return process.stdout.write(`${project.id}: removed commit gate.\n`);
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
