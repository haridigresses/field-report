import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function run(command, args, cwd, timeout = 30_000) {
  try { return (await exec(command, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
  catch (error) { throw new Error(error.stderr?.trim() || error.message); }
}

export async function checkout(cwd = process.cwd()) {
  const [root, commonDir, branch, head, status] = await Promise.all([
    run("git", ["rev-parse", "--show-toplevel"], cwd),
    run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
    run("git", ["branch", "--show-current"], cwd),
    run("git", ["rev-parse", "HEAD"], cwd),
    run("git", ["status", "--porcelain"], cwd)
  ]);
  return { root, commonDir, branch: branch || "HEAD", head, dirty: Boolean(status) };
}

async function assertProjectCheckout(project, workstream, state) {
  const configuredCommonDir = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], project.repoPath);
  if (state.commonDir !== configuredCommonDir) throw new Error(`Checkout ${state.root} does not belong to project repository ${project.repoPath}`);
  if (workstream.branch && state.branch !== workstream.branch) throw new Error(`Checkout branch ${state.branch} does not match workstream branch ${workstream.branch}`);
}

export async function crrTarget(project, workstream, cwd = process.cwd()) {
  const state = await checkout(cwd);
  await assertProjectCheckout(project, workstream, state);
  const tree = await run("git", ["write-tree"], state.root);
  const diff = await run("git", ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--find-renames", "--stat"], state.root);
  if (!diff) throw new Error("CRR requires a non-empty staged diff");
  return { kind: "crr", head: state.head, baseHead: state.head, tree, branch: state.branch, repoRoot: state.root };
}

export async function mrrTarget(project, workstream, cwd = process.cwd()) {
  const state = await checkout(cwd);
  await assertProjectCheckout(project, workstream, state);
  const base = `refs/remotes/origin/${project.baseBranch || "main"}`;
  const localBaseTip = await run("git", ["rev-parse", base], state.root);
  const remote = await run("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${project.baseBranch || "main"}`], state.root);
  const remoteBaseTip = remote.split(/\s+/)[0];
  if (localBaseTip !== remoteBaseTip) throw new Error(`Local origin/${project.baseBranch || "main"} is stale; fetch origin before deriving the MRR target`);
  const baseHead = await run("git", ["merge-base", base, state.head], state.root);
  if (baseHead === state.head) throw new Error(`MRR requires a non-empty branch diff from origin/${project.baseBranch || "main"}`);
  return { kind: "mrr", head: state.head, baseHead, branch: state.branch, repoRoot: state.root };
}

export async function diffInventory(target) {
  const range = target.kind === "crr" ? [target.baseHead, target.tree] : [target.baseHead, target.head];
  const output = await run("git", ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--find-renames", ...range, "--"], target.repoRoot);
  let additions = 0;
  let deletions = 0;
  const files = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [added, deleted, ...name] = line.split("\t");
    additions += Number(added) || 0;
    deletions += Number(deleted) || 0;
    files.push(name.join("\t"));
  }
  return { files, additions, deletions };
}

export async function pullRequest(project, workstream, cwd = process.cwd()) {
  const selector = workstream.pullRequests.at(-1) || workstream.branch;
  if (!selector) throw new Error("Workstream has no linked pull request or branch");
  const args = ["pr", "view", String(selector), "--json", "number,state,isDraft,headRefName,headRefOid,baseRefName,statusCheckRollup"];
  if (project.githubRepo) args.push("--repo", project.githubRepo);
  return JSON.parse(await run("gh", args, cwd));
}
