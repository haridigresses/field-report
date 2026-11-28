import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function run(command, args, cwd, timeout = 30_000) {
  try { return (await exec(command, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
  catch (error) { throw new Error(error.stderr?.trim() || error.message); }
}

export async function gitCommonDir(cwd = process.cwd()) {
  try { return await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, 10_000); }
  catch { return null; }
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

async function assertProjectCheckout(project, state) {
  const configuredCommonDir = await gitCommonDir(project.repoPath);
  if (!configuredCommonDir || state.commonDir !== configuredCommonDir) {
    throw new Error(`Checkout ${state.root} does not belong to project repository ${project.repoPath}`);
  }
}

export async function projectForCheckout(projects, cwd = process.cwd()) {
  const current = await gitCommonDir(cwd);
  if (!current) return null;
  for (const project of projects) {
    const projectCommon = project.commonDir || await gitCommonDir(project.repoPath);
    if (projectCommon && projectCommon === current) return project;
  }
  return null;
}

export async function crrTarget(project, cwd = process.cwd()) {
  const state = await checkout(cwd);
  await assertProjectCheckout(project, state);
  const staged = await run("git", ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--find-renames", "--stat"], state.root);
  if (staged) {
    const tree = await run("git", ["write-tree"], state.root);
    return { kind: "crr", mode: "staged", project: project.id, head: state.head, baseHead: state.head, tree, branch: state.branch, repoRoot: state.root, commonDir: state.commonDir };
  }
  const working = await run("git", ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--stat", "HEAD", "--"], state.root);
  if (!working) throw new Error("CRR requires staged or tracked working-tree changes");
  return { kind: "crr", mode: "working", project: project.id, head: state.head, baseHead: state.head, tree: null, branch: state.branch, repoRoot: state.root, commonDir: state.commonDir };
}

export async function mrrTarget(project, cwd = process.cwd(), explicitBranch = null) {
  const state = await checkout(cwd);
  await assertProjectCheckout(project, state);
  const baseBranch = project.baseBranch || "main";
  const branch = explicitBranch || state.branch;
  if (branch === "HEAD") throw new Error("MRR requires a named feature branch (checkout is in detached HEAD state)");
  if (branch === baseBranch) throw new Error(`MRR runs on a feature branch, not ${baseBranch}`);
  const head = explicitBranch ? await run("git", ["rev-parse", `refs/heads/${branch}`], state.root) : state.head;
  const base = `refs/remotes/origin/${baseBranch}`;
  const baseHead = await run("git", ["merge-base", base, head], state.root);
  if (baseHead === head) throw new Error(`MRR requires a non-empty branch diff from origin/${baseBranch}`);
  return { kind: "mrr", project: project.id, branch, head, baseHead, baseBranch, repoRoot: state.root, commonDir: state.commonDir };
}

export async function diffInventory(target) {
  const range = target.kind === "crr"
    ? (target.tree ? [target.baseHead, target.tree] : ["HEAD"])
    : [target.baseHead, target.head];
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

export async function commitLog(repoRoot, baseHead, head, maxChars = 12_000) {
  try {
    const text = await run("git", ["log", "--reverse", "--format=%h %s%n%b", `${baseHead}..${head}`], repoRoot);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
  } catch {
    return "";
  }
}

export async function branchStartTimestamp(repoRoot, baseHead, head) {
  try {
    const iso = await run("git", ["log", "--reverse", "--format=%cI", `${baseHead}..${head}`], repoRoot);
    const first = iso.split("\n").find(Boolean);
    return first ? new Date(first).getTime() : null;
  } catch {
    return null;
  }
}

export async function readMergeRules(repoRoot) {
  try { return (await readFile(path.join(repoRoot, "merge-ready-review.md"), "utf8")).trim(); }
  catch { return null; }
}

export async function detectRepoBrr(repoRoot, changedFiles = []) {
  const planFiles = changedFiles.filter((file) => /^docs\/plans\/.+\.md$/i.test(file));
  if (!planFiles.length) return null;
  const chosen = planFiles[planFiles.length - 1];
  try {
    const content = (await readFile(path.join(repoRoot, chosen), "utf8")).trim();
    return content ? { source: chosen, text: content } : null;
  } catch {
    return null;
  }
}

export async function pullRequest(project, selector, cwd = process.cwd(), { ghBin = "gh" } = {}) {
  if (!selector) throw new Error("Branch or pull request number is required");
  const args = ["pr", "view", String(selector), "--json", "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,statusCheckRollup"];
  if (project.githubRepo) args.push("--repo", project.githubRepo);
  const pr = JSON.parse(await run(ghBin, args, cwd));
  return { ...pr, reviewThreads: await reviewThreads(project, pr.number, cwd, { ghBin }) };
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){viewer{login}repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount nodes{isResolved path line originalLine comments(first:1){totalCount nodes{author{__typename login}body}}lastComments:comments(last:1){nodes{author{__typename login}body}}}}}}}`;

// Fetches review threads with opener type (Bot vs User), comment count, and
// whether the signed-in viewer already posted the latest reply, preventing
// agent comment-spam loops on human or already-answered threads.
export async function reviewThreads(project, number, cwd = process.cwd(), { ghBin = "gh" } = {}) {
  const slug = project.githubRepo || (await run(ghBin, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd)).trim();
  const [owner, name] = slug.split("/");
  const data = JSON.parse(await run(ghBin, ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`], cwd));
  const viewer = data.data?.viewer?.login || null;
  const threads = data.data.repository.pullRequest.reviewThreads;
  if (threads.totalCount > threads.nodes.length) throw new Error(`PR #${number} has ${threads.totalCount} review threads; Field Report reads the first ${threads.nodes.length}`);
  return threads.nodes.map((thread) => {
    const first = thread.comments?.nodes?.[0] || {};
    const last = thread.lastComments?.nodes?.[0] || first;
    const commentCount = thread.comments?.totalCount ?? (first.body ? 1 : 0);
    const author = first.author?.login || "unknown";
    const openerType = first.author?.__typename === "Bot" || /\[bot\]$/i.test(author) ? "Bot" : "User";
    const lastAuthor = last.author?.login || author;
    return {
      resolved: Boolean(thread.isResolved),
      path: thread.path,
      line: thread.line ?? thread.originalLine ?? null,
      author,
      openerType,
      commentCount,
      lastAuthor,
      viewerRepliedLast: Boolean(viewer && commentCount > 1 && lastAuthor === viewer),
      body: first.body || ""
    };
  });
}

export async function ancestorHeads(repoRoot, heads, head) {
  const result = new Map([[head, 0]]);
  await Promise.all([...new Set(heads)].filter((item) => item && item !== head).map(async (item) => {
    try {
      await exec("git", ["merge-base", "--is-ancestor", item, head], { cwd: repoRoot, timeout: 10_000 });
      result.set(item, Number(await run("git", ["rev-list", "--count", `${item}..${head}`], repoRoot)));
    } catch {}
  }));
  return result;
}
