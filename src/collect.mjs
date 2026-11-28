import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { findRealGh } from "../bin/fr-gh.mjs";
import { botsReasons, evaluateMrrGate, openReasons, readyLabel, REVIEW_ROLES } from "./policy.mjs";
import { ancestorHeads, gitRemoteSlugs, parseGitHubSlug, reviewThreads } from "./repository.mjs";
import { createStore } from "./store.mjs";

const exec = promisify(execFile);

async function defaultRunCmd(command, args, cwd, timeout = 25_000) {
  try {
    const { stdout } = await exec(command, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, value: stdout.trim() };
  } catch (error) {
    return { ok: false, error: error.stderr?.trim() || error.message };
  }
}

function parsePorcelainWorktrees(raw) {
  if (!raw) return [];
  return raw.split("\n\n").filter(Boolean).map((block) => {
    const obj = {};
    for (const line of block.split("\n")) {
      const idx = line.indexOf(" ");
      if (idx < 0) obj[line] = true;
      else obj[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return {
      path: obj.worktree || null,
      head: obj.HEAD || null,
      branch: typeof obj.branch === "string" ? obj.branch.replace(/^refs\/heads\//, "") : null
    };
  }).filter((item) => item.path);
}

function summarizeChecks(checks = []) {
  const accepted = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const check of checks) {
    if (check.conclusion) {
      if (accepted.has(check.conclusion)) passed += 1;
      else failed += 1;
    } else if (accepted.has(check.state)) {
      passed += 1;
    } else if (check.state === "FAILURE" || check.state === "ERROR") {
      failed += 1;
    } else {
      pending += 1;
    }
  }
  return { total: checks.length, passed, pending, failed };
}

function summarizeThreads(threads) {
  if (!Array.isArray(threads)) return null;
  const open = threads.filter((t) => !t.resolved);
  return {
    total: threads.length,
    resolved: threads.length - open.length,
    botOpen: open.filter((t) => t.openerType === "Bot").length,
    humanNeedsAction: open.filter((t) => t.openerType !== "Bot" && !t.viewerRepliedLast).length,
    humanAwaiting: open.filter((t) => t.openerType !== "Bot" && t.viewerRepliedLast).length
  };
}

function classifyUnit({ pr, mrr, bots, worktree }) {
  const attention = [];
  if (mrr.questions.length) {
    attention.push(`${mrr.questions.length} reviewer question${mrr.questions.length === 1 ? "" : "s"} for you`);
  }
  const openFindings = Object.values(mrr.seats).reduce((sum, s) => sum + (s.open?.length || 0), 0);
  if (openFindings > 0) {
    attention.push(`${openFindings} open MRR finding${openFindings === 1 ? "" : "s"}`);
  }

  if (pr) {
    if (!pr.isDraft && !mrr.ready) {
      attention.push(`open PR #${pr.number} without READY MRR`);
    }
    if (pr.checks.failed > 0) {
      attention.push(`${pr.checks.failed} failing CI check${pr.checks.failed === 1 ? "" : "s"}`);
    }
    if (pr.threads) {
      if (pr.threads.humanNeedsAction > 0) attention.push(`${pr.threads.humanNeedsAction} human comment${pr.threads.humanNeedsAction === 1 ? "" : "s"} needing reply/fix`);
      if (pr.threads.humanAwaiting > 0) attention.push(`${pr.threads.humanAwaiting} human thread${pr.threads.humanAwaiting === 1 ? "" : "s"} awaiting your/reviewer resolution`);
      if (pr.threads.botOpen > 0) attention.push(`${pr.threads.botOpen} unresolved bot thread${pr.threads.botOpen === 1 ? "" : "s"}`);
    }
    if (worktree?.dirty) {
      attention.push("dirty local worktree");
    }

    if (pr.isDraft) {
      return { stage: attention.length ? "needs-human" : "draft-ci", stageLabel: `PR #${pr.number} · Draft`, attention };
    }
    if (mrr.ready && bots?.ready && attention.length === 0) {
      return { stage: "ready-to-merge", stageLabel: `PR #${pr.number} · Ready to merge`, attention: ["Ready for your merge"] };
    }
    if (attention.length > 0 || !mrr.ready || (bots && !bots.ready)) {
      const fallbackReason = (!mrr.ready ? mrr.reasons[0] : bots?.reasons?.[0]) || null;
      if (!attention.length && fallbackReason) attention.push(fallbackReason);
      return { stage: "needs-human", stageLabel: `PR #${pr.number} · Needs attention`, attention };
    }
    return { stage: "in-progress", stageLabel: `PR #${pr.number} · Open`, attention };
  }

  // No open PR yet:
  if (mrr.ready && !worktree?.dirty && attention.length === 0) {
    return { stage: "mrr-ready", stageLabel: "MRR READY (no PR)", attention: [] };
  }
  if (attention.length > 0) {
    return { stage: "needs-human", stageLabel: "MRR blocked / questions", attention };
  }
  return { stage: "in-progress", stageLabel: worktree ? "Local worktree" : "Tracked branch", attention };
}

async function resolveProjectSlug(project, runCmd) {
  if (project.githubRepo) return parseGitHubSlug(project.githubRepo) || project.githubRepo;
  const originOut = await runCmd("git", ["remote", "get-url", "origin"], project.repoPath, 5_000);
  if (originOut.ok) return parseGitHubSlug(originOut.value);
  const slugs = await gitRemoteSlugs(project.repoPath);
  return [...slugs][0] || null;
}

async function collectProject(project, { store, ghBin, runCmd, includeGitHub, fetchThreadsFn }) {
  const repoAccessible = await access(project.repoPath).then(() => true, () => false);
  if (!repoAccessible) {
    return {
      project: { ...project, health: { git: `repo path offline (${project.repoPath})`, github: "skipped" }, worktreeCount: 0 },
      units: []
    };
  }

  const baseBranch = project.baseBranch || "main";
  const slug = await resolveProjectSlug(project, runCmd);

  const [wtRes, trackedBranches, prsRes] = await Promise.all([
    runCmd("git", ["worktree", "list", "--porcelain"], project.repoPath, 10_000),
    store.trackedBranches(project.id),
    includeGitHub && slug
      ? runCmd(ghBin, [
          "pr", "list", "--repo", slug, "--state", "open", "--limit", "50",
          "--json", "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,reviewDecision,statusCheckRollup"
        ], project.repoPath, 20_000)
      : Promise.resolve({ ok: true, value: "[]", skipped: true })
  ]);

  if (!wtRes.ok) {
    return {
      project: { ...project, githubRepo: slug || project.githubRepo, health: { git: wtRes.error, github: "skipped" }, worktreeCount: 0 },
      units: []
    };
  }

  const rawWorktrees = parsePorcelainWorktrees(wtRes.value);
  const worktrees = await Promise.all(rawWorktrees.map(async (wt) => {
    const st = await runCmd("git", ["status", "--porcelain"], wt.path, 8_000);
    return { ...wt, dirty: st.ok ? Boolean(st.value) : false };
  }));

  let openPrs = [];
  let githubHealth = prsRes.skipped ? "local-only" : "ok";
  if (!prsRes.ok) {
    githubHealth = prsRes.error;
  } else {
    try { openPrs = JSON.parse(prsRes.value || "[]"); }
    catch (error) { githubHealth = `invalid gh JSON: ${error.message}`; openPrs = []; }
  }

  // Fetch calm review-thread metadata for open PRs (capped at first 20 open PRs per repo).
  const prByBranch = new Map();
  await Promise.all(openPrs.slice(0, 20).map(async (pr) => {
    let rawThreads = null;
    let threadsError = null;
    if (includeGitHub && slug) {
      try {
        rawThreads = await fetchThreadsFn({ ...project, githubRepo: slug }, pr.number, project.repoPath, { ghBin });
      } catch (error) {
        threadsError = error.message;
      }
    }
    prByBranch.set(pr.headRefName, {
      ...pr,
      reviewThreads: rawThreads,
      threadsError,
      checks: summarizeChecks(pr.statusCheckRollup || []),
      threads: summarizeThreads(rawThreads)
    });
  }));
  for (const pr of openPrs.slice(20)) {
    if (!prByBranch.has(pr.headRefName)) {
      prByBranch.set(pr.headRefName, {
        ...pr,
        reviewThreads: null,
        threadsError: "skipped (>20 open PRs)",
        checks: summarizeChecks(pr.statusCheckRollup || []),
        threads: null
      });
    }
  }

  const candidateBranches = new Set();
  for (const wt of worktrees) {
    if (!wt.branch || wt.branch === "HEAD") continue;
    if (wt.branch !== baseBranch || wt.dirty) candidateBranches.add(wt.branch);
  }
  for (const branchName of prByBranch.keys()) {
    if (branchName) candidateBranches.add(branchName);
  }
  for (const branchName of trackedBranches) {
    if (branchName && branchName !== baseBranch) candidateBranches.add(branchName);
  }

  const units = [];
  for (const branchName of [...candidateBranches].sort()) {
    const worktree = worktrees.find((wt) => wt.branch === branchName) || null;
    const pr = prByBranch.get(branchName) || null;
    const [reviews, dispositions] = await Promise.all([
      store.reviews(project.id, branchName),
      store.dispositions(project.id, branchName)
    ]);

    let head = worktree?.head || pr?.headRefOid || null;
    if (!head) {
      const localRef = await runCmd("git", ["rev-parse", "--verify", `refs/heads/${branchName}`], project.repoPath, 5_000);
      if (localRef.ok) head = localRef.value;
    }
    if (!head) {
      // Branch was deleted locally and has no open PR or worktree — retire from live battlefield.
      continue;
    }

    let baseHead = null;
    const originBase = await runCmd("git", ["merge-base", `refs/remotes/origin/${baseBranch}`, head], project.repoPath, 5_000);
    if (originBase.ok) {
      baseHead = originBase.value;
    } else {
      const localBase = await runCmd("git", ["merge-base", `refs/heads/${baseBranch}`, head], project.repoPath, 5_000);
      if (localBase.ok) baseHead = localBase.value;
    }

    // Retire branches already merged into baseHead when there is no open PR and no dirty worktree.
    if (baseHead && baseHead === head && !pr && !worktree?.dirty) {
      continue;
    }

    const logRes = await runCmd("git", ["log", "-1", "--format=%s%n%cI", head], project.repoPath, 5_000);
    const [subject = "", committedAt = null] = logRes.ok ? logRes.value.split("\n") : [];

    const target = { kind: "mrr", project: project.id, branch: branchName, head, baseHead: baseHead || head };
    const ancestors = await ancestorHeads(worktree?.path || project.repoPath, reviews.map((r) => r.head), head, baseHead);
    const gate = evaluateMrrGate({ target, reviews, dispositions, ancestors });
    const checkoutExtra = worktree ? openReasons({ checkout: worktree, target }) : [];
    const mrrReasons = [...gate.reasons, ...checkoutExtra];
    const mrrReady = branchName !== baseBranch && Boolean(baseHead && baseHead !== head) && mrrReasons.length === 0;

    const seatsSummary = Object.fromEntries(REVIEW_ROLES.map((role) => {
      const s = gate.seats[role];
      const rev = s.review;
      return [role, {
        state: s.state,
        verdict: rev?.verdict || null,
        model: rev?.model || null,
        head: s.head || null,
        carried: Boolean(s.carried),
        behind: s.behind || 0,
        scores: rev?.scores || null,
        summary: rev?.summary || null,
        simplerPath: rev?.simplerPath || null,
        necessity: rev?.necessity || null,
        scopeDrift: rev?.scopeDrift || null,
        contractIntegrity: rev?.contractIntegrity || null,
        evidenceQuality: rev?.evidenceQuality || null,
        open: s.open || [],
        accepted: s.accepted || []
      }];
    }));

    const mrr = {
      ready: mrrReady,
      label: mrrReady ? readyLabel(gate) : (reviews.some((r) => r.kind === "mrr") ? "BLOCKED" : "UNREVIEWED"),
      reasons: branchName === baseBranch ? [`on base branch ${baseBranch}`] : mrrReasons,
      notes: gate.notes || [],
      questions: gate.questions || [],
      intentSummary: gate.intentSummary || null,
      seats: seatsSummary,
      reviewCount: reviews.filter((r) => r.kind === "mrr").length
    };

    let bots = null;
    if (pr) {
      const reasons = botsReasons({
        project: { ...project, baseBranch },
        target,
        checkout: worktree || { head: pr.headRefOid, dirty: false },
        pr
      });
      bots = {
        ready: mrr.ready && reasons.length === 0,
        reasons
      };
    }

    const prSummary = pr
      ? {
          number: pr.number,
          title: pr.title,
          url: /^https?:\/\//i.test(String(pr.url || "")) ? pr.url : null,
          state: pr.state,
          isDraft: Boolean(pr.isDraft),
          headRefOid: pr.headRefOid,
          baseRefName: pr.baseRefName,
          updatedAt: pr.updatedAt || null,
          reviewDecision: pr.reviewDecision || null,
          checks: pr.checks,
          threads: pr.threads,
          threadsError: pr.threadsError || null
        }
      : null;

    const classification = classifyUnit({ pr: prSummary, mrr, bots, worktree });
    const updatedAt = [
      pr?.updatedAt,
      committedAt,
      reviews[reviews.length - 1]?.recordedAt
    ].filter(Boolean).sort().pop() || new Date().toISOString();

    units.push({
      id: `${project.id}:${branchName}`,
      project: project.id,
      projectLabel: project.label || project.id,
      branch: branchName,
      head,
      baseHead,
      baseBranch,
      subject,
      committedAt: committedAt || null,
      updatedAt,
      worktree: worktree ? { path: worktree.path, head: worktree.head, dirty: worktree.dirty } : null,
      pr: prSummary,
      mrr,
      bots,
      stage: classification.stage,
      stageLabel: classification.stageLabel,
      attention: classification.attention
    });
  }

  return {
    project: {
      id: project.id,
      label: project.label || project.id,
      repoPath: project.repoPath,
      githubRepo: slug || project.githubRepo || null,
      baseBranch,
      todos: project.todos,
      plans: project.plans,
      worktreeCount: worktrees.length,
      openPrCount: openPrs.length,
      health: { git: "ok", github: githubHealth }
    },
    units
  };
}

const STAGE_ORDER = {
  "ready-to-merge": 0,
  "needs-human": 1,
  "mrr-ready": 2,
  "draft-ci": 3,
  "in-progress": 4
};

export async function collectBattlefield({
  store = createStore(),
  ghBin = findRealGh({ envPath: process.env.PATH, selfPath: path.join(os.homedir(), ".local", "bin", "gh") }) || "gh",
  runCmd = defaultRunCmd,
  includeGitHub = true,
  fetchThreadsFn = reviewThreads,
  outputFile = path.join(store.root, "projection.json")
} = {}) {
  const configured = await store.projects();
  const collected = await Promise.all(configured.map((project) => collectProject(project, {
    store,
    ghBin,
    runCmd,
    includeGitHub,
    fetchThreadsFn
  })));

  const projects = collected.map((item) => item.project);
  const units = collected
    .flatMap((item) => item.units)
    .sort((a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const projection = {
    schemaVersion: 7,
    generatedAt: new Date().toISOString(),
    projects,
    units
  };

  if (outputFile) {
    await mkdir(path.dirname(outputFile), { recursive: true });
    const temporary = `${outputFile}.${process.pid}.${Date.now()}.next`;
    await writeFile(temporary, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, outputFile);
  }
  return projection;
}

const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

export async function readOrCollectBattlefield({ store = createStore(), collectFn = collectBattlefield, maxAgeMs = CACHE_MAX_AGE_MS } = {}) {
  const file = path.join(store.root, "projection.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const ageMs = Date.now() - Date.parse(parsed?.generatedAt || "");
    if (parsed?.schemaVersion === 7 && Array.isArray(parsed.units) && Number.isFinite(ageMs) && ageMs <= maxAgeMs) {
      return parsed;
    }
  } catch {}
  return collectFn({ store, outputFile: file });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  collectBattlefield().then((projection) => {
    process.stdout.write(`Refreshed ${projection.units.length} active branch(es) across ${projection.projects.length} project(s).\n`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
