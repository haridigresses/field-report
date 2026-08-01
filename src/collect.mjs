import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createStore } from "./store.mjs";
import { evaluateGate, publicationReasons } from "./policy.mjs";

const exec = promisify(execFile);
const store = createStore();

async function command(name, args, cwd) {
  try { return { ok: true, value: (await exec(name, args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim() }; }
  catch (error) { return { ok: false, error: error.stderr?.trim() || error.message }; }
}

async function collectProject(project) {
  const [status, worktrees, prs] = await Promise.all([
    command("git", ["status", "--porcelain=v1", "--branch"], project.repoPath),
    command("git", ["worktree", "list", "--porcelain"], project.repoPath),
    project.githubRepo ? command("gh", ["pr", "list", "--repo", project.githubRepo, "--state", "open", "--limit", "100", "--json", "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeStateStatus,reviewDecision,statusCheckRollup"], project.repoPath) : { ok: true, value: "[]" }
  ]);
  const pullRequests = prs.ok ? JSON.parse(prs.value || "[]") : [];
  const parsedWorktrees = worktrees.ok ? worktrees.value.split("\n\n").filter(Boolean).map((block) => Object.fromEntries(block.split("\n").map((line) => { const split = line.indexOf(" "); return split < 0 ? [line, true] : [line.slice(0, split), line.slice(split + 1)]; }))) : [];
  const observedWorktrees = await Promise.all(parsedWorktrees.map(async (item) => {
    const live = await command("git", ["status", "--porcelain"], item.worktree);
    return { path: item.worktree, head: item.HEAD, branch: typeof item.branch === "string" ? item.branch.replace(/^refs\/heads\//, "") : null, dirty: live.ok ? Boolean(live.value) : null, error: live.ok ? null : live.error };
  }));
  const enrichedPullRequests = await Promise.all(pullRequests.map(async (pr) => {
    const base = await command("git", ["merge-base", `refs/remotes/origin/${project.baseBranch}`, pr.headRefOid], project.repoPath);
    return { ...pr, ...(base.ok ? { baseHead: base.value } : {}) };
  }));
  return {
    ...project,
    repository: status.ok ? { status: status.value, worktreeCount: observedWorktrees.length } : null,
    worktrees: observedWorktrees,
    pullRequests: enrichedPullRequests,
    health: { git: status.ok ? "ok" : status.error, github: prs.ok ? "ok" : prs.error }
  };
}

function delegationState(events) {
  const byId = new Map();
  for (const event of events) byId.set(event.id, { ...(byId.get(event.id) || {}), ...event });
  return [...byId.values()].map((item) => ({ ...item, status: item.event === "completed" ? (item.completed && !(item.unresolved || []).length ? "complete" : "incomplete") : item.event === "bound" ? "active" : "open" }));
}

function reviewStatus(stream, projectView, reviews) {
  const pr = projectView?.pullRequests.find((item) => stream.pullRequests.includes(item.number) || item.headRefName === stream.branch);
  if (!pr) return { ready: false, reasons: ["no current pull request"] };
  if (!pr.baseHead) return { ready: false, reasons: ["current PR base SHA could not be derived"] };
  return evaluateGate({ kind: "final", target: { kind: "final", head: pr.headRefOid, baseHead: pr.baseHead }, workstream: stream, reviews });
}

function publicationStatus(stream, projectView, finalReview) {
  const pr = projectView?.pullRequests.find((item) => stream.pullRequests.includes(item.number) || item.headRefName === stream.branch);
  if (!pr) return { ready: false, reasons: ["no current pull request"] };
  const checkout = projectView.worktrees.find((item) => item.branch === stream.branch);
  if (!checkout) return { ready: false, reasons: ["no observed checkout for the workstream branch"] };
  if (checkout.head !== pr.headRefOid) return { ready: false, reasons: ["workstream checkout head does not match the pull request head"] };
  if (checkout.dirty == null) return { ready: false, reasons: ["workstream checkout cleanliness could not be observed"] };
  const target = { head: pr.headRefOid, branch: stream.branch };
  const reasons = [...finalReview.reasons, ...publicationReasons({ project: projectView, target, checkout, pr })];
  return { ready: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export async function collect(output = process.env.FIELD_REPORT_PROJECTION || path.join(store.root, "projection.json")) {
  const projects = await Promise.all((await store.projects()).map(collectProject));
  const workstreams = await Promise.all((await store.workstreams()).map(async (stream) => {
    const reviews = await store.reviews(stream.id);
    const projectView = projects.find((project) => project.id === stream.project);
    const finalReview = reviewStatus(stream, projectView, reviews);
    return { ...stream, reviews, delegations: delegationState(await store.delegations(stream.id)), events: (await store.events(stream.id)).slice(-20).reverse(), projectView, finalReview, publication: publicationStatus(stream, projectView, finalReview) };
  }));
  const projection = { schemaVersion: 2, generatedAt: new Date().toISOString(), projects, workstreams };
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.next`;
  await writeFile(temporary, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, output);
  return projection;
}

if (import.meta.url === `file://${process.argv[1]}`) collect().then((projection) => process.stdout.write(`Refreshed ${projection.workstreams.length} workstreams.\n`)).catch((error) => { console.error(error); process.exitCode = 1; });
