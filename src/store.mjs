import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitCommonDir } from "./repository.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_ROOT = path.join(os.homedir(), ".local", "state", "field-report");
const CONTROL = /[\u0000-\u001f\u007f]/;

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

// Reversible, collision-free filename stem for arbitrary git branch names.
export function branchKey(branch) {
  const name = requiredString(branch, "Branch name", 300);
  return encodeURIComponent(name).replaceAll(".", "%2E");
}

export function decodeBranchKey(encoded) {
  return decodeURIComponent(String(encoded));
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

async function writeTextAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.next`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}

const SERVICE_NAMES = { github: "GitHub", linear: "Linear", notion: "Notion", ref: "Ref" };
export const TODO_SERVICES = ["github", "linear", "notion", "ref"];
export const PLAN_SERVICES = ["repo", "linear", "notion", "ref"];

function normalizeDestination(value, previous, { services, fallback, what, flag }) {
  const prior = previous || { service: fallback, reference: null };
  if (value == null) return prior;
  const service = value.service == null ? prior.service : String(value.service).toLowerCase();
  if (!services.includes(service)) throw new Error(`${what} must be ${services.join(", ")}`);
  if (value.clearReference && value.reference != null) throw new Error(`Use --${flag}-reference or --clear-${flag}-reference, not both`);
  let reference = value.clearReference || service !== prior.service ? null : prior.reference ?? null;
  if (value.reference != null) reference = requiredString(value.reference, `${what} reference`, 200);
  if (reference != null && CONTROL.test(reference)) throw new Error(`${what} reference cannot contain control characters or line breaks`);
  if (service === "repo" && reference != null) throw new Error("A repo plan home takes no reference; plans go in docs/plans/");
  return { service, reference };
}

export function normalizeTodos(value, previous = null) { return normalizeDestination(value, previous, { services: TODO_SERVICES, fallback: "github", what: "Todos", flag: "todos" }); }
export function todosFor(project) { return normalizeTodos(null, project?.todos); }
export function describeTodos(todos, project) {
  if (todos.service === "github") return `GitHub issues in ${todos.reference || project?.githubRepo || "this repository"} (gh issue create)`;
  const name = SERVICE_NAMES[todos.service];
  return `${name}${todos.reference ? `: ${todos.reference}` : ""}, through this host's ${name} MCP connector`;
}

export function normalizePlans(value, previous = null) { return normalizeDestination(value, previous, { services: PLAN_SERVICES, fallback: "repo", what: "Plan home", flag: "plans" }); }
export function plansFor(project) { return normalizePlans(null, project?.plans); }
export function describePlans(plans) {
  if (plans.service === "repo") return "docs/plans/ in this repository";
  const name = SERVICE_NAMES[plans.service];
  return `${name}${plans.reference ? `: ${plans.reference}` : ""}, through this host's ${name} MCP connector`;
}

export const destinationTarget = (value) => `${value.service}${value.reference ? `:${value.reference}` : ""}`;

export function defaultStateRoot() { return process.env.FIELD_REPORT_STATE_ROOT || DEFAULT_ROOT; }

export function createStore(root = defaultStateRoot()) {
  root = path.resolve(root);
  const lock = path.join(root, ".write-lock");

  async function init() {
    await Promise.all(["projects", "branches", "dispositions", "prompts", "reports", "briefs"].map((entry) => mkdir(path.join(root, entry), { recursive: true })));
    const configFile = path.join(root, "config.json");
    try { await readFile(configFile); }
    catch (error) { if (error.code !== "ENOENT") throw error; await writeJson(configFile, { schemaVersion: 3, createdAt: new Date().toISOString() }); }
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

  async function appendJsonl(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return value;
  }

  async function readJsonl(file, { strict = true } = {}) {
    try {
      const text = await readFile(file, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .flatMap((line, index) => {
          try {
            return [JSON.parse(line)];
          } catch (error) {
            if (strict) throw new Error(`Corrupt JSONL record at ${file}:${index + 1}: ${error.message}`);
            return [];
          }
        });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  function withDestinations(value) {
    return { ...value, todos: todosFor(value), plans: plansFor(value) };
  }

  async function projects() {
    await init();
    const files = (await readdir(path.join(root, "projects"))).filter((file) => file.endsWith(".json")).sort();
    return (await Promise.all(files.map((file) => readJson(path.join(root, "projects", file))))).map(withDestinations);
  }

  async function assertUniqueRepo(repoPath, commonDir, ignoreId = null) {
    const existing = await projects();
    for (const other of existing) {
      if (other.id === ignoreId) continue;
      const otherCommon = other.commonDir || await gitCommonDir(other.repoPath);
      if (other.repoPath === repoPath || (commonDir && otherCommon && commonDir === otherCommon)) {
        throw new Error(`Repository ${repoPath} is already registered under project ${other.id}`);
      }
    }
  }

  async function saveProject(value) {
    const repoPath = path.resolve(requiredString(value.repoPath, "Repository path", 1000));
    const commonDir = await gitCommonDir(repoPath);
    const project = {
      schemaVersion: 3,
      revision: 1,
      id: id(value.id, "Project ID"),
      label: requiredString(value.label || value.id, "Project label", 160),
      repoPath,
      ...(commonDir ? { commonDir } : {}),
      githubRepo: optionalString(value.githubRepo, "GitHub repository", 300),
      baseBranch: optionalString(value.baseBranch, "Base branch", 200) || "main",
      todos: normalizeTodos(value.todos),
      plans: normalizePlans(value.plans),
      updatedAt: new Date().toISOString()
    };
    await locked(async () => {
      if (await readJson(path.join(root, "projects", `${project.id}.json`), null)) throw new Error(`Project already exists: ${project.id}`);
      await assertUniqueRepo(repoPath, commonDir);
      await writeJson(path.join(root, "projects", `${project.id}.json`), project);
    });
    return project;
  }

  async function updateProject(projectId, value) {
    return locked(async () => {
      const pid = id(projectId, "Project ID");
      const file = path.join(root, "projects", `${pid}.json`);
      const previous = await readJson(file, null);
      if (!previous) throw new Error(`Unknown project: ${projectId}`);
      const repoPath = value.repoPath == null ? previous.repoPath : path.resolve(requiredString(value.repoPath, "Repository path", 1000));
      const commonDir = (await gitCommonDir(repoPath)) || (repoPath === previous.repoPath ? previous.commonDir : null);
      await assertUniqueRepo(repoPath, commonDir, pid);
      const project = {
        ...previous,
        schemaVersion: 3,
        revision: (previous.revision || 0) + 1,
        label: value.label == null ? previous.label : requiredString(value.label, "Project label", 160),
        repoPath,
        ...(commonDir ? { commonDir } : {}),
        githubRepo: value.githubRepo === undefined ? previous.githubRepo : optionalString(value.githubRepo, "GitHub repository", 300),
        baseBranch: value.baseBranch == null ? previous.baseBranch : requiredString(value.baseBranch, "Base branch", 200),
        todos: normalizeTodos(value.todos, todosFor(previous)),
        plans: normalizePlans(value.plans, plansFor(previous)),
        updatedAt: new Date().toISOString()
      };
      await writeJson(file, project);
      return project;
    });
  }

  async function project(projectId) {
    const value = await readJson(path.join(root, "projects", `${id(projectId, "Project ID")}.json`), null);
    if (!value) throw new Error(`Unknown project: ${projectId}`);
    return withDestinations(value);
  }

  function branchFile(folder, projectId, branch, ext = "jsonl") {
    return path.join(root, folder, id(projectId, "Project ID"), `${branchKey(branch)}.${ext}`);
  }

  async function reviews(projectId, branch) {
    return readJsonl(branchFile("branches", projectId, branch));
  }

  async function dispositions(projectId, branch) {
    return readJsonl(branchFile("dispositions", projectId, branch));
  }

  async function briefs(projectId, branch) {
    return readJsonl(branchFile("briefs", projectId, branch));
  }

  async function addBrief(projectId, branch, value) {
    const pid = id(projectId, "Project ID");
    const branchName = requiredString(branch, "Branch", 300);
    await project(pid);
    const brief = { ...value, id: value.id || randomUUID(), projectId: pid, branch: branchName, createdAt: new Date().toISOString() };
    return locked(async () => {
      const priorBriefs = await briefs(pid, branchName);
      if (brief.kind === "mrr" && priorBriefs.some((item) => item.kind === "mrr" && item.role === brief.role && item.head === brief.head)) {
        throw new Error(`Brief already issued for ${brief.role} on head ${String(brief.head).slice(0, 12)}; record that brief or commit a fix before minting a new one`);
      }
      return appendJsonl(branchFile("briefs", pid, branchName), brief);
    });
  }

  async function addReview(projectId, branch, value, { beforeAppend } = {}) {
    const targetProject = await project(projectId);
    const branchName = requiredString(branch, "Branch", 300);
    const review = { ...value, id: randomUUID(), projectId: targetProject.id, branch: branchName, recordedAt: new Date().toISOString() };
    return locked(async () => {
      const prior = await reviews(targetProject.id, branchName);
      if (review.runId && prior.some((item) => item.runId === review.runId)) {
        throw new Error("A review brief/run may be recorded only once");
      }
      if (beforeAppend) await beforeAppend(prior);
      const priorFindingCount = prior
        .filter((item) => item.kind === "mrr")
        .reduce((count, item) => count + (item.findings?.length || 0) + (item.unresolved?.length || 0), 0);
      await appendJsonl(branchFile("branches", targetProject.id, branchName), review);
      const assignedFindingIds = review.kind === "mrr"
        ? Array.from({ length: (review.findings?.length || 0) + (review.unresolved?.length || 0) }, (_, index) => `F${priorFindingCount + index + 1}`)
        : [];
      return { review, assignedFindingIds };
    });
  }

  const FORBIDDEN_ACCEPT_ACTORS = new Set(["agent", "assistant", "claude", "codex", "cursor", "agy", "devin", "owner", "builder"]);

  async function addDisposition(projectId, branch, value, { validFindingIds = null } = {}) {
    const targetProject = await project(projectId);
    const branchName = requiredString(branch, "Branch", 300);
    const findingId = requiredString(value.findingId, "Finding ID", 20).toUpperCase();
    const actor = requiredString(value.actor, "Acceptance actor (--actor)", 200);
    if (FORBIDDEN_ACCEPT_ACTORS.has(actor.toLowerCase())) {
      throw new Error(`Acceptance actor '${actor}' must name the human who accepted ${findingId}, not an agent`);
    }
    const disposition = {
      id: randomUUID(),
      projectId: targetProject.id,
      branch: branchName,
      findingId,
      reason: requiredString(value.reason, "Acceptance reason", 4000),
      actor,
      createdAt: new Date().toISOString()
    };
    return locked(async () => {
      if (validFindingIds && !validFindingIds.has(findingId)) {
        throw new Error(`Unknown MRR finding ${findingId} on ${targetProject.id}/${branchName}`);
      }
      await appendJsonl(branchFile("dispositions", targetProject.id, branchName), disposition);
      return disposition;
    });
  }

  const PROMPT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

  async function pruneOldPromptFiles(dir, keepFile) {
    let entries;
    try { entries = await readdir(dir); } catch { return; }
    const cutoff = Date.now() - PROMPT_RETENTION_MS;
    await Promise.all(entries.filter((name) => name.endsWith(".jsonl") && path.join(dir, name) !== keepFile).map(async (name) => {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) await rm(file, { force: true });
      } catch {}
    }));
  }

  function sessionKey(sessionId) {
    return encodeURIComponent(optionalString(sessionId, "Session ID", 200) || "default").replaceAll(".", "%2E");
  }

  async function appendPrompt(projectId, entry) {
    const pid = id(projectId, "Project ID");
    const sid = optionalString(entry.sessionId, "Session ID", 200) || "default";
    const record = {
      id: randomUUID(),
      ts: entry.ts || new Date().toISOString(),
      host: optionalString(entry.host, "Host", 60) || "unknown",
      sessionId: sid,
      branch: optionalString(entry.branch, "Branch", 300) || "HEAD",
      head: optionalString(entry.head, "HEAD SHA", 60),
      prompt: requiredString(entry.prompt, "Prompt", 100_000)
    };
    const promptDir = path.join(root, "prompts", pid);
    const targetFile = path.join(promptDir, `${sessionKey(sid)}.jsonl`);
    return locked(async () => {
      await appendJsonl(targetFile, record);
      await pruneOldPromptFiles(promptDir, targetFile);
      return record;
    });
  }

  async function prompts(projectId, sessionId = null) {
    const pid = id(projectId, "Project ID");
    if (sessionId) {
      return readJsonl(path.join(root, "prompts", pid, `${sessionKey(sessionId)}.jsonl`), { strict: false });
    }
    let files;
    try { files = (await readdir(path.join(root, "prompts", pid))).filter((f) => f.endsWith(".jsonl")).sort(); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const all = (await Promise.all(files.map((file) => readJsonl(path.join(root, "prompts", pid, file), { strict: false })))).flat();
    return all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }

  async function promptSessions(projectId) {
    const pid = id(projectId, "Project ID");
    let files;
    try { files = (await readdir(path.join(root, "prompts", pid))).filter((f) => f.endsWith(".jsonl")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const summaries = [];
    for (const file of files) {
      const items = await readJsonl(path.join(root, "prompts", pid, file), { strict: false });
      if (!items.length) continue;
      summaries.push({
        sessionId: decodeBranchKey(file.slice(0, -".jsonl".length)),
        count: items.length,
        lastTs: items[items.length - 1].ts
      });
    }
    return summaries.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
  }

  async function saveReport(projectId, branch, markdown) {
    const file = branchFile("reports", projectId, branch, "md");
    await writeTextAtomic(file, `${String(markdown).trim()}\n`);
    return file;
  }

  async function readReport(projectId, branch) {
    try { return await readFile(branchFile("reports", projectId, branch, "md"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function trackedBranches(projectId) {
    try {
      const files = await readdir(path.join(root, "branches", id(projectId, "Project ID")));
      return files
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => decodeBranchKey(file.slice(0, -".jsonl".length)))
        .sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function removeProject(projectId) {
    const target = await project(projectId);
    return locked(async () => {
      const branches = await trackedBranches(target.id);
      for (const folder of ["branches", "dispositions", "reports", "briefs", "prompts"]) {
        await rm(path.join(root, folder, target.id), { recursive: true, force: true });
      }
      await rm(path.join(root, "projects", `${target.id}.json`), { force: true });
      return { project: target.id, branches };
    });
  }

  return {
    root,
    init,
    projects,
    project,
    saveProject,
    updateProject,
    removeProject,
    reviews,
    dispositions,
    briefs,
    addBrief,
    addReview,
    addDisposition,
    appendPrompt,
    prompts,
    promptSessions,
    saveReport,
    readReport,
    trackedBranches
  };
}
