#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const baseUrl = process.env.FIELD_REPORT_URL || "http://127.0.0.1:4177";
const stateDir = process.env.FIELD_REPORT_STATE_DIR || path.join(os.homedir(), ".local", "state", "field-report");
const stateFile = path.join(stateDir, "state.json");

function usage() {
  return `Field Report CLI (fr)

Usage:
    fr onboard [workstream-id] [--role workstream-orchestrator|reviewer|executor]
    fr coordinate <repo-id>
    fr workflow [repo-coordinator|workstream-orchestrator|executor|reviewer|all]
  fr auto-onboard
  fr status
  fr list
  fr show [workstream-id]
  fr create --repo <id> --title <title> --outcome <text> [--orchestrator <af>] [--reviewer <af>]
  fr ask [workstream-id] <question>
  fr decide [workstream-id] <Qn> <decision>
  fr checkpoint [workstream-id] [--summary <text>] [--status <state>] [--gate <text>] [--data <json>]
  fr reconcile [workstream-id] [--data <json>]
    fr assess [workstream-id]
    fr pass record [workstream-id] --head <sha> --verdict <GO|CONDITIONAL_GO|NO_GO> [--reviewer <name>] [--model <model>] [--summary <text>]
    fr delegate review [workstream-id]
  fr link issue|commit [workstream-id] <value> [--chunk <milestone-id>]
  fr reference [workstream-id] --path <repo-path> [--label <label>] [--kind plan|contract|decision|review] [--section <anchor>] [--quote <short context>]
  fr disarm
  fr watch start|stop|status [--interval <seconds>]
  fr watch --once [--send]
  fr hook session-start|stop

Natural-language agent workflows should call these commands; users should not need AF protocol syntax.`;
}

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { positional, flags };
}

async function api(method, pathname, body) {
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`Field Report is not reachable at ${baseUrl}. Start it with npm run dev.`);
  }
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(result.error || `Field Report returned ${response.status}`);
  return result;
}

async function readState() {
  try { return JSON.parse(await readFile(stateFile, "utf8")); }
  catch { return { sessions: {}, nudges: {} }; }
}

async function writeState(state) {
  await mkdir(stateDir, { recursive: true });
  const temp = `${stateFile}.${process.pid}.next`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temp, stateFile);
}

async function identity() {
  try {
    const { stdout } = await exec("af", ["whoami", "--json"], { timeout: 10_000 });
    const parsed = JSON.parse(stdout);
    return { key: parsed.session_id, actor: parsed.name || parsed.names?.[0] || parsed.session_id, kind: parsed.kind, cwd: parsed.cwd || process.cwd() };
  } catch { return { key: `cwd:${process.cwd()}`, actor: process.env.USER || "agent", kind: "unknown", cwd: process.cwd() }; }
}

async function armed() {
  const [state, who] = await Promise.all([readState(), identity()]);
  return { state, who, binding: state.sessions[who.key] || null };
}

function streamId(positional, binding) {
  return positional[0]?.includes("-") ? positional[0] : binding?.workstreamId;
}

function describe(stream) {
  const questions = (stream.questions || []).filter((question) => question.status === "open");
  const active = (stream.chunks || []).find((chunk) => ["blocked", "active", "planned"].includes(chunk.status));
  const references = (stream.references || []).slice(0, 3);
  const referenceContext = references.length ? `\nReference context:\n${references.map((reference) => `- ${reference.label || reference.path} (${reference.path})${reference.quote ? `: “${reference.quote}”` : ""}`).join("\n")}` : "\nReference context: none";
  return `${stream.id}\n${stream.title}\nStatus: ${stream.status} · Gate: ${stream.reviewState || "not recorded"}\nNext: ${active?.title || "outcome delivered"}\nOpen questions: ${questions.length}\nBranch: ${stream.branch || "not assigned"}${referenceContext}`;
}

async function onboard(id, role = "orchestrator") {
  if (!id) throw new Error("Specify a workstream ID, or use fr auto-onboard from a matching branch");
  role = role === "orchestrator" ? "workstream-orchestrator" : role;
  if (!["workstream-orchestrator", "executor", "reviewer"].includes(role)) throw new Error("Role must be workstream-orchestrator, executor, or reviewer");
  const stream = await api("GET", `/api/workstreams/${encodeURIComponent(id)}`);
  const workflow = await api("GET", `/api/workflow?role=${encodeURIComponent(role)}`);
  const { state, who } = await armed();
  state.sessions[who.key] = { workstreamId: stream.id, role, actor: who.actor, cwd: who.cwd, armedAt: new Date().toISOString() };
  await writeState(state);
  await api("POST", `/api/workstreams/${encodeURIComponent(id)}/events`, { type: "onboard", actor: who.actor, text: `${who.actor} armed as ${role}` });
  process.stdout.write(`Armed ${stream.id} as ${role}.\n${describe(stream)}\n\n${workflow.markdown}\n`);
}

async function coordinate(projectId) {
  if (!projectId) throw new Error("Specify a repository ID");
  const [data, context, workflow] = await Promise.all([api("GET", "/data/current.json"), armed(), api("GET", "/api/workflow?role=repo-coordinator")]);
  const project = data.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Unknown repository: ${projectId}`);
  context.state.sessions[context.who.key] = { projectId, role: "repo-coordinator", actor: context.who.actor, cwd: context.who.cwd, armedAt: new Date().toISOString() };
  await writeState(context.state);
  process.stdout.write(`Coordinating ${project.label} as repo-coordinator.\n${project.metrics?.activeWorkstreams || 0} active workstreams · ${project.metrics?.openPrs || 0} open PRs · ${project.metrics?.openQuestions || 0} open questions.\n\n${workflow.markdown}\n`);
}

async function autoOnboard() {
  const [data, who] = await Promise.all([api("GET", "/data/current.json"), identity()]);
  let branch = null;
  try { branch = (await exec("git", ["branch", "--show-current"], { cwd: who.cwd, timeout: 10_000 })).stdout.trim(); } catch {}
  const projectIds = data.projects.filter((project) => who.cwd.startsWith(project.repoPath)).map((project) => project.id);
  const matches = data.workstreams.filter((stream) => projectIds.includes(stream.project) && branch && stream.branch === branch);
  if (matches.length === 1) return onboard(matches[0].id, "workstream-orchestrator");
  process.stdout.write(matches.length > 1 ? "Multiple Field Report workstreams match this branch; run fr onboard <id>.\n" : "No exact Field Report workstream matches this session; not armed.\n");
}

function patchFrom(flags) {
  let patch = {};
  if (flags.data) patch = JSON.parse(flags.data.startsWith("@") ? "{}" : flags.data);
  if (flags.data?.startsWith("@")) throw new Error("@file input is not supported yet; pass JSON directly");
  if (flags.summary) patch.summary = flags.summary;
  if (flags.status) patch.status = flags.status;
  if (flags.gate) patch.reviewState = flags.gate;
  if (flags.branch) patch.branch = flags.branch;
  if (flags.pr) patch.prs = String(flags.pr).split(",").map((number) => ({ number: Number(number), chunks: [] }));
  return patch;
}

async function nudge(send) {
  const [data, state] = await Promise.all([api("GET", "/data/current.json"), readState()]);
  const now = Date.now();
  const candidates = data.workstreams.flatMap((stream) => {
    const reasons = [];
    if (stream.assessment?.stale) reasons.push("reviewer assessment is stale after a head change");
    if ((stream.questions || []).some((question) => question.status === "open")) reasons.push("an uncertainty remains open");
    const updated = new Date(stream.updatedAt || 0).getTime();
    if (["active", "blocked"].includes(stream.status) && now - updated > 12 * 3600_000) reasons.push("the canonical situation is older than 12 hours");
    return reasons.length && (stream.orchestrator || stream.fableAgent) ? [{ stream, reasons }] : [];
  }).filter(({ stream }) => now - new Date(state.nudges[stream.id] || 0).getTime() > 2 * 3600_000);
  if (!candidates.length) { process.stdout.write("No Field Report nudges are due.\n"); return; }
  for (const { stream, reasons } of candidates) {
    const subject = `[FR_NUDGE ${stream.id}] Reconciliation requested`;
    const body = `Field Report detected: ${reasons.join("; ")}. Run fr onboard ${stream.id} if needed, reconcile current evidence, then publish only material changes with fr checkpoint or fr reconcile.`;
    if (send) {
      await exec("af", ["inbox", "send", stream.orchestrator || stream.fableAgent, subject, "--body", body], { timeout: 30_000 });
      state.nudges[stream.id] = new Date().toISOString();
    }
    process.stdout.write(`${send ? "Sent" : "Due"}: ${stream.id} -> ${stream.orchestrator || stream.fableAgent}: ${reasons.join("; ")}\n`);
  }
  if (send) await writeState(state);
}

async function main() {
  const command = process.argv[2] || "help";
  const { positional, flags } = parse(process.argv.slice(3));
  const context = await armed();
  const id = streamId(positional, context.binding);
  if (["help", "--help", "-h"].includes(command)) return process.stdout.write(`${usage()}\n`);
  if (command === "list") {
    const result = await api("GET", "/api/workstreams");
    return process.stdout.write(`${result.workstreams.map((stream) => `${stream.id}\t${stream.status}\t${stream.title}`).join("\n")}\n`);
  }
    if (command === "onboard") return onboard(positional[0], flags.role || "orchestrator");
    if (command === "coordinate") return coordinate(positional[0]);
    if (command === "workflow") {
      const role = positional[0] || context.binding?.role || "shared";
      const workflow = await api("GET", `/api/workflow?role=${encodeURIComponent(role)}`);
      return process.stdout.write(`${workflow.markdown}\n`);
    }
  if (command === "auto-onboard") return autoOnboard();
    if (command === "status") {
      if (!context.binding) return process.stdout.write("This session is not armed. Run fr onboard <workstream-id>.\n");
      if (context.binding.projectId) {
        const [data, workflow] = await Promise.all([api("GET", "/data/current.json"), api("GET", `/api/workflow?role=${encodeURIComponent(context.binding.role)}`)]);
        const project = data.projects.find((candidate) => candidate.id === context.binding.projectId);
        return process.stdout.write(`Coordinating ${project?.label || context.binding.projectId} as ${context.binding.role} since ${context.binding.armedAt}.\n\n${workflow.markdown}\n`);
      }
    const stream = await api("GET", `/api/workstreams/${encodeURIComponent(context.binding.workstreamId)}`);
    return process.stdout.write(`Armed as ${context.binding.role} since ${context.binding.armedAt}.\n${describe(stream)}\n`);
  }
  if (command === "show") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    const stream = await api("GET", `/api/workstreams/${encodeURIComponent(id)}`);
    return process.stdout.write(flags.json ? `${JSON.stringify(stream, null, 2)}\n` : `${describe(stream)}\n`);
  }
  if (command === "create") {
    const result = await api("POST", "/api/workstreams", { project: flags.repo, id: flags.id, title: flags.title, outcome: flags.outcome, summary: flags.outcome, orchestrator: flags.orchestrator, reviewer: flags.reviewer, branch: flags.branch, updatedBy: context.who.actor });
    process.stdout.write(`Created ${result.workstream.id}.\n`);
    if (!flags["no-onboard"]) await onboard(result.workstream.id, "orchestrator");
    return;
  }
  if (command === "ask") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    const offset = positional[0] === id ? 1 : 0;
    const text = positional.slice(offset).join(" ");
    const result = await api("POST", `/api/workstreams/${encodeURIComponent(id)}/questions`, { text, actor: context.who.actor });
    return process.stdout.write(`Recorded ${result.result.id}: ${result.result.text}\n`);
  }
  if (command === "decide") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    const offset = positional[0] === id ? 1 : 0;
    const questionId = positional[offset];
    const text = positional.slice(offset + 1).join(" ");
    const result = await api("POST", `/api/workstreams/${encodeURIComponent(id)}/decisions`, { questionId, text, actor: context.who.actor });
    return process.stdout.write(`Resolved ${result.result.id}: ${result.result.answer}\n`);
  }
  if (["update", "checkpoint", "reconcile"].includes(command)) {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    const patch = patchFrom(flags);
    patch.updatedBy = context.who.actor;
    patch.eventType = command === "update" ? "updated" : command;
    patch.eventText = flags.note || `${command} by ${context.who.actor}`;
    const result = await api("PATCH", `/api/workstreams/${encodeURIComponent(id)}`, patch);
    return process.stdout.write(`Updated ${result.workstream.id}.\n${describe(result.workstream)}\n`);
  }
    if (command === "assess") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    const result = await api("POST", "/api/assessments/request", { workstreamIds: [id] });
    return process.stdout.write(`Requested assessment from ${result.requested[0].recipient} for ${id}.\n`);
  }
  if (command === "link") {
    const kind = positional[0];
    const explicitId = positional[1]?.includes("-") ? positional[1] : null;
    const targetId = explicitId || context.binding?.workstreamId;
    const value = positional[explicitId ? 2 : 1];
    if (!targetId || !value || !["issue", "commit"].includes(kind)) throw new Error("Use fr link issue|commit [workstream-id] <value>");
    const stream = await api("GET", `/api/workstreams/${encodeURIComponent(targetId)}`);
    let patch;
    if (kind === "issue") patch = { issuePrefixes: [...new Set([...(stream.issuePrefixes || []), value])] };
    else if (flags.chunk) {
      patch = { chunks: (stream.chunks || []).map((chunk) => chunk.id === flags.chunk ? { ...chunk, commits: [...new Set([...(chunk.commits || []), value])] } : chunk) };
    } else patch = { commits: [...new Set([...(stream.commits || []), value])] };
    patch.updatedBy = context.who.actor;
    patch.eventType = "updated";
    patch.eventText = `Linked ${kind} ${value}`;
    await api("PATCH", `/api/workstreams/${encodeURIComponent(targetId)}`, patch);
    return process.stdout.write(`Linked ${kind} ${value} to ${targetId}.\n`);
  }
  if (command === "reference") {
    if (!id || !flags.path) throw new Error("Specify a workstream and --path");
    const stream = await api("GET", `/api/workstreams/${encodeURIComponent(id)}`);
    const reference = { path: flags.path, label: flags.label || flags.path, kind: flags.kind || "plan", ...(flags.section ? { section: flags.section } : {}), ...(flags.quote ? { quote: flags.quote } : {}) };
    await api("PATCH", `/api/workstreams/${encodeURIComponent(id)}`, { references: [...(stream.references || []), reference], updatedBy: context.who.actor, eventType: "updated", eventText: `Linked ${reference.kind} reference ${reference.path}` });
    return process.stdout.write(`Linked ${reference.path} to ${id}.\n`);
  }
  if (command === "pass" && positional[0] === "record") {
    const targetId = positional[1] || context.binding?.workstreamId;
    if (!targetId) throw new Error("Specify a workstream ID or arm this session");
    const result = await api("POST", `/api/workstreams/${encodeURIComponent(targetId)}/passes`, {
      head: flags.head,
      verdict: flags.verdict,
      reviewer: flags.reviewer || context.who.actor,
      model: flags.model,
      summary: flags.summary,
      mergeReadiness: flags.merge,
      structuralRisk: flags.structural,
      outcomeConfidence: flags["outcome-confidence"],
      necessity: flags.necessity,
      simplerPath: flags["simpler-path"],
      scopeDrift: flags["scope-drift"],
      contractIntegrity: flags["contract-integrity"],
      evidenceQuality: flags["evidence-quality"]
    });
    return process.stdout.write(`Recorded review pass ${result.event.metadata.passId} for ${targetId} at ${result.event.metadata.head.slice(0, 8)}.\n`);
  }
  if (command === "delegate" && positional[0] === "review") {
    const targetId = positional[1] || context.binding?.workstreamId;
    if (!targetId) throw new Error("Specify a workstream ID or arm this session");
    const result = await api("POST", "/api/assessments/request", { workstreamIds: [targetId] });
    return process.stdout.write(`Requested delegated review from ${result.requested[0].recipient} for ${targetId}.\n`);
  }
  if (command === "disarm") {
    if (!context.binding) return process.stdout.write("This session is not armed.\n");
    if (context.binding.workstreamId) await api("POST", `/api/workstreams/${encodeURIComponent(context.binding.workstreamId)}/events`, { type: "disarm", actor: context.who.actor, text: `${context.who.actor} disarmed ${context.binding.workstreamId}` });
    const target = context.binding.workstreamId || context.binding.projectId;
    delete context.state.sessions[context.who.key];
    await writeState(context.state);
    return process.stdout.write(`Disarmed ${target}.\n`);
  }
  if (command === "watch") {
    const interval = Math.max(60, Number(flags.interval || 300));
    if (positional[0] === "start") {
      const state = await readState();
      if (state.watch?.pid) {
        try { process.kill(state.watch.pid, 0); return process.stdout.write(`Field Report watcher is already running (PID ${state.watch.pid}).\n`); } catch {}
      }
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "watch", "--send", "--interval", String(interval), "--daemon"], { detached: true, stdio: "ignore", env: process.env });
      child.unref();
      state.watch = { pid: child.pid, interval, startedAt: new Date().toISOString() };
      await writeState(state);
      return process.stdout.write(`Started Field Report watcher (PID ${child.pid}, every ${interval}s).\n`);
    }
    if (positional[0] === "stop") {
      const state = await readState();
      if (!state.watch?.pid) return process.stdout.write("Field Report watcher is not running.\n");
      try { process.kill(state.watch.pid, "SIGTERM"); } catch {}
      delete state.watch;
      await writeState(state);
      return process.stdout.write("Stopped Field Report watcher.\n");
    }
    if (positional[0] === "status") {
      const state = await readState();
      if (!state.watch?.pid) return process.stdout.write("Field Report watcher is not running.\n");
      try { process.kill(state.watch.pid, 0); return process.stdout.write(`Field Report watcher is running (PID ${state.watch.pid}, every ${state.watch.interval}s).\n`); }
      catch { delete state.watch; await writeState(state); return process.stdout.write("Field Report watcher was stale and has been cleared.\n"); }
    }
    do { await nudge(Boolean(flags.send)); if (flags.once || !flags.interval) break; await new Promise((resolve) => setTimeout(resolve, interval * 1000)); } while (true);
    return;
  }
  if (command === "hook") {
    if (positional[0] === "session-start") {
      try { return await autoOnboard(); } catch { return; }
    }
      if (positional[0] === "stop") {
        try { if (context.binding?.workstreamId) await api("POST", `/api/workstreams/${encodeURIComponent(context.binding.workstreamId)}/events`, { type: "checkpoint", actor: context.who.actor, text: "Agent session stopped; semantic reconciliation may be due" }); } catch {}
      return;
    }
    throw new Error("Hook must be session-start or stop");
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => { console.error(`fr: ${error.message}`); process.exitCode = 1; });
