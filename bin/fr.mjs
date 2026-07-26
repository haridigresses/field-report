#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createFieldReportStore } from "../src/store.mjs";
import { evaluateRelease } from "../src/release.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createFieldReportStore(process.env.FIELD_REPORT_ROOT || root);
const baseUrl = process.env.FIELD_REPORT_URL || "http://127.0.0.1:4177";
const stateDir = process.env.FIELD_REPORT_STATE_DIR || path.join(os.homedir(), ".local", "state", "field-report");
const stateFile = path.join(stateDir, "state.json");

function usage() {
  return `Field Report CLI (fr)

Usage:
    fr onboard [workstream-id] [--role workstream-orchestrator|reviewer|executor]
    fr coordinate <repo-id>
    fr context [workstream-id|repo-id]
    fr catchup [repo-id] [--peek] [--since <iso-time>]
    fr mrr [workstream-id]
    fr release-check [workstream-id]
    fr hold [workstream-id] --reason <publication blocker>
    fr unhold [workstream-id]
    fr commit-review record [workstream-id] --tree <staged-tree-sha> --base-head <sha> --role deep-code-review|structural-challenge --summary <text>
    fr commit-check [workstream-id]
    fr commit [workstream-id] --message <message>
    fr policy [workstream-id] --mode full|single-independent|delta|none --user-authorized [--reason <text>]
    fr workflow [repo-coordinator|workstream-orchestrator|executor|reviewer|all]
  fr auto-onboard
  fr status
  fr list
  fr show [workstream-id]
  fr create --repo <id> --title <title> --outcome <text> [--orchestrator <codex-task-uuid>]
  fr session alias <alias> [--id <codex-task-uuid>]
  fr session list
  fr assign [workstream-id] --session <alias-or-uuid>
  fr ask [workstream-id] <question>
  fr decide [workstream-id] <Qn> <decision>
  fr checkpoint [workstream-id] [--summary <text>] [--status <state>] [--gate <text>] [--data <json>]
  fr reconcile [workstream-id] [--data <json>]
    fr assess [workstream-id]
    fr pass record [workstream-id] --head <sha> --verdict <GO|CONDITIONAL_GO|NO_GO> [--role deep-code-review|structural-challenge] [--scope full|delta] [--base-head <sha>] [--reviewer <name>] [--model <model>] [--route <provider-route>] [--summary <text>]
    fr pass import [workstream-id] --data <json> | --file <path>
  fr link issue|commit [workstream-id] <value> [--chunk <milestone-id>]
  fr reference [workstream-id] --path <repo-path> [--label <label>] [--kind plan|contract|decision|review] [--section <anchor>] [--quote <short context>]
  fr disarm
  fr watch --once
  fr hook session-start|stop

  Natural-language agent workflows should use Codex-native delegation and messaging. AF is reserved for issue tracking.`;
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
  if (!process.env.FIELD_REPORT_URL) return localApi(method, pathname, body);
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

async function localApi(method, pathname, body) {
  const requestUrl = new URL(pathname, "http://local");
  pathname = requestUrl.pathname;
  if (method === "GET" && pathname === "/data/current.json") {
    try { return JSON.parse(await readFile(path.join(process.env.FIELD_REPORT_ROOT || root, "data", "current.json"), "utf8")); }
    catch { throw new Error("No collected Field Report projection exists. Run npm run refresh from the Field Report repo."); }
  }
  if (method === "GET" && pathname.startsWith("/api/workflow")) {
    const role = requestUrl.searchParams.get("role") || "shared";
    return { role, markdown: await store.workflowContract(role) };
  }
  if (method === "GET" && pathname === "/api/workstreams") return { workstreams: await store.listCanonicalWorkstreams() };
  if (method === "POST" && pathname === "/api/workstreams") return { workstream: await store.createWorkstream(body) };
  if (method === "GET" && pathname === "/api/sessions") return { sessions: await store.listSessions() };
  if (method === "POST" && pathname === "/api/sessions") return { session: await store.saveSessionAlias(body) };
  if (method === "POST" && pathname === "/api/assessments/request") return { requested: await store.prepareAssessmentBriefs(body.workstreamIds) };
  const match = pathname.match(/^\/api\/workstreams\/([^/]+)(?:\/(events|questions|decisions|passes|commit-reviews|commit-panel|mrr))?$/);
  if (!match) throw new Error(`Unsupported local Field Report operation: ${method} ${pathname}`);
  const id = decodeURIComponent(match[1]);
  const action = match[2];
  if (method === "GET" && action === "mrr") return store.mrrStatus(id, requestUrl.searchParams.get("head"));
  if (method === "GET" && action === "commit-panel") return store.commitPanelStatus(id, requestUrl.searchParams.get("tree"), requestUrl.searchParams.get("baseHead"));
  if (method === "GET" && !action) return (await store.findWorkstream(id)).stream;
  if (method === "PATCH" && !action) return { workstream: await store.updateWorkstream(id, body, body.eventType || "updated") };
  if (method === "POST" && action === "events") return { result: await store.appendWorkstreamEvent(id, body) };
  if (method === "POST" && action === "questions") return { result: await store.recordQuestion(id, body) };
  if (method === "POST" && action === "decisions") return { result: await store.recordDecision(id, body) };
  if (method === "POST" && action === "passes") {
    if (Array.isArray(body.passes)) return { events: await store.recordReviewPasses(id, body.passes) };
    return { event: await store.recordReviewPass(id, body) };
  }
  if (method === "POST" && action === "commit-reviews") return { event: await store.recordCommitReview(id, body) };
  throw new Error(`Unsupported local Field Report operation: ${method} ${pathname}`);
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
  const cwd = process.env.FIELD_REPORT_CWD || process.cwd();
  const sessionId = process.env.FIELD_REPORT_SESSION_ID || process.env.CODEX_THREAD_ID || null;
  if (!sessionId) return { key: `cwd:${cwd}`, actor: process.env.USER || "agent", kind: "unknown", cwd };
  const registered = await store.resolveSession(sessionId);
  return { key: sessionId, actor: registered?.alias || sessionId, kind: registered?.kind || "codex", cwd };
}

async function armed() {
  const [state, who] = await Promise.all([readState(), identity()]);
  return { state, who, binding: state.sessions[who.key] || null };
}

async function checkoutContext(cwd) {
  try {
    const [rootResult, branchResult, headResult, commonResult, statusResult] = await Promise.all([
      exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 }),
      exec("git", ["branch", "--show-current"], { cwd, timeout: 10_000 }),
      exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 }),
      exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: 10_000 }),
      exec("git", ["status", "--porcelain"], { cwd, timeout: 10_000 })
    ]);
    const repoRoot = rootResult.stdout.trim();
    const branch = branchResult.stdout.trim() || "HEAD";
    const head = headResult.stdout.trim();
    const gitCommonDir = commonResult.stdout.trim();
    return { repoRoot, branch, head, gitCommonDir, dirty: Boolean(statusResult.stdout.trim()) };
  } catch { return { repoRoot: null, branch: null, head: null, gitCommonDir: null, dirty: null }; }
}

function projectForCwd(data, cwd) {
  return (data.projects || [])
    .filter((project) => project.repoPath && (cwd === project.repoPath || cwd.startsWith(`${project.repoPath}${path.sep}`)))
    .sort((left, right) => right.repoPath.length - left.repoPath.length)[0] || null;
}

async function projectForGitCommonDir(data, gitCommonDir) {
  if (!gitCommonDir) return null;
  let normalized;
  try { normalized = await realpath(gitCommonDir); } catch { normalized = path.resolve(gitCommonDir); }
  for (const project of data.projects || []) {
    if (!project.repoPath) continue;
    let projectGit;
    try { projectGit = await realpath(path.resolve(project.repoPath, ".git")); } catch { projectGit = path.resolve(project.repoPath, ".git"); }
    if (projectGit === normalized) return project;
  }
  return null;
}

function resolveProject(data, value, cwd) {
  if (value) {
    const normalized = String(value).toLowerCase();
    const matches = (data.projects || []).filter((project) => [project.id, project.label, path.basename(project.repoPath || "")].filter(Boolean).some((candidate) => String(candidate).toLowerCase() === normalized));
    if (matches.length === 1) return matches[0];
    return null;
  }
  return projectForCwd(data, cwd);
}

async function inferredContext(context) {
  const data = await api("GET", "/data/current.json");
  const checkout = await checkoutContext(context.who.cwd);
  const project = projectForCwd(data, context.who.cwd) || projectForCwd(data, checkout.repoRoot) || await projectForGitCommonDir(data, checkout.gitCommonDir);
  const matches = project && checkout.branch && checkout.branch !== "HEAD"
    ? data.workstreams.filter((stream) => stream.project === project.id && stream.branch === checkout.branch)
    : [];
  return { data, checkout, project, stream: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}

function streamId(positional, binding, position = 0) {
  const candidate = positional[position];
  if (!candidate) return binding?.workstreamId || null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(candidate) ? candidate : binding?.workstreamId || null;
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
  const context = await armed();
  if (context.binding?.role === "repo-coordinator") throw new Error("Repository coordinators remain bound as a relay and monitoring role; end or replace the task to change that assignment");
  role = role === "orchestrator" ? "workstream-orchestrator" : role;
  if (!["workstream-orchestrator", "executor", "reviewer"].includes(role)) throw new Error("Role must be workstream-orchestrator, executor, or reviewer");
  const stream = await api("GET", `/api/workstreams/${encodeURIComponent(id)}`);
  const owner = stream.orchestrator ? await store.resolveSession(stream.orchestrator) : null;
  if (role === "workstream-orchestrator" && (owner?.id || stream.orchestrator) !== context.who.key) throw new Error("Workstream-orchestrator onboarding requires the exact durable task assignment; use fr assign first");
  const workflow = await api("GET", `/api/workflow?role=${encodeURIComponent(role)}`);
  const { state, who } = context;
  state.sessions[who.key] = { workstreamId: stream.id, role, actor: who.actor, cwd: who.cwd, armedAt: new Date().toISOString() };
  await writeState(state);
  await api("POST", `/api/workstreams/${encodeURIComponent(id)}/events`, { type: "onboard", actor: who.actor, text: `${who.actor} armed as ${role}` });
  process.stdout.write(`Armed ${stream.id} as ${role}.\n${describe(stream)}\n\n${workflow.markdown}\n`);
}

async function coordinate(projectId) {
  const [data, context, workflow] = await Promise.all([api("GET", "/data/current.json"), armed(), api("GET", "/api/workflow?role=repo-coordinator")]);
  const project = resolveProject(data, projectId, context.who.cwd);
  if (!project) throw new Error(`Unknown repository: ${projectId}`);
  if (context.binding?.role === "repo-coordinator" && context.binding.projectId !== project.id) throw new Error("Repository coordinators remain bound to one repository; the user must start a separate coordinator task for another repository");
  projectId = project.id;
  context.state.sessions[context.who.key] = { projectId, role: "repo-coordinator", actor: context.who.actor, cwd: context.who.cwd, armedAt: new Date().toISOString() };
  await writeState(context.state);
  const report = await catchup(projectId, { data, context });
  process.stdout.write(`Coordinating ${project.label} as repo-coordinator.\n${project.metrics?.activeWorkstreams || 0} active workstreams · ${project.metrics?.openPrs || 0} open PRs · ${project.metrics?.openQuestions || 0} open questions.\n\n${report}\n\n${workflow.markdown}\n`);
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function compact(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function activityAt(stream) {
  return Math.max(
    timestamp(stream.updatedAt),
    ...(stream.timeline || []).map((event) => timestamp(event.at)),
    ...(stream.prs || []).map((pr) => timestamp(pr.updatedAt)),
    ...(stream.questions || []).flatMap((question) => [timestamp(question.askedAt), timestamp(question.answeredAt)])
  );
}

function attentionReasons(stream) {
  const reasons = [];
  const openQuestions = (stream.questions || []).filter((question) => question.status === "open").length;
  const failingChecks = (stream.prs || []).flatMap((pr) => pr.statusCheckRollup || []).filter((check) => check.conclusion === "FAILURE" || check.state === "FAILURE").length;
  const mergeBlocked = (stream.prs || []).some((pr) => pr.state === "OPEN" && pr.mergeStateStatus === "BLOCKED");
  if (stream.status === "blocked") reasons.push("blocked");
  if (failingChecks) reasons.push(`${failingChecks} failing check${failingChecks === 1 ? "" : "s"}`);
  if (mergeBlocked) reasons.push("merge blocked");
  if (openQuestions) reasons.push(`${openQuestions} open question${openQuestions === 1 ? "" : "s"}`);
  if (stream.assessment?.stale) reasons.push("review stale");
  if (stream.assessmentRequest?.pending) reasons.push("review requested");
  if (/authori[sz]ation|merge authority|required approval|awaiting approval|user decision|hold/i.test(stream.reviewState || "")) reasons.push("decision needed");
  if (/exact[- ]head review|review.*pending|pending.*review/i.test(stream.reviewState || "")) reasons.push("review due");
  if (["active", "blocked"].includes(stream.status) && Date.now() - timestamp(stream.updatedAt) > 12 * 3600_000) reasons.push("status older than 12h");
  return [...new Set(reasons)];
}

function deliverySummary(stream) {
  const pr = (stream.prs || []).find((candidate) => candidate.state === "OPEN" && candidate.headRefName === stream.branch) || (stream.prs || []).find((candidate) => candidate.state === "OPEN");
  if (pr) return `PR #${pr.number} ${String(pr.state || "").toLowerCase()}${pr.headRefOid ? ` @ ${pr.headRefOid.slice(0, 8)}` : ""}`;
  const completed = (stream.chunks || []).filter((chunk) => chunk.status === "complete").length;
  return `pre-PR · ${completed}/${(stream.chunks || []).length} milestones`;
}

function catchupEntry(stream) {
  const reasons = attentionReasons(stream);
  const next = (stream.chunks || []).find((chunk) => ["blocked", "active", "planned"].includes(chunk.status))?.title || "Outcome delivered";
  return `${reasons.length ? "!" : "•"} ${stream.title} — ${stream.status}${reasons.length ? ` · ${reasons.join(", ")}` : ""}\n  Gate: ${compact(stream.reviewState || "No gate recorded")}\n  Next: ${compact(next, 120)} · ${deliverySummary(stream)} · updated ${new Date(activityAt(stream)).toLocaleString()}`;
}

async function catchup(projectId, options = {}) {
  const data = options.data || await api("GET", "/data/current.json");
  const context = options.context || await armed();
  projectId ||= context.binding?.projectId;
  const project = resolveProject(data, projectId, context.who.cwd);
  if (!project) throw new Error(projectId ? `Unknown repository: ${projectId}` : "No Field Report repository matches this checkout; specify an exact ID");
  projectId = project.id;
  context.state.coordinatorCursors ||= {};
  const sinceValue = options.since || context.state.coordinatorCursors[projectId] || null;
  const since = timestamp(sinceValue);
  const streams = data.workstreams.filter((stream) => stream.project === projectId);
  const changed = streams.filter((stream) => since ? activityAt(stream) > since : stream.status !== "complete").sort((left, right) => activityAt(right) - activityAt(left));
  const attention = streams.filter((stream) => stream.status !== "complete" && attentionReasons(stream).length).sort((left, right) => activityAt(right) - activityAt(left));
  const changedIds = new Set(changed.map((stream) => stream.id));
  const additionalAttention = attention.filter((stream) => !changedIds.has(stream.id));
  const lines = [`Catch-up for ${project.label}${sinceValue ? ` since ${new Date(since).toLocaleString()}` : " · initial orientation"}`];
  lines.push("", sinceValue ? "Changed:" : "Active outcomes:", changed.length ? changed.map(catchupEntry).join("\n") : "No semantic or delivery changes since the last catch-up.");
  lines.push("", "Other attention still open:", additionalAttention.length ? additionalAttention.map(catchupEntry).join("\n") : attention.length ? "All current attention items are included above." : "Nothing currently needs coordinator attention.");
  if (!options.peek) {
    context.state.coordinatorCursors[projectId] = data.generatedAt || new Date().toISOString();
    await writeState(context.state);
  }
  return lines.join("\n");
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

async function contextReport(context, candidate) {
  const inferred = await inferredContext(context);
  const explicitStream = candidate && inferred.data.workstreams.find((stream) => stream.id === candidate);
  const explicitProject = candidate && !explicitStream ? resolveProject(inferred.data, candidate, context.who.cwd) : null;
  const boundStream = context.binding?.workstreamId && inferred.data.workstreams.find((stream) => stream.id === context.binding.workstreamId);
  const boundProject = context.binding?.projectId && inferred.data.projects.find((project) => project.id === context.binding.projectId);
  const stream = explicitStream || boundStream || inferred.stream;
  const project = explicitProject || boundProject || (stream && inferred.data.projects.find((item) => item.id === stream.project)) || inferred.project;
  if (!project && !stream) throw new Error("No Field Report repository or workstream matches this checkout; specify an exact ID");
  const lines = [
    `Repository: ${project?.label || project?.id || "unknown"}${project?.id ? ` (${project.id})` : ""}`,
    `Checkout: ${inferred.checkout.branch || "detached/unknown"}${inferred.checkout.head ? ` @ ${inferred.checkout.head.slice(0, 8)}` : ""}`,
    `Role: ${context.binding?.role || "not armed"}`
  ];
  if (stream) {
    const mrr = await api("GET", `/api/workstreams/${encodeURIComponent(stream.id)}/mrr`);
    const next = (stream.chunks || []).find((chunk) => ["blocked", "active", "planned"].includes(chunk.status))?.title || "Outcome delivered";
    const reasons = attentionReasons(stream);
    lines.push(
      `Workstream: ${stream.id} — ${stream.title}`,
      `State: ${stream.status}${reasons.length ? ` · ${reasons.join(", ")}` : ""}`,
      `Gate: ${compact(stream.reviewState || "No gate recorded")}`,
      `Next: ${compact(next, 140)}`,
      `Delivery: ${deliverySummary(stream)}`,
      `MRR: ${mrr.required ? (mrr.ready ? "READY" : `NOT READY — ${compact((mrr.reasons || []).join("; "), 180)}`) : "not required"}`
    );
  } else {
    const active = inferred.data.workstreams.filter((item) => item.project === project.id && item.status !== "complete");
    const attention = active.filter((item) => attentionReasons(item).length);
    lines.push(`Portfolio: ${active.length} active · ${attention.length} need attention`, "Run `fr catchup` for the changed and attention queues.");
    if (inferred.ambiguous) lines.push("Multiple workstreams match this branch; specify an exact workstream ID.");
  }
  return lines.join("\n");
}

async function reviewEnvelope(flags) {
  if (flags.data && flags.file) throw new Error("Use either --data or --file for a review envelope");
  if (!flags.data && !flags.file) throw new Error("Provide a review envelope with --data <json> or --file <path>");
  const raw = flags.file ? await readFile(path.resolve(process.cwd(), flags.file), "utf8") : flags.data;
  const envelope = JSON.parse(raw);
  const passes = Array.isArray(envelope) ? envelope : Array.isArray(envelope.passes) ? envelope.passes : [envelope];
  if (!passes.length) throw new Error("Review envelope contains no passes");
  return { envelope, passes };
}

function reviewPassBody(pass, envelope, context) {
  const complete = pass.reviewComplete ?? pass.review_complete ?? envelope.reviewComplete ?? envelope.review_complete;
  if (complete !== true) throw new Error("Review import requires explicit review_complete: true");
  const independent = pass.independent ?? envelope.independent;
  if (independent !== true) throw new Error("Review import requires explicit independent: true");
  const route = pass.route || envelope.route;
  const evidenceDigest = pass.evidenceDigest || pass.evidence_digest || envelope.evidenceDigest || envelope.evidence_digest;
  const provider = pass.provider || envelope.provider;
  const model = pass.model || envelope.model;
  const fableImport = ["anthropic.claude-fable-5", "claude-fable-5"].includes(model);
  if (fableImport && !(provider === "anthropic" && route === "claude-aws" && /^[0-9a-f]{64}$/i.test(evidenceDigest || ""))) throw new Error("Fable import requires provider anthropic, route claude-aws, and a SHA-256 raw-evidence digest");
  return {
    head: pass.head || envelope.head,
    verdict: pass.verdict,
    reviewer: pass.reviewer || envelope.reviewer || context.who.actor,
    model,
    reasoning: pass.reasoning || envelope.reasoning,
    reviewRole: pass.reviewRole || pass.review_role || pass.role,
    reviewScope: pass.reviewScope || pass.review_scope || pass.scope,
    baseHead: pass.baseHead || pass.base_head || envelope.baseHead || envelope.base_head,
    summary: pass.summary,
    mergeReadiness: pass.mergeReadiness ?? pass.merge_readiness ?? pass.merge,
    structuralRisk: pass.structuralRisk ?? pass.structural_risk ?? pass.structural,
    outcomeConfidence: pass.outcomeConfidence ?? pass.outcome_confidence,
    necessity: pass.necessity,
    simplerPath: pass.simplerPath || pass.simpler_path,
    scopeDrift: pass.scopeDrift || pass.scope_drift,
    contractIntegrity: pass.contractIntegrity || pass.contract_integrity,
    evidenceQuality: pass.evidenceQuality || pass.evidence_quality,
    reviewerId: pass.reviewerId || pass.reviewer_id || envelope.reviewerId || envelope.reviewer_id,
    provider,
    route,
    provenanceVerified: fableImport,
    evidenceDigest,
    independent,
    findings: pass.findings,
    unresolved: pass.unresolved
  };
}

async function deterministicEvidence(stream, context) {
  const inferred = await inferredContext(context);
  if (!inferred.project || inferred.project.id !== stream.project) return {};
  const { branch, head } = inferred.checkout;
  if (!/^[0-9a-f]{40}$/i.test(head || "") || branch === "HEAD") return {};
  if (stream.branch && stream.branch !== branch) return {};
  return { ...(stream.branch ? {} : { branch }), commits: [...new Set([...(stream.commits || []), head])] };
}

async function liveReleaseEvidence(stream, context) {
  const inferred = await inferredContext(context);
  const checkout = inferred.checkout;
  if (!inferred.project || inferred.project.id !== stream.project) throw new Error(`Current checkout does not match repository ${stream.project}`);
  if (!stream.branch) return { checkout, remoteHead: null, pr: null };
  let remoteHead = null;
  try {
    const result = await exec("git", ["ls-remote", "--heads", "origin", `refs/heads/${stream.branch}`], { cwd: checkout.repoRoot, timeout: 30_000 });
    remoteHead = result.stdout.trim().split(/\s+/)[0] || null;
  } catch (error) {
    throw new Error(`Could not resolve the live origin head for ${stream.branch}: ${error.stderr?.trim() || error.message}`);
  }
  let pr = null;
  try {
    const result = await exec("gh", ["pr", "view", stream.branch, "--json", "number,state,isDraft,headRefName,headRefOid"], { cwd: checkout.repoRoot, timeout: 30_000 });
    pr = JSON.parse(result.stdout);
  } catch (error) {
    if (!/no pull requests found|Could not resolve to a PullRequest/i.test(`${error.stdout || ""} ${error.stderr || ""}`)) {
      throw new Error(`Could not inspect the live GitHub PR for ${stream.branch}: ${error.stderr?.trim() || error.message}`);
    }
  }
  return { checkout, remoteHead, pr };
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

function enforceCoordinatorBoundary(context, command) {
  if (context.binding?.role !== "repo-coordinator") return;
  const allowed = new Set(["list", "coordinate", "context", "catchup", "workflow", "status", "show", "session", "assign", "create", "ask", "mrr", "release-check", "hold", "watch", "hook"]);
  if (!allowed.has(command)) throw new Error(`Repository coordinators are a relay and monitoring role; ${command} belongs to the user, workstream, or reviewers`);
}

async function coordinatorTarget(context, id) {
  if (context.binding?.role !== "repo-coordinator") return null;
  const stream = await api("GET", `/api/workstreams/${encodeURIComponent(id)}`);
  if (stream.project !== context.binding.projectId) throw new Error("Repository coordinators may mutate only workstreams in their assigned repository");
  return stream;
}

async function assertWorkstreamAuthority(context, id) {
  if (context.who.kind === "unknown" || context.binding?.role === "repo-coordinator") return;
  if (context.binding?.role !== "workstream-orchestrator" || context.binding.workstreamId !== id) throw new Error("This mutation belongs to the exact assigned workstream orchestrator");
  const stream = await api("GET", `/api/workstreams/${encodeURIComponent(id)}`);
  const owner = stream.orchestrator ? await store.resolveSession(stream.orchestrator) : null;
  if ((owner?.id || stream.orchestrator) !== context.who.key) throw new Error("This task is no longer the durable orchestrator assigned to this workstream");
}

async function nudge() {
  const data = await api("GET", "/data/current.json");
  const now = Date.now();
  const candidates = data.workstreams.flatMap((stream) => {
    const reasons = [];
    if (stream.assessment?.stale) reasons.push("reviewer assessment is stale after a head change");
    if ((stream.questions || []).some((question) => question.status === "open")) reasons.push("an uncertainty remains open");
    const updated = new Date(stream.updatedAt || 0).getTime();
    if (["active", "blocked"].includes(stream.status) && now - updated > 12 * 3600_000) reasons.push("the canonical situation is older than 12 hours");
    return reasons.length && (stream.orchestrator || stream.fableAgent) ? [{ stream, reasons }] : [];
  });
  if (!candidates.length) { process.stdout.write("No Field Report nudges are due.\n"); return; }
  for (const { stream, reasons } of candidates) {
    process.stdout.write(`Due: ${stream.id} -> ${stream.orchestrator || stream.fableAgent}: ${reasons.join("; ")}\n`);
  }
}

async function main() {
  const command = process.argv[2] || "help";
  const { positional, flags } = parse(process.argv.slice(3));
  const context = await armed();
  const id = streamId(positional, context.binding);
  if (["help", "--help", "-h"].includes(command)) return process.stdout.write(`${usage()}\n`);
  enforceCoordinatorBoundary(context, command);
  if (command === "list") {
    const result = await api("GET", "/api/workstreams");
    return process.stdout.write(`${result.workstreams.map((stream) => `${stream.id}\t${stream.status}\t${stream.title}`).join("\n")}\n`);
  }
    if (command === "onboard") return onboard(positional[0], flags.role || "orchestrator");
    if (command === "coordinate") return coordinate(positional[0]);
    if (command === "context") return process.stdout.write(`${await contextReport(context, positional[0])}\n`);
    if (command === "catchup") return process.stdout.write(`${await catchup(positional[0], { peek: Boolean(flags.peek), since: flags.since })}\n`);
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
  if (command === "session" && positional[0] === "alias") {
    const alias = positional[1];
    const sessionId = flags.id || context.who.key;
    if (!alias || !sessionId || sessionId.startsWith("cwd:")) throw new Error("Use fr session alias <alias> [--id <codex-task-uuid>]");
    const result = await api("POST", "/api/sessions", { id: sessionId, alias, kind: "codex" });
    return process.stdout.write(`Saved ${result.session.alias} for Codex task ${result.session.id}.\n`);
  }
  if (command === "session" && positional[0] === "list") {
    const result = await api("GET", "/api/sessions");
    if (!result.sessions.length) return process.stdout.write("No Codex session aliases recorded.\n");
    return process.stdout.write(`${result.sessions.map((session) => `${session.alias}\t${session.id}`).join("\n")}\n`);
  }
  if (command === "assign") {
    if (!id || !flags.session) throw new Error("Use fr assign [workstream-id] --session <alias-or-uuid>");
    await coordinatorTarget(context, id);
    await assertWorkstreamAuthority(context, id);
    const session = await store.resolveSession(flags.session);
    if (!session) throw new Error(`Unknown Codex session ${flags.session}; register it with fr session alias`);
    if (context.binding?.role === "repo-coordinator" && session.id === context.who.key) throw new Error("Repository coordinators cannot assign themselves as workstream orchestrators");
    const result = await api("PATCH", `/api/workstreams/${encodeURIComponent(id)}`, { orchestrator: session.id, updatedBy: context.who.actor, eventType: "checkpoint", eventText: `Assigned ${session.alias} (${session.id}) as orchestrator` });
    return process.stdout.write(`Assigned ${session.alias} (${session.id}) to ${result.workstream.id}.\n`);
  }
  if (command === "create") {
    if (context.binding?.role === "repo-coordinator" && flags.repo !== context.binding.projectId) throw new Error("Repository coordinators may create workstreams only in their assigned repository");
    let orchestrator = flags.orchestrator;
    if (context.binding?.role === "repo-coordinator") {
      if (orchestrator) {
        const requested = await store.resolveSession(orchestrator);
        if (!requested) throw new Error(`Unknown Codex session ${orchestrator}; register it with fr session alias`);
        orchestrator = requested.id;
      } else orchestrator = null;
    } else if (orchestrator === undefined && context.who.kind === "codex") orchestrator = context.who.key;
    if (context.binding?.role === "repo-coordinator" && orchestrator === context.who.key) throw new Error("Repository coordinators cannot create a workstream assigned to themselves");
    const result = await api("POST", "/api/workstreams", { project: flags.repo, id: flags.id, title: flags.title, outcome: flags.outcome, summary: flags.outcome, ...(orchestrator !== undefined ? { orchestrator } : {}), reviewer: flags.reviewer, branch: flags.branch, updatedBy: context.who.actor });
    process.stdout.write(`Created ${result.workstream.id}.\n`);
    if (!flags["no-onboard"] && context.who.kind === "codex" && result.workstream.orchestrator === context.who.key) await onboard(result.workstream.id, "orchestrator");
    return;
  }
  if (command === "ask") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    await coordinatorTarget(context, id);
    await assertWorkstreamAuthority(context, id);
    const offset = positional[0] === id ? 1 : 0;
    const text = positional.slice(offset).join(" ");
    const result = await api("POST", `/api/workstreams/${encodeURIComponent(id)}/questions`, { text, actor: context.who.actor });
    return process.stdout.write(`Recorded ${result.result.id}: ${result.result.text}\n`);
  }
  if (command === "decide") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    await assertWorkstreamAuthority(context, id);
    const offset = positional[0] === id ? 1 : 0;
    const questionId = positional[offset];
    const text = positional.slice(offset + 1).join(" ");
    const result = await api("POST", `/api/workstreams/${encodeURIComponent(id)}/decisions`, { questionId, text, actor: context.who.actor });
    return process.stdout.write(`Resolved ${result.result.id}: ${result.result.answer}\n`);
  }
  if (["update", "checkpoint", "reconcile"].includes(command)) {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    await assertWorkstreamAuthority(context, id);
    const patch = patchFrom(flags);
    const current = await api("GET", `/api/workstreams/${encodeURIComponent(id)}`);
    if (command === "checkpoint" && flags.evidence !== "false") Object.assign(patch, await deterministicEvidence(current, context));
    const changed = Object.entries(patch).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value));
    if (!changed) return process.stdout.write(`No material change for ${id}; checkpoint not recorded.\n`);
    if (["checkpoint", "reconcile"].includes(command) && !flags.note && !flags.summary && !flags.gate) throw new Error(`${command} requires --note, --summary, or --gate with the semantic change`);
    patch.updatedBy = context.who.actor;
    patch.eventType = command === "update" ? "updated" : command;
    patch.eventText = flags.note || `${command} by ${context.who.actor}`;
    const result = await api("PATCH", `/api/workstreams/${encodeURIComponent(id)}`, patch);
    return process.stdout.write(`Updated ${result.workstream.id}.\n${describe(result.workstream)}\n`);
  }
    if (command === "assess") {
      if (!id) throw new Error("Specify a workstream ID or arm this session");
      const result = await api("POST", "/api/assessments/request", { workstreamIds: [id] });
      const brief = result.requested[0];
      return process.stdout.write(`Native Codex advisory-assessment brief at ${brief.head}:\n\n${brief.prompt}\n`);
  }
  if (command === "link") {
    const kind = positional[0];
    const explicitId = positional.length >= 3 ? positional[1] : null;
    const targetId = explicitId || context.binding?.workstreamId;
    const value = positional[explicitId ? 2 : 1];
    if (!targetId || !value || !["issue", "commit"].includes(kind)) throw new Error("Use fr link issue|commit [workstream-id] <value>");
    await assertWorkstreamAuthority(context, targetId);
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
    await assertWorkstreamAuthority(context, id);
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
      reasoning: flags.reasoning,
      reviewRole: flags.role,
      reviewScope: flags.scope,
      baseHead: flags["base-head"],
      summary: flags.summary,
      mergeReadiness: flags.merge,
      structuralRisk: flags.structural,
      outcomeConfidence: flags["outcome-confidence"],
      necessity: flags.necessity,
      simplerPath: flags["simpler-path"],
      scopeDrift: flags["scope-drift"],
      contractIntegrity: flags["contract-integrity"],
      evidenceQuality: flags["evidence-quality"]
      ,reviewerId: context.who.key,
      provider: flags.provider
      ,route: flags.route
      ,independent: true
    });
    return process.stdout.write(`Recorded review pass ${result.event.metadata.passId} for ${targetId} at ${result.event.metadata.head.slice(0, 8)}.\n`);
  }
  if (command === "commit-review" && positional[0] === "record") {
    const targetId = positional[1] || context.binding?.workstreamId;
    if (!targetId) throw new Error("Specify a workstream ID or arm this session");
    const result = await api("POST", `/api/workstreams/${encodeURIComponent(targetId)}/commit-reviews`, { tree: flags.tree, baseHead: flags["base-head"], verdict: "GO", reviewRole: flags.role, reviewer: flags.reviewer || context.who.actor, reviewerId: context.who.key, provider: flags.provider, model: flags.model, summary: flags.summary });
    return process.stdout.write(`Recorded local commit review ${result.event.metadata.reviewRole} for staged tree ${result.event.metadata.tree.slice(0, 8)}.\n`);
  }
  if (command === "commit-check" || command === "commit") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    if (command === "commit") await assertWorkstreamAuthority(context, id);
    const inferred = await inferredContext(context);
    if (!inferred.checkout.repoRoot) throw new Error("Current checkout repository is unresolved");
    const tree = (await exec("git", ["write-tree"], { cwd: inferred.checkout.repoRoot, timeout: 10_000 })).stdout.trim();
    const baseHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: inferred.checkout.repoRoot, timeout: 10_000 })).stdout.trim();
    const result = await api("GET", `/api/workstreams/${encodeURIComponent(id)}/commit-panel?tree=${encodeURIComponent(tree)}&baseHead=${encodeURIComponent(baseHead)}`);
    if (!result.ready) throw new Error(`${id} commit gate at staged tree ${tree.slice(0, 8)}: BLOCKED\n${result.reasons.map((reason) => `- ${reason}`).join("\n")}`);
    if (command === "commit") {
      if (!flags.message) throw new Error("fr commit requires --message");
      const committed = await exec("git", ["commit", "-m", flags.message], { cwd: inferred.checkout.repoRoot, timeout: 120_000 });
      return process.stdout.write(committed.stdout);
    }
    return process.stdout.write(`${id} commit gate at staged tree ${tree.slice(0, 8)}: READY\nFresh local deep-code and structural reviews are recorded. Commit this staged tree without changing the index.\n`);
  }
  if (command === "pass" && positional[0] === "import") {
    const { envelope, passes } = await reviewEnvelope(flags);
    const targetId = positional[1] || envelope.workstreamId || envelope.workstream_id || context.binding?.workstreamId;
    if (!targetId) throw new Error("Specify a workstream ID in the command or review envelope");
    const bodies = passes.map((pass) => reviewPassBody(pass, envelope, context));
    const result = await api("POST", `/api/workstreams/${encodeURIComponent(targetId)}/passes`, { passes: bodies });
    const events = result.events;
    const mrr = await api("GET", `/api/workstreams/${encodeURIComponent(targetId)}/mrr`);
    return process.stdout.write(`Imported ${events.length} review pass${events.length === 1 ? "" : "es"} for ${targetId}. MRR: ${mrr.ready ? "READY" : "NOT READY"}${mrr.reasons?.length ? ` — ${mrr.reasons.join("; ")}` : ""}.\n`);
  }
  if (command === "mrr") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    const result = await api("GET", `/api/workstreams/${encodeURIComponent(id)}/mrr`);
    if (!result.required) return process.stdout.write(`${id}: MRR panel is not required for this non-code outcome.\n`);
    const lane = (name, pass) => `${name}: ${pass ? `${pass.verdict} · ${pass.model || pass.reviewer}${pass.reasoning ? ` · ${pass.reasoning}` : ""}` : "MISSING"}`;
    const lines = [`${id} MRR gate at ${result.head ? result.head.slice(0, 8) : "unresolved head"}: ${result.ready ? "READY" : "NOT READY"}`, `Policy: ${result.policy?.mode || "full"}${result.policy?.reason ? ` — ${result.policy.reason}` : ""}`, lane("Deep code review", result.lanes.deepCode), lane("Structural challenge", result.lanes.structuralChallenge), ...(result.fleet ? [`Fleet: ${result.fleet.solReviewers} Sol · Fable via claude-aws ${result.fleet.fableViaClaudeAws ? "present" : "missing"}`] : [])];
    if (result.reasons?.length) lines.push(...result.reasons.map((reason) => `- ${reason}`));
    return process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (command === "release-check") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    const stream = await api("GET", `/api/workstreams/${encodeURIComponent(id)}`);
    const evidence = await liveReleaseEvidence(stream, context);
    const mrrPath = `/api/workstreams/${encodeURIComponent(id)}/mrr${evidence.remoteHead ? `?head=${encodeURIComponent(evidence.remoteHead)}` : ""}`;
    const mrr = await api("GET", mrrPath);
    const all = await api("GET", "/api/workstreams");
    const prOwners = evidence.pr ? all.workstreams.filter((candidate) => (candidate.prs || []).some((linked) => Number(linked.number) === Number(evidence.pr.number))).map((candidate) => candidate.id) : [];
    const result = evaluateRelease({ stream, mrr, prOwners, ...evidence });
    const lines = [`${id} release gate at ${result.head ? result.head.slice(0, 8) : "unresolved head"}: ${result.ready ? "READY" : "BLOCKED"}`];
    if (result.pr) lines.push(`PR #${result.pr.number}: ${String(result.pr.state).toLowerCase()}${result.pr.isDraft ? " draft" : " non-draft"}`);
    if (result.reasons.length) lines.push(...result.reasons.map((reason) => `- ${reason}`));
    if (!result.ready) throw new Error(lines.join("\n"));
    lines.push("Exact checkout, origin, GitHub PR, and MRR heads agree. The PR may be marked ready; merge authority remains with the user.");
    return process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (command === "hold" || command === "unhold") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    await coordinatorTarget(context, id);
    await assertWorkstreamAuthority(context, id);
    if (command === "hold" && !flags.reason) throw new Error("Publication hold requires --reason");
    const publicationHold = command === "hold" ? { reason: flags.reason } : null;
    await api("PATCH", `/api/workstreams/${encodeURIComponent(id)}`, { publicationHold, updatedBy: context.who.actor, eventType: "checkpoint", eventText: command === "hold" ? `Publication held: ${flags.reason}` : "Publication hold cleared" });
    return process.stdout.write(`${id}: publication ${command === "hold" ? "held" : "hold cleared"}.\n`);
  }
  if (command === "policy") {
    if (!id) throw new Error("Specify a workstream ID or arm this session");
    if (context.binding || context.who.kind !== "unknown" || !flags["user-authorized"]) throw new Error("Only the user may change review policy; run this outside a Codex task with --user-authorized");
    const mode = flags.mode;
    if (!mode) throw new Error("Specify --mode full|single-independent|delta|none");
    const result = await api("PATCH", `/api/workstreams/${encodeURIComponent(id)}`, { reviewPolicy: { mode, reason: flags.reason || null, ...(flags["min-provider-families"] ? { minProviderFamilies: Number(flags["min-provider-families"]) } : {}), ...(flags["require-reviewer-ids"] === "true" ? { requireReviewerIds: true } : {}) }, updatedBy: context.who.actor, eventType: "review_policy", eventText: `Review policy set to ${mode}${flags.reason ? `: ${flags.reason}` : ""}` });
    return process.stdout.write(`Set ${result.workstream.id} review policy to ${mode}${flags.reason ? ` — ${flags.reason}` : ""}.\n`);
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
    if (positional[0] !== "once" && !flags.once) throw new Error("Use fr watch --once; send actionable nudges through native Codex task messaging");
    return nudge();
  }
  if (command === "hook") {
    if (positional[0] === "session-start") {
      try { return await autoOnboard(); } catch { return; }
    }
      if (positional[0] === "stop") {
        try {
          if (context.binding?.workstreamId) {
            await assertWorkstreamAuthority(context, context.binding.workstreamId);
            await api("POST", `/api/workstreams/${encodeURIComponent(context.binding.workstreamId)}/events`, { type: "checkpoint", actor: context.who.actor, text: "Agent session stopped; semantic reconciliation may be due" });
          }
        } catch {}
      return;
    }
    throw new Error("Hook must be session-start or stop");
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => { console.error(`fr: ${error.message}`); process.exitCode = 1; });
