import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_ROOT = path.join(os.homedir(), ".local", "state", "field-report");

function requiredString(value, label, max = 1200) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\0]/.test(text)) throw new Error(`${label} must be between 1 and ${max} characters`);
  return text;
}

function optionalString(value, label, max = 1200) {
  if (value == null || String(value).trim() === "") return null;
  return requiredString(value, label, max);
}

function id(value, label = "ID") {
  const text = requiredString(value, label, 100).toLowerCase();
  if (!/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/.test(text)) throw new Error(`${label} uses lowercase letters, numbers, underscores, and hyphens`);
  return text;
}

async function readJson(file, fallback = undefined) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function defaultStateRoot() { return process.env.FIELD_REPORT_STATE_ROOT || DEFAULT_ROOT; }

export function createStore(root = defaultStateRoot()) {
  root = path.resolve(root);
  const lock = path.join(root, ".write-lock");

  async function init() {
    await Promise.all(["projects", "workstreams", "reviews", "delegations", "events"].map((entry) => mkdir(path.join(root, entry), { recursive: true })));
    const configFile = path.join(root, "config.json");
    try { await readFile(configFile); }
    catch (error) { if (error.code !== "ENOENT") throw error; await writeJson(configFile, { schemaVersion: 2, createdAt: new Date().toISOString() }); }
    return root;
  }

  async function locked(operation) {
    await init();
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Another Field Report writer is active");
        await sleep(50);
      }
    }
    try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
  }

  async function append(kind, workstreamId, value) {
    const file = path.join(root, kind, `${id(workstreamId, "Workstream ID")}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return value;
  }

  async function lines(kind, workstreamId) {
    try { return (await readFile(path.join(root, kind, `${id(workstreamId, "Workstream ID")}.jsonl`), "utf8")).split("\n").filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function projects() {
    await init();
    const files = (await readdir(path.join(root, "projects"))).filter((file) => file.endsWith(".json")).sort();
    return Promise.all(files.map((file) => readJson(path.join(root, "projects", file))));
  }

  async function saveProject(value) {
    const project = {
      schemaVersion: 2,
      revision: 1,
      id: id(value.id, "Project ID"),
      label: requiredString(value.label || value.id, "Project label", 160),
      repoPath: path.resolve(requiredString(value.repoPath, "Repository path", 1000)),
      githubRepo: optionalString(value.githubRepo, "GitHub repository", 300),
      baseBranch: optionalString(value.baseBranch, "Base branch", 200) || "main",
      miniReview: {
        maxFiles: Number.isInteger(Number(value.miniReview?.maxFiles)) ? Number(value.miniReview.maxFiles) : 5,
        maxChangedLines: Number.isInteger(Number(value.miniReview?.maxChangedLines)) ? Number(value.miniReview.maxChangedLines) : 120,
        riskyPaths: Array.isArray(value.miniReview?.riskyPaths) ? value.miniReview.riskyPaths.map(String) : ["migrations/", "schema", "auth", "security", "package.json", "lock", ".github/", "AGENTS.md"]
      },
      updatedAt: new Date().toISOString()
    };
    await locked(async () => {
      if (await readJson(path.join(root, "projects", `${project.id}.json`), null)) throw new Error(`Project already exists: ${project.id}`);
      await writeJson(path.join(root, "projects", `${project.id}.json`), project);
    });
    return project;
  }

  async function updateProject(projectId, value) {
    return locked(async () => {
      const file = path.join(root, "projects", `${id(projectId, "Project ID")}.json`);
      const previous = await readJson(file, null);
      if (!previous) throw new Error(`Unknown project: ${projectId}`);
      const project = {
        ...previous,
        revision: (previous.revision || 0) + 1,
        label: value.label == null ? previous.label : requiredString(value.label, "Project label", 160),
        repoPath: value.repoPath == null ? previous.repoPath : path.resolve(requiredString(value.repoPath, "Repository path", 1000)),
        githubRepo: value.githubRepo == null ? previous.githubRepo : optionalString(value.githubRepo, "GitHub repository", 300),
        baseBranch: value.baseBranch == null ? previous.baseBranch : requiredString(value.baseBranch, "Base branch", 200),
        updatedAt: new Date().toISOString()
      };
      await writeJson(file, project);
      return project;
    });
  }

  async function project(projectId) {
    const value = await readJson(path.join(root, "projects", `${id(projectId, "Project ID")}.json`), null);
    if (!value) throw new Error(`Unknown project: ${projectId}`);
    return value;
  }

  // One-time v2 claim migration: records saved before the dedicated delivery
  // claim existed used summary as the implicit claim; preserve that reading
  // until the record is next saved.
  function withClaim(value) { return value && value.claim == null ? { ...value, claim: value.summary } : value; }

  async function workstreams() {
    await init();
    const files = (await readdir(path.join(root, "workstreams"))).filter((file) => file.endsWith(".json")).sort();
    return (await Promise.all(files.map((file) => readJson(path.join(root, "workstreams", file))))).map(withClaim);
  }

  async function workstream(workstreamId) {
    const value = await readJson(path.join(root, "workstreams", `${id(workstreamId, "Workstream ID")}.json`), null);
    if (!value) throw new Error(`Unknown workstream: ${workstreamId}`);
    return withClaim(value);
  }

  async function saveWorkstream(value, event = null) {
    await project(value.project);
    return locked(async () => {
      const previous = await readJson(path.join(root, "workstreams", `${id(value.id, "Workstream ID")}.json`), {});
      if (previous.id && value.revision == null) throw new Error(`Workstream already exists: ${value.id}`);
      if (value.revision != null && value.revision !== previous.revision) throw new Error(`Workstream ${value.id} changed since it was read; reload before updating`);
      const status = value.status || previous.status || "planned";
      if (!["planned", "active", "blocked", "complete"].includes(status)) throw new Error("Status must be planned, active, blocked, or complete");
      const record = {
      schemaVersion: 2,
      revision: (previous.revision || 0) + 1,
      id: id(value.id, "Workstream ID"),
      project: id(value.project, "Project ID"),
      title: requiredString(value.title || previous.title, "Title", 200),
      outcome: requiredString(value.outcome || previous.outcome || value.summary || previous.summary, "Outcome"),
      status,
      summary: requiredString(value.summary || previous.summary || value.outcome || previous.outcome, "Summary"),
      claim: requiredString(value.claim ?? previous.claim ?? previous.summary ?? value.summary ?? value.outcome ?? previous.outcome, "Delivery claim"),
      next: optionalString(value.next ?? previous.next, "Next action"),
      ownerTaskId: optionalString(value.ownerTaskId ?? previous.ownerTaskId, "Owner task ID", 200),
      branch: optionalString(value.branch ?? previous.branch, "Branch", 300),
      pullRequests: Array.isArray(value.pullRequests) ? [...new Set(value.pullRequests.map(Number).filter(Number.isInteger))] : previous.pullRequests || [],
      issues: Array.isArray(value.issues) ? [...new Set(value.issues.map(String))] : previous.issues || [],
      references: Array.isArray(value.references) ? value.references : previous.references || [],
      milestones: Array.isArray(value.milestones) ? value.milestones : previous.milestones || [],
      questions: Array.isArray(value.questions) ? value.questions : previous.questions || [],
      reviewClass: value.reviewClass || previous.reviewClass || "full",
      miniClassification: value.miniClassification ?? previous.miniClassification ?? null,
      createdAt: previous.createdAt || value.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
      };
      if (!["full", "mini"].includes(record.reviewClass)) throw new Error("Review class must be full or mini");
      await writeJson(path.join(root, "workstreams", `${record.id}.json`), record);
      if (event) await append("events", record.id, { id: randomUUID(), at: record.updatedAt, type: event.type, text: requiredString(event.text, "Event text"), actor: optionalString(event.actor, "Actor", 200) });
      return record;
    });
  }

  async function addDelegation(workstreamId, value) {
    const stream = await workstream(workstreamId);
    const delegation = { ...value, id: randomUUID(), workstreamId: stream.id, event: "created", createdAt: new Date().toISOString() };
    await locked(() => append("delegations", stream.id, delegation));
    return delegation;
  }

  async function addDelegationEvent(workstreamId, delegationId, value) {
    const stream = await workstream(workstreamId);
    const event = { ...value, id: delegationId, workstreamId: stream.id, at: new Date().toISOString() };
    return locked(async () => {
      const created = (await lines("delegations", stream.id)).find((item) => item.event === "created" && item.id === delegationId);
      if (!created) throw new Error(`Unknown delegation: ${delegationId}`);
      if (value.event === "bound") {
        const existing = (await lines("delegations", stream.id)).findLast((item) => item.event === "bound" && item.id === delegationId);
        if (existing && existing.taskId !== value.taskId) throw new Error(`Delegation ${delegationId} is already bound to ${existing.taskId}`);
      }
      return append("delegations", stream.id, event);
    });
  }

  async function addReview(workstreamId, value) {
    const stream = await workstream(workstreamId);
    const review = { ...value, id: randomUUID(), workstreamId: stream.id, recordedAt: new Date().toISOString() };
    await locked(() => append("reviews", stream.id, review));
    return review;
  }

  async function addDecision(workstreamId, questionId, answer, actor = null) {
    const stream = await workstream(workstreamId);
    const questions = [...stream.questions];
    const index = questions.findIndex((question) => question.id === questionId);
    if (index < 0) throw new Error(`Unknown question: ${questionId}`);
    questions[index] = { ...questions[index], status: "answered", answer: requiredString(answer, "Decision"), answeredAt: new Date().toISOString() };
    return saveWorkstream({ ...stream, questions }, { type: "decision", text: `${questionId}: ${answer}`, actor });
  }

  return { root, init, projects, project, saveProject, updateProject, workstreams, workstream, saveWorkstream, delegations: (id) => lines("delegations", id), reviews: (id) => lines("reviews", id), events: (id) => lines("events", id), addDelegation, addDelegationEvent, addReview, addDecision };
}
