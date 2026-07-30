import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { evaluateMrr } from "./mrr.mjs";
import { evaluateCommitPanel } from "./commit-panel.mjs";

const exec = promisify(execFile);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createFieldReportStore(root) {
  const lockDir = path.join(root, ".field-report-write.lock");
  const sessionsFile = path.join(root, "config", "sessions.json");

  async function withWriteLock(operation) {
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        await mkdir(lockDir);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const info = await stat(lockDir);
          if (Date.now() - info.mtimeMs > 30_000) { await rm(lockDir, { recursive: true, force: true }); continue; }
        } catch {}
        if (Date.now() >= deadline) throw new Error("Another Field Report writer is still active; retry shortly");
        await delay(75);
      }
    }
    try { return await operation(); }
    finally { await rm(lockDir, { recursive: true, force: true }); }
  }

  function sessionValue(value) {
    if (value == null || String(value).trim() === "") return null;
    const normalized = String(value).trim();
    if (normalized.length > 200 || /[\r\n\0]/.test(normalized)) throw new Error("Session identifiers must be a single line under 200 characters");
    return normalized;
  }

  async function writeJsonAtomic(file, value) {
    const temp = `${file}.${process.pid}-${randomUUID()}.next`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, file);
  }

  async function listSessions() {
    try {
      const registry = JSON.parse(await readFile(sessionsFile, "utf8"));
      return Array.isArray(registry.sessions) ? registry.sessions : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function resolveSession(value) {
    const normalized = sessionValue(value);
    if (!normalized) return null;
    const sessions = await listSessions();
    return sessions.find((session) => session.id === normalized) || sessions.find((session) => session.alias === normalized || session.aliases?.includes(normalized)) || null;
  }

  async function sessionIdFor(value) {
    const normalized = sessionValue(value);
    if (!normalized) return null;
    const registered = await resolveSession(normalized);
    if (registered) return registered.id;
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(normalized)) return normalized;
    throw new Error(`Unknown Codex session ${normalized}; register it with fr session alias`);
  }

  async function withCanonicalOrchestrator(stream) {
    if (!stream.orchestrator) return stream;
    const registered = await resolveSession(stream.orchestrator);
    return registered ? { ...stream, orchestrator: registered.id } : stream;
  }

  async function saveSessionAlias(values) {
    return withWriteLock(async () => {
      const id = sessionValue(values.id);
      const alias = sessionValue(values.alias);
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id || "")) throw new Error("Session ID must be a Codex task UUID");
      if (!/^[a-z0-9][a-z0-9/_-]{0,79}$/.test(alias || "")) throw new Error("Session aliases use lowercase letters, numbers, slash, underscore, or hyphen");
      const sessions = await listSessions();
      if (sessions.some((session) => session.id !== id && (session.alias === id || session.aliases?.includes(id)))) throw new Error(`Session ID ${id} conflicts with an existing alias`);
      if (sessions.some((session) => session.id === alias && session.id !== id)) throw new Error(`Session alias ${alias} conflicts with an existing task ID`);
      if (sessions.some((session) => (session.alias === alias || session.aliases?.includes(alias)) && session.id !== id)) throw new Error(`Session alias ${alias} is already assigned`);
      const existing = sessions.find((session) => session.id === id);
      const aliases = [...new Set([...(existing?.aliases || []), ...(existing?.alias && existing.alias !== alias ? [existing.alias] : [])])].filter((value) => value !== alias);
      const record = { id, alias, ...(aliases.length ? { aliases } : {}), kind: values.kind || existing?.kind || "codex", updatedAt: new Date().toISOString() };
      const next = [...sessions.filter((session) => session.id !== id), record].sort((left, right) => left.alias.localeCompare(right.alias));
      await writeJsonAtomic(sessionsFile, { sessions: next });
      return record;
    });
  }

  async function findWorkstream(workstreamId) {
    const workstreamDir = path.join(root, "workstreams");
    const files = (await readdir(workstreamDir)).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const candidate = JSON.parse(await readFile(path.join(workstreamDir, file), "utf8"));
      if (candidate.id === workstreamId) return { streamFile: path.join(workstreamDir, file), stream: candidate };
    }
    throw new Error("Unknown workstream");
  }

  async function listCanonicalWorkstreams() {
    const dir = path.join(root, "workstreams");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
    return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(dir, file), "utf8"))));
  }

  function shortText(value, label, max = 500) {
    const normalized = String(value || "").trim();
    if (!normalized || normalized.length > max || /\0/.test(normalized)) throw new Error(`${label} must be between 1 and ${max} characters`);
    return normalized;
  }

  function slug(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  }

  function workstreamId(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 80) throw new Error("Workstream IDs use lowercase letters, numbers, and hyphens");
    return normalized;
  }

  function normalizeReferences(references) {
    if (!Array.isArray(references)) throw new Error("references must be an array");
    return references.slice(0, 12).map((reference) => ({
      path: shortText(reference.path, "Reference path", 500),
      label: shortText(reference.label || reference.path, "Reference label", 200),
      kind: ["plan", "contract", "decision", "review"].includes(reference.kind) ? reference.kind : "plan",
      ...(reference.section ? { section: sessionValue(reference.section) } : {}),
      ...(reference.quote ? { quote: shortText(reference.quote, "Reference quote", 360) } : {})
    }));
  }

  function normalizeChunks(chunks) {
    if (!Array.isArray(chunks)) throw new Error("chunks must be an array");
    return chunks.map((chunk, index) => {
      const status = String(chunk.status || "planned");
      if (!["planned", "active", "blocked", "complete"].includes(status)) throw new Error("Chunk status must be planned, active, blocked, or complete");
      return {
        id: slug(chunk.id || chunk.title || `milestone-${index + 1}`),
        title: shortText(chunk.title, "Chunk title", 240), status,
        ...(Array.isArray(chunk.issueIds) ? { issueIds: chunk.issueIds.map(String) } : {}),
        ...(Array.isArray(chunk.commits) ? { commits: chunk.commits.map(String) } : {}),
        ...(Array.isArray(chunk.references) ? { references: normalizeReferences(chunk.references) } : {})
      };
    });
  }

  function normalizePrs(prs) {
    if (!Array.isArray(prs)) throw new Error("prs must be an array");
    return prs.map((pr) => {
      const number = Number(typeof pr === "object" ? pr.number : pr);
      if (!Number.isInteger(number) || number < 1) throw new Error("PR numbers must be positive integers");
      return typeof pr === "object" ? { number, chunks: Array.isArray(pr.chunks) ? pr.chunks.map(String) : [] } : { number, chunks: [] };
    });
  }

  function applyCanonicalPatch(stream, patch, allowReviewPolicy = false) {
    const next = { ...stream };
    if (patch.title != null) next.title = shortText(patch.title, "Title", 160);
    if (patch.summary != null) next.summary = shortText(patch.summary, "Summary", 1200);
    if (patch.status != null) {
      if (!["planned", "active", "blocked", "complete"].includes(patch.status)) throw new Error("Status must be planned, active, blocked, or complete");
      next.status = patch.status;
    }
    if (patch.branch !== undefined) next.branch = patch.branch ? sessionValue(patch.branch) : null;
    if (patch.reviewState != null) next.reviewState = shortText(patch.reviewState, "Current gate", 500);
    if (patch.reviewPolicy != null) {
      if (!allowReviewPolicy) throw new Error("Review policy changes require the dedicated user-authorized policy path");
      const mode = String(patch.reviewPolicy.mode || "");
      if (!["full", "single-independent", "delta", "none"].includes(mode)) throw new Error("Review policy must be full, single-independent, delta, or none");
      const reason = patch.reviewPolicy.reason ? shortText(patch.reviewPolicy.reason, "Review policy reason", 500) : null;
      if (mode !== "full" && !reason) throw new Error("A non-full review policy requires an explicit reason");
      const minProviderFamilies = Number(patch.reviewPolicy.minProviderFamilies || 0);
      if (!Number.isInteger(minProviderFamilies) || minProviderFamilies < 0 || minProviderFamilies > 4) throw new Error("Minimum provider families must be between 0 and 4");
      const minSolReviewers = Number(patch.reviewPolicy.minSolReviewers || 0);
      if (!Number.isInteger(minSolReviewers) || minSolReviewers < 0 || minSolReviewers > 10) throw new Error("Minimum Sol reviewers must be between 0 and 10");
      next.reviewPolicy = { mode, reason, ...(patch.reviewPolicy.userAuthorized === true ? { userAuthorized: true } : {}), ...(minProviderFamilies ? { minProviderFamilies } : {}), ...(patch.reviewPolicy.requireReviewerIds === true ? { requireReviewerIds: true } : {}), ...(minSolReviewers ? { minSolReviewers } : {}), ...(patch.reviewPolicy.requireFableViaClaudeAws === true ? { requireFableViaClaudeAws: true } : {}) };
    }
    if (patch.publicationHold !== undefined) next.publicationHold = patch.publicationHold ? { reason: shortText(patch.publicationHold.reason, "Publication hold reason", 500) } : null;
    if (patch.chunks != null) next.chunks = normalizeChunks(patch.chunks);
    if (patch.prs != null) next.prs = normalizePrs(patch.prs);
    if (patch.references != null) next.references = normalizeReferences(patch.references);
    if (patch.issuePrefixes != null) {
      if (!Array.isArray(patch.issuePrefixes)) throw new Error("issuePrefixes must be an array");
      next.issuePrefixes = [...new Set(patch.issuePrefixes.map((value) => sessionValue(value)).filter(Boolean))];
    }
    if (patch.commits != null) {
      if (!Array.isArray(patch.commits) || patch.commits.some((sha) => !/^[0-9a-f]{7,40}$/i.test(sha))) throw new Error("commits must contain git SHAs");
      next.commits = [...new Set(patch.commits)];
    }
    if (patch.questions != null) {
      if (!Array.isArray(patch.questions)) throw new Error("questions must be an array");
      next.questions = patch.questions.map((question, index) => ({
        id: String(question.id || `Q${index + 1}`), text: shortText(question.text, "Question", 600), status: question.status === "answered" ? "answered" : "open",
        ...(question.askedAt ? { askedAt: question.askedAt } : {}), ...(question.answeredAt ? { answeredAt: question.answeredAt } : {}), ...(question.answer ? { answer: String(question.answer) } : {})
      }));
    }
    if (patch.orchestrator !== undefined) next.orchestrator = sessionValue(patch.orchestrator);
    next.updatedAt = new Date().toISOString();
    next.updatedBy = patch.updatedBy ? sessionValue(patch.updatedBy) : "fr";
    return next;
  }

  async function appendEventUnlocked(id, event) {
    const eventsDir = path.join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const record = { id: randomUUID(), workstreamId: id, at: new Date().toISOString(), type: String(event.type || "update").toLowerCase(), actor: sessionValue(event.actor) || "fr", text: shortText(event.text || event.summary || event.type || "Update", "Event text", 1200), ...(event.metadata && typeof event.metadata === "object" ? { metadata: event.metadata } : {}) };
    await appendFile(path.join(eventsDir, `${id}.jsonl`), `${JSON.stringify(record)}\n`);
    return record;
  }

  async function appendWorkstreamEvent(id, event) {
    const type = String(event.type || "update").toLowerCase();
    if (["review_pass", "commit_review", "review_policy"].includes(type)) throw new Error(`${type} evidence requires its dedicated validated path`);
    return withWriteLock(async () => { await findWorkstream(id); return appendEventUnlocked(id, event); });
  }

  async function readEvents(id) {
    try { return (await readFile(path.join(root, "events", `${id}.jsonl`), "utf8")).split("\n").filter(Boolean).map(JSON.parse); }
    catch { return []; }
  }

  async function projectConfig(projectId) {
    const config = JSON.parse(await readFile(path.join(root, "config/projects.json"), "utf8"));
    return config.projects.find((candidate) => candidate.id === projectId) || null;
  }

  async function projectedStream(id) {
    try {
      const data = JSON.parse(await readFile(path.join(root, "data/current.json"), "utf8"));
      const stream = data.workstreams.find((candidate) => candidate.id === id);
      return stream ? { stream, project: data.projects.find((candidate) => candidate.id === stream.project) } : null;
    } catch { return null; }
  }

  async function currentStream(id) {
    const { stream: canonical } = await findWorkstream(id);
    const projected = await projectedStream(id);
    const project = await projectConfig(canonical.project);
    let currentHead = null;
    if (canonical.branch && project?.repoPath) {
      try { currentHead = (await exec("git", ["-C", project.repoPath, "rev-parse", canonical.branch], { timeout: 10_000 })).stdout.trim(); } catch {}
    }
    currentHead ||= projected?.stream?.assessment?.currentHead || projected?.stream?.prs?.find((pr) => pr.current)?.headRefOid || null;
    const events = await readEvents(id);
    const projectReviewPolicy = project?.reviewPolicy || {};
    const projectReviewConstraints = {
      ...(Number.isInteger(projectReviewPolicy.minProviderFamilies) ? { minProviderFamilies: projectReviewPolicy.minProviderFamilies } : {}),
      ...(projectReviewPolicy.requireReviewerIds === true ? { requireReviewerIds: true } : {}),
      ...(Number.isInteger(projectReviewPolicy.minSolReviewers) ? { minSolReviewers: projectReviewPolicy.minSolReviewers } : {}),
      ...(projectReviewPolicy.requireFableViaClaudeAws === true ? { requireFableViaClaudeAws: true } : {})
    };
    return {
      stream: {
        ...(projected?.stream || {}), ...canonical,
        reviewPolicy: { ...projectReviewConstraints, ...(canonical.reviewPolicy || {}) },
        prs: projected?.stream?.prs || canonical.prs || [],
        reviewPasses: events.filter((event) => event.type === "review_pass").sort((left, right) => new Date(left.at) - new Date(right.at)),
        assessment: { ...(projected?.stream?.assessment || canonical.assessment || {}), currentHead }
      },
      project: projected?.project || project
    };
  }

  async function mrrStatus(id, head = null) {
    const stream = await withCanonicalOrchestrator((await currentStream(id)).stream);
    if (head != null && !/^[0-9a-f]{40}$/i.test(head)) throw new Error("MRR head must be an exact 40-character SHA");
    return evaluateMrr(head ? { ...stream, assessment: { ...(stream.assessment || {}), currentHead: head } } : stream);
  }

  async function createWorkstream(values) {
    return withWriteLock(async () => {
      const project = await projectConfig(values.project);
      if (!project) throw new Error("Unknown project");
      const id = workstreamId(values.id || `${project.id}-${slug(values.title)}`);
      try { await findWorkstream(id); throw new Error("Workstream already exists"); } catch (error) { if (error.message !== "Unknown workstream") throw error; }
      const now = new Date().toISOString();
      const orchestratorValue = Object.hasOwn(values, "orchestrator") ? values.orchestrator : null;
      const orchestrator = await sessionIdFor(orchestratorValue);
      const stream = { id, project: project.id, title: shortText(values.title, "Title", 160), summary: shortText(values.summary || values.outcome, "Outcome", 1200), status: "planned", branch: values.branch ? sessionValue(values.branch) : null, reviewState: values.reviewState ? shortText(values.reviewState, "Current gate", 500) : "Workstream created; initial plan pending", chunks: Array.isArray(values.chunks) ? normalizeChunks(values.chunks) : [], questions: [], prs: [], issuePrefixes: [], references: Array.isArray(values.references) ? normalizeReferences(values.references) : [], orchestrator, assessment: null, updatedAt: now, updatedBy: values.updatedBy ? sessionValue(values.updatedBy) : "fr" };
      await writeJsonAtomic(path.join(root, "workstreams", `${id}.json`), stream);
      await appendEventUnlocked(id, { type: "created", text: `Created workstream: ${stream.summary}`, actor: stream.updatedBy });
      return stream;
    });
  }

  async function updateWorkstream(id, patch, eventType = "updated") {
    return withWriteLock(async () => {
      const { streamFile, stream } = await findWorkstream(id);
      if (patch.orchestrator !== undefined) patch = { ...patch, orchestrator: await sessionIdFor(patch.orchestrator) };
      const semanticKeys = ["title", "summary", "status", "branch", "reviewState", "reviewPolicy", "publicationHold", "chunks", "prs", "references", "issuePrefixes", "commits", "questions", "orchestrator"];
      const requestedKeys = semanticKeys.filter((key) => patch[key] !== undefined);
      if (!requestedKeys.some((key) => JSON.stringify(stream[key]) !== JSON.stringify(patch[key]))) return stream;
      const next = applyCanonicalPatch(stream, patch);
      if (stream.status !== "complete" && next.status === "complete" && (next.branch || (next.prs || []).length || (next.commits || []).length)) {
        const current = await currentStream(id);
        const mrrStream = await withCanonicalOrchestrator({ ...current.stream, orchestrator: next.orchestrator, branch: next.branch, prs: current.stream.prs?.length ? current.stream.prs : next.prs, commits: next.commits, reviewPolicy: { ...(current.stream.reviewPolicy || {}), ...(next.reviewPolicy || {}) } });
        const mrr = evaluateMrr(mrrStream);
        if (!mrr.ready) throw new Error(`MRR completion gate is not satisfied: ${mrr.reasons.join("; ")}. Run fr mrr ${id}.`);
      }
      await writeJsonAtomic(streamFile, next);
      await appendEventUnlocked(id, { type: eventType, actor: patch.updatedBy, text: patch.eventText || patch.summary || patch.reviewState || `${eventType} checkpoint` });
      return next;
    });
  }

  async function setReviewPolicy(id, values) {
    return withWriteLock(async () => {
      const { streamFile, stream } = await findWorkstream(id);
      const reviewPolicy = { ...values, userAuthorized: true };
      const next = applyCanonicalPatch(stream, { reviewPolicy, updatedBy: values.updatedBy }, true);
      await writeJsonAtomic(streamFile, next);
      await appendEventUnlocked(id, { type: "review_policy", actor: values.updatedBy || "user", text: `Review policy set to ${reviewPolicy.mode}${reviewPolicy.reason ? `: ${reviewPolicy.reason}` : ""}` });
      return next;
    });
  }

  async function recordQuestion(id, values) {
    return withWriteLock(async () => {
      const { streamFile, stream } = await findWorkstream(id);
      const existing = stream.questions || [];
      const numeric = existing.map((question) => Number(String(question.id).replace(/^Q/i, ""))).filter(Number.isFinite);
      const questionId = values.questionId || `Q${Math.max(0, ...numeric) + 1}`;
      const question = { id: questionId, text: shortText(values.text, "Question", 600), status: "open", askedAt: new Date().toISOString() };
      await writeJsonAtomic(streamFile, applyCanonicalPatch(stream, { questions: [...existing, question], updatedBy: values.actor }));
      await appendEventUnlocked(id, { type: "question", actor: values.actor, text: question.text, metadata: { questionId } });
      return question;
    });
  }

  async function recordDecision(id, values) {
    return withWriteLock(async () => {
      const { streamFile, stream } = await findWorkstream(id);
      const questions = [...(stream.questions || [])];
      const index = questions.findIndex((question) => question.id === values.questionId);
      if (index < 0) throw new Error("Unknown question");
      const answer = shortText(values.text, "Decision", 800);
      questions[index] = { ...questions[index], status: "answered", answer, answeredAt: new Date().toISOString() };
      await writeJsonAtomic(streamFile, applyCanonicalPatch(stream, { questions, updatedBy: values.actor }));
      await appendEventUnlocked(id, { type: "decision", actor: values.actor, text: answer, metadata: { questionId: values.questionId } });
      return questions[index];
    });
  }

  async function updateSessions(id, values) {
    const session = values.orchestrator ? await resolveSession(values.orchestrator) : null;
    if (values.orchestrator && !session) throw new Error(`Unknown Codex session ${values.orchestrator}; register it with fr session alias`);
    return updateWorkstream(id, { orchestrator: session?.id || null, updatedBy: values.actor || "dashboard", eventText: `Orchestrator set to ${session ? `${session.alias} (${session.id})` : "unassigned"}` }, "checkpoint");
  }

  function reviewPassEvent(values) {
    const head = String(values.head || "").trim();
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error("Review pass requires the exact 40-character git head SHA");
    const verdict = String(values.verdict || "").toUpperCase();
    if (!["GO", "CONDITIONAL_GO", "NO_GO"].includes(verdict)) throw new Error("Review pass requires GO, CONDITIONAL_GO, or NO_GO");
    const mergeReadiness = Number(values.mergeReadiness);
    const structuralRisk = Number(values.structuralRisk);
    if (![mergeReadiness, structuralRisk].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) throw new Error("Review pass requires merge readiness and structural risk from 0 to 100");
    const reviewRole = values.reviewRole || null;
    if (reviewRole && !["deep-code-review", "structural-challenge"].includes(reviewRole)) throw new Error("Review role must be deep-code-review or structural-challenge");
    const reviewScope = values.reviewScope || "full";
    if (!["full", "delta"].includes(reviewScope)) throw new Error("Review scope must be full or delta");
    const baseHead = values.baseHead || null;
    if (reviewScope === "delta" && !/^[0-9a-f]{40}$/i.test(baseHead || "")) throw new Error("A delta review requires --base-head with an exact 40-character SHA");
    return { type: "review_pass", actor: values.reviewer || values.actor || "reviewer", text: values.summary || `${verdict} review pass at ${head.slice(0, 8)}`, metadata: { passId: values.passId || randomUUID(), head, verdict, reviewComplete: true, reviewer: values.reviewer || values.actor || "reviewer", reviewerId: sessionValue(values.reviewerId), reviewerIdentityVerified: values.reviewerIdentityVerified === true, provider: sessionValue(values.provider), route: sessionValue(values.route), provenanceVerified: values.provenanceVerified === true, evidenceDigest: sessionValue(values.evidenceDigest), model: values.model || "unknown", reasoning: values.reasoning || null, reviewRole, reviewScope, baseHead, independent: values.independent === true, findings: Array.isArray(values.findings) ? values.findings : [], unresolved: Array.isArray(values.unresolved) ? values.unresolved : [], mergeReadiness, structuralRisk, outcomeConfidence: Number.isFinite(Number(values.outcomeConfidence)) ? Number(values.outcomeConfidence) : null, necessity: values.necessity || null, simplerPath: values.simplerPath || null, scopeDrift: values.scopeDrift || null, contractIntegrity: values.contractIntegrity || null, evidenceQuality: values.evidenceQuality || null } };
  }

  async function recordReviewPasses(id, values) {
    if (!Array.isArray(values) || !values.length) throw new Error("Review import requires at least one pass");
    const normalized = await Promise.all(values.map(async (value) => {
      const reviewer = value.reviewerId ? await resolveSession(value.reviewerId) : null;
      return { ...value, ...(reviewer ? { reviewerId: reviewer.id } : {}), reviewerIdentityVerified: reviewer?.kind === "codex" };
    }));
    return withWriteLock(async () => {
      const stream = await withCanonicalOrchestrator((await findWorkstream(id)).stream);
      const hasCodeAnchor = Boolean(stream.branch || stream.commits?.length || stream.prs?.length);
      if (!hasCodeAnchor) throw new Error("Review passes require a code workstream anchored by a branch, commit, or PR");
      const events = normalized.map(reviewPassEvent).map((event) => ({ ...event, metadata: { ...event.metadata, orchestratorAtReview: stream.orchestrator || null } }));
      if (events.some((event) => stream.orchestrator && event.metadata.reviewerId === stream.orchestrator)) throw new Error("The workstream orchestrator cannot record an independent review of their own work");
      const recorded = [];
      for (const event of events) recorded.push(await appendEventUnlocked(id, event));
      return recorded;
    });
  }

  async function recordReviewPass(id, values) {
    return (await recordReviewPasses(id, [values]))[0];
  }

  async function recordCommitReview(id, values) {
    const tree = String(values.tree || "").trim();
    if (!/^[0-9a-f]{40}$/i.test(tree)) throw new Error("Commit review requires the exact 40-character staged tree SHA");
    const baseHead = String(values.baseHead || "").trim();
    if (!/^[0-9a-f]{40}$/i.test(baseHead)) throw new Error("Commit review requires the exact 40-character base HEAD");
    const reviewRole = values.reviewRole;
    if (!["deep-code-review", "structural-challenge"].includes(reviewRole)) throw new Error("Commit review role must be deep-code-review or structural-challenge");
    if (String(values.verdict || "").toUpperCase() !== "GO") throw new Error("Only a completed GO may satisfy a local commit panel");
    const registeredReviewer = values.reviewerId ? await resolveSession(values.reviewerId) : null;
    const reviewerId = registeredReviewer?.id || sessionValue(values.reviewerId);
    if (!reviewerId) throw new Error("Commit review requires a durable reviewer ID");
    if (reviewerId.startsWith("cwd:")) throw new Error("Commit review requires a task or provider-run ID, not checkout identity");
    return withWriteLock(async () => {
      const stream = await withCanonicalOrchestrator((await findWorkstream(id)).stream);
      if (stream.orchestrator && reviewerId === stream.orchestrator) throw new Error("The workstream orchestrator cannot record an independent review of their own work");
      const event = { type: "commit_review", actor: values.reviewer || reviewerId, text: shortText(values.summary, "Commit review summary", 1200), metadata: { tree, baseHead, verdict: "GO", reviewComplete: true, reviewRole, reviewer: values.reviewer || reviewerId, reviewerId, orchestratorAtReview: stream.orchestrator || null, provider: sessionValue(values.provider), model: values.model || "unknown" } };
      return appendEventUnlocked(id, event);
    });
  }

  async function commitPanelStatus(id, tree, baseHead) {
    const stream = await withCanonicalOrchestrator((await findWorkstream(id)).stream);
    return evaluateCommitPanel({ tree, baseHead, events: await readEvents(id), orchestrator: stream.orchestrator || null });
  }

  async function workflowContract(role = "shared") {
    const markdown = await readFile(path.join(root, "docs", "fr-workflow.md"), "utf8");
    if (role === "all") return markdown;
    const sections = markdown.split(/^## /m).slice(1).map((part) => { const newline = part.indexOf("\n"); return { title: part.slice(0, newline).trim(), body: part.slice(newline + 1).trim() }; });
    const titles = { "repo-coordinator": "Repository coordinator", "workstream-orchestrator": "Workstream orchestrator", executor: "Executor", reviewer: "Reviewer" };
    const wanted = role === "shared" ? ["Shared contract"] : ["Shared contract", titles[role]].filter(Boolean);
    return sections.filter((section) => wanted.includes(section.title)).map((section) => `## ${section.title}\n\n${section.body}`).join("\n\n");
  }

  function assessmentPrompt(stream, currentHead) {
    const prs = (stream.prs || []).map((pr) => `#${pr.number} (${pr.state || "unknown"}; head ${pr.headRefOid || "unknown"})`).join(", ") || "none yet";
    return `You are an independent reviewer for workstream ${stream.id}. Give an honest, evidence-backed assessment using the repository's merge-ready-review rules, the current branch, linked Field Report evidence, and linked AF issues. Inspect current evidence if needed; do not merely repeat the dashboard summary.

This request authorizes a read-only advisory assessment. It is not a role-assigned MRR lane and must not be recorded with \`fr pass record\` or \`fr pass import\`. Return the judgment through the native Codex task channel; a separate role-specific delegation with truthful model/provider provenance is required for gating MRR evidence.

Outcome: ${stream.title}
Dashboard orientation (may be stale): ${stream.liveStatus?.text || stream.summary}
Branch: ${stream.branch || "none"}
Current head: ${currentHead}
Linked PRs: ${prs}

First reconcile the dashboard orientation against the current branch head, PR state, linked issue history, prior plan, and prior reviewer decisions. When they disagree, use the current evidence and call out the drift explicitly.

Explicitly test necessity, simpler designs, scope drift, ownership and failure contracts, evidence quality, structural rot, and contradictions with prior plans or decisions. Judge the accumulated mechanism rather than only the latest repair, and answer whether you would select this mechanism from scratch given the current evidence.`;
  }

  async function prepareAssessmentBriefs(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20) throw new Error("Select between 1 and 20 workstreams");
    const results = [];
    for (const id of [...new Set(ids.map(String))]) {
      const { stream } = await currentStream(id);
      const currentHead = stream.assessment?.currentHead;
      if (!/^[0-9a-f]{40}$/i.test(currentHead || "")) throw new Error(`Could not resolve an exact current head for ${id}`);
      results.push({ id, head: currentHead, prompt: assessmentPrompt(stream, currentHead) });
    }
    return results;
  }

  return { appendWorkstreamEvent, commitPanelStatus, createWorkstream, currentStream, findWorkstream, listCanonicalWorkstreams, listSessions, mrrStatus, prepareAssessmentBriefs, recordCommitReview, recordDecision, recordQuestion, recordReviewPass, recordReviewPasses, resolveSession, saveSessionAlias, setReviewPolicy, updateSessions, updateWorkstream, workflowContract };
}
