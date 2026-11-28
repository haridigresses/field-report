import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
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

export function parseGitHubSlug(remoteUrl) {
  const text = String(remoteUrl || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!text) return null;
  const httpsMatch = text.match(/^https?:\/\/[^/]+\/([^/\s]+\/[^/\s]+)$/i);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = text.match(/^(?:ssh:\/\/[^/]+\/|[^@/\s]+@[^:/\s]+:)([^/\s]+\/[^/\s]+)$/i);
  if (sshMatch) return sshMatch[1];
  const hostSlugMatch = text.match(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/([^/\s]+\/[^/\s]+)$/);
  if (hostSlugMatch) return hostSlugMatch[1];
  const plainSlugMatch = text.match(/^([^/\s:]+\/[^/\s:]+)$/);
  if (plainSlugMatch) return plainSlugMatch[1];
  return null;
}

export async function gitRemoteSlugs(cwd = process.cwd()) {
  try {
    const out = await run("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], cwd, 5_000);
    const slugs = new Set();
    for (const line of out.split("\n").filter(Boolean)) {
      const url = line.replace(/^remote\.[^\s]+\.url\s+/, "");
      const slug = parseGitHubSlug(url);
      if (slug) slugs.add(slug.toLowerCase());
    }
    return slugs;
  } catch {
    return new Set();
  }
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

async function computeWorkingTreeSha(repoRoot) {
  const indexPath = await run("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], repoRoot, 5_000);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fr-crr-idx-"));
  const tempIndex = path.join(tempDir, "index");
  try {
    try { await copyFile(indexPath, tempIndex); } catch {}
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    await exec("git", ["add", "-u"], { cwd: repoRoot, env, timeout: 15_000 });
    return (await exec("git", ["write-tree"], { cwd: repoRoot, env, timeout: 15_000 })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function crrTarget(project, cwd = process.cwd()) {
  const state = await checkout(cwd);
  await assertProjectCheckout(project, state);
  const staged = await run("git", ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--find-renames", "--stat"], state.root);
  if (staged) {
    const tree = await run("git", ["write-tree"], state.root);
    return { kind: "crr", mode: "staged", project: project.id, head: state.head, baseHead: state.head, tree, branch: state.branch, repoRoot: state.root, commonDir: state.commonDir };
  }
  const [working, untracked] = await Promise.all([
    run("git", ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--stat", "HEAD", "--"], state.root),
    run("git", ["ls-files", "--others", "--exclude-standard"], state.root)
  ]);
  if (!working) {
    if (untracked) throw new Error("Untracked files exist with nothing staged; stage new files with 'git add' before running 'fr crr'");
    throw new Error("CRR requires staged or tracked working-tree changes");
  }
  const tree = await computeWorkingTreeSha(state.root);
  return {
    kind: "crr",
    mode: "working",
    project: project.id,
    head: state.head,
    baseHead: state.head,
    tree,
    hasUntracked: Boolean(untracked),
    branch: state.branch,
    repoRoot: state.root,
    commonDir: state.commonDir
  };
}

export async function commitTreeState(cwd = process.cwd()) {
  const [root, commonDir, branch, stagedTree] = await Promise.all([
    run("git", ["rev-parse", "--show-toplevel"], cwd, 5_000),
    run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, 5_000),
    run("git", ["branch", "--show-current"], cwd, 5_000),
    run("git", ["write-tree"], cwd, 5_000)
  ]);
  let head = null;
  let headTree = null;
  try {
    head = await run("git", ["rev-parse", "HEAD"], cwd, 5_000);
    headTree = await run("git", ["rev-parse", "HEAD^{tree}"], cwd, 5_000);
  } catch {}
  return { root, commonDir, branch: branch || "HEAD", head, headTree, stagedTree };
}

export async function mrrTarget(project, cwd = process.cwd(), explicitBranch = null, explicitHeadOid = null) {
  const state = await checkout(cwd);
  await assertProjectCheckout(project, state);
  const baseBranch = project.baseBranch || "main";
  const branch = explicitBranch || state.branch;
  if (branch === "HEAD") throw new Error("MRR requires a named feature branch (checkout is in detached HEAD state)");
  if (branch === baseBranch) throw new Error(`MRR runs on a feature branch, not ${baseBranch}`);
  let head = state.head;
  if (explicitHeadOid) {
    head = explicitHeadOid;
  } else if (explicitBranch && explicitBranch !== state.branch) {
    try { head = await run("git", ["rev-parse", `refs/heads/${branch}`], state.root); }
    catch { head = await run("git", ["rev-parse", `refs/remotes/origin/${branch}`], state.root); }
  }
  const base = `refs/remotes/origin/${baseBranch}`;
  const baseHead = await run("git", ["merge-base", base, head], state.root);
  if (baseHead === head) throw new Error(`MRR requires a non-empty branch diff from origin/${baseBranch}`);
  return { kind: "mrr", project: project.id, branch, head, baseHead, baseBranch, repoRoot: state.root, commonDir: state.commonDir };
}

export async function resolvePullRequestRef(project, selector, cwd = process.cwd(), { ghBin = "gh" } = {}) {
  const args = ["pr", "view", String(selector), "--json", "number,headRefName,headRefOid,baseRefName"];
  if (project.githubRepo) args.push("--repo", project.githubRepo);
  const pr = JSON.parse(await run(ghBin, args, cwd));
  if (!pr?.headRefName || !pr?.headRefOid) throw new Error(`Could not resolve head branch for PR ${selector}`);
  return pr;
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

// Only plans already present on baseHead may be treated as authoritative BRR
// context; candidate-authored plan files added/edited in the branch's own diff
// (or arbitrary external files passed via --brr) never dominate USER CONTRACT.
// When docs/plans/ on baseHead contains a single signed-off plan (or a changed
// plan file already existed on baseHead), load its baseHead blob automatically.
export async function detectRepoBrr(repoRoot, baseHead, changedFiles = []) {
  if (!baseHead) return null;
  const planFiles = changedFiles.filter((file) => /^docs\/plans\/.+\.md$/i.test(file));
  for (let i = planFiles.length - 1; i >= 0; i -= 1) {
    const candidate = planFiles[i];
    try {
      const content = (await run("git", ["show", `${baseHead}:${candidate}`], repoRoot)).trim();
      if (content) return { source: `${candidate} @ ${baseHead.slice(0, 12)}`, text: content, authoritative: true };
    } catch {}
  }
  try {
    const listed = await run("git", ["ls-tree", "-r", "--name-only", baseHead, "docs/plans/"], repoRoot);
    const basePlans = listed.split("\n").filter((file) => /^docs\/plans\/.+\.md$/i.test(file)).sort();
    if (basePlans.length === 1) {
      const content = (await run("git", ["show", `${baseHead}:${basePlans[0]}`], repoRoot)).trim();
      if (content) return { source: `${basePlans[0]} @ ${baseHead.slice(0, 12)}`, text: content, authoritative: true };
    }
  } catch {}
  return null;
}

export async function verifyBrrAtBaseHead(repoRoot, baseHead, filePath, fileText) {
  if (!baseHead || !filePath) return { authoritative: false, source: filePath };
  const rel = path.relative(repoRoot, path.resolve(filePath)).replaceAll(path.sep, "/");
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    try {
      const baseContent = await run("git", ["show", `${baseHead}:${rel}`], repoRoot);
      if (baseContent.trim() === String(fileText || "").trim()) {
        return { authoritative: true, source: `${rel} @ ${baseHead.slice(0, 12)}` };
      }
    } catch {}
  }
  return { authoritative: false, source: filePath };
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

// Recorded heads strictly within baseHead..head (or ancestors of head when
// baseHead is omitted), mapped to how many commits behind head they are.
// Bounding to baseHead..head ensures a reused branch name never inherits GOs
// from an earlier branch that was already merged into base.
export async function ancestorHeads(repoRoot, heads, head, baseHead = null) {
  if (baseHead) {
    try {
      const out = await run("git", ["rev-list", `${baseHead}..${head}`], repoRoot);
      const commits = out ? out.split("\n").filter(Boolean) : [];
      const result = new Map();
      commits.forEach((sha, index) => result.set(sha, index));
      if (!result.has(head)) result.set(head, 0);
      return result;
    } catch {
      return new Map([[head, 0]]);
    }
  }
  const result = new Map([[head, 0]]);
  await Promise.all([...new Set(heads)].filter((item) => item && item !== head).map(async (item) => {
    try {
      await exec("git", ["merge-base", "--is-ancestor", item, head], { cwd: repoRoot, timeout: 10_000 });
      result.set(item, Number(await run("git", ["rev-list", "--count", `${item}..${head}`], repoRoot)));
    } catch {}
  }));
  return result;
}
