import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { collectBattlefield, readOrCollectBattlefield } from "../src/collect.mjs";
import { validateReview } from "../src/policy.mjs";
import { createStore } from "../src/store.mjs";

const exec = promisify(execFile);

function makeMrrReview(role, model, { branch, head, baseHead, verdict = "GO", findings = [], questions = [] }) {
  return validateReview({
    runId: randomUUID(),
    kind: "mrr",
    role,
    branch,
    head,
    baseHead,
    model,
    route: "cli",
    reviewComplete: true,
    independent: true,
    verdict,
    findings,
    unresolved: [],
    questions,
    summary: `${role} ${verdict}`,
    ...(role === "intent" ? { intentSummary: "Goal: ship battlefield UI." } : {}),
    scores: { mergeReadiness: 90, structuralRisk: 15, implementationQuality: 88, evidenceConfidence: 90, outcomeConfidence: 90 },
    scoreRationale: { mergeReadiness: "ok", structuralRisk: "low", implementationQuality: "good", evidenceConfidence: "high", outcomeConfidence: "aligned" },
    necessity: "necessary",
    simplerPath: "None.",
    scopeDrift: "none",
    contractIntegrity: "sound",
    evidenceQuality: "strong"
  });
}

test("collectBattlefield classifies ready-to-merge, needs-human, retires merged branches, sanitizes PR URLs, and handles offline repos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-battlefield-"));
  const repo = path.join(root, "repo");
  const wtNeedsHuman = path.join(root, "wt-blocked");
  const origin = path.join(root, "origin.git");
  const store = createStore(path.join(root, "state"));

  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "fr@example.invalid"]);
  await exec("git", ["-C", repo, "config", "user.name", "FR"]);
  await writeFile(path.join(repo, "f.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "f.txt"]);
  await exec("git", ["-C", repo, "commit", "-m", "base"]);
  const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();

  // Create a merged historical branch that equals main (should be retired from live battlefield).
  await exec("git", ["-C", repo, "branch", "feat/already-merged", baseSha]);

  await exec("git", ["clone", "--bare", repo, origin]);
  await exec("git", ["-C", repo, "remote", "add", "origin", origin]);
  await exec("git", ["-C", repo, "fetch", "origin"]);

  // Branch 1: checked out in main repo, 3-seat GO + clean + green PR -> ready-to-merge!
  await exec("git", ["-C", repo, "checkout", "-b", "feat/ready"]);
  await writeFile(path.join(repo, "f.txt"), "ready\n");
  await exec("git", ["-C", repo, "commit", "-am", "ship ready feature"]);
  const readyHead = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();

  // Branch 2: checked out in linked worktree, has NO_GO finding + javascript: PR URL -> needs-human + URL stripped!
  await exec("git", ["-C", repo, "worktree", "add", "-b", "feat/needs-call", wtNeedsHuman, baseSha]);
  await writeFile(path.join(wtNeedsHuman, "f.txt"), "wip\n");
  await exec("git", ["-C", wtNeedsHuman, "commit", "-am", "wip"]);
  const blockedHead = (await exec("git", ["-C", wtNeedsHuman, "rev-parse", "HEAD"])).stdout.trim();

  await store.saveProject({ id: "app", label: "App", repoPath: repo, githubRepo: "acme/app" });
  await store.saveProject({ id: "offline", label: "Offline Volume", repoPath: path.join(root, "unmounted-disk") });

  await store.addReview("app", "feat/already-merged", makeMrrReview("correctness", "gpt-6-astra", { branch: "feat/already-merged", head: baseSha, baseHead: baseSha }));

  for (const [role, model] of [["correctness", "gpt-6-astra"], ["design", "grok-4.6"], ["intent", "claude-opus-5-5"]]) {
    await store.addReview("app", "feat/ready", makeMrrReview(role, model, { branch: "feat/ready", head: readyHead, baseHead: baseSha }));
  }
  await store.addReview("app", "feat/needs-call", makeMrrReview("correctness", "gpt-6-astra", {
    branch: "feat/needs-call",
    head: blockedHead,
    baseHead: baseSha,
    verdict: "NO_GO",
    findings: ["Fix edge case"],
    questions: ["Should expired tokens retry?"]
  }));

  const fakePrs = [
    {
      number: 10,
      title: "Ship ready feature",
      url: "https://github.com/acme/app/pull/10",
      state: "OPEN",
      isDraft: false,
      headRefName: "feat/ready",
      headRefOid: readyHead,
      baseRefName: "main",
      updatedAt: "2026-11-28T08:00:00Z",
      statusCheckRollup: [{ conclusion: "SUCCESS" }]
    },
    {
      number: 11,
      title: "WIP feature",
      url: "javascript:alert(1)",
      state: "OPEN",
      isDraft: true,
      headRefName: "feat/needs-call",
      headRefOid: blockedHead,
      baseRefName: "main",
      updatedAt: "2026-11-28T08:05:00Z",
      statusCheckRollup: []
    }
  ];

  const realExec = (cmd, args, cwd) => exec(cmd, args, { cwd }).then(({ stdout }) => ({ ok: true, value: stdout.trim() }), (e) => ({ ok: false, error: e.message }));
  const runCmd = async (cmd, args, cwd) => {
    if (cmd === "mock-gh" && args[0] === "pr" && args[1] === "list") {
      return { ok: true, value: JSON.stringify(fakePrs) };
    }
    return realExec(cmd, args, cwd);
  };

  const projection = await collectBattlefield({
    store,
    ghBin: "mock-gh",
    runCmd,
    fetchThreadsFn: async (_proj, num) => (num === 10
      ? [{ resolved: true, openerType: "Bot", author: "bot", path: "f.txt", line: 1, viewerRepliedLast: false, body: "ok" }]
      : [{ resolved: false, openerType: "User", author: "alice", path: "f.txt", line: 1, viewerRepliedLast: false, body: "question?" }])
  });

  assert.equal(projection.projects.length, 2);
  assert.match(projection.projects.find((p) => p.id === "offline").health.git, /offline/);

  // Merged branch is retired; ready-to-merge sorts ahead of needs-human!
  assert.deepEqual(projection.units.map((u) => [u.branch, u.stage]), [
    ["feat/ready", "ready-to-merge"],
    ["feat/needs-call", "needs-human"]
  ]);
  assert.equal(projection.units[0].mrr.intentSummary, "Goal: ship battlefield UI.");
  assert.equal(projection.units[1].pr.url, null, "non-http(s) PR URL must be stripped");
  assert.ok(projection.units[1].attention.some((a) => a.includes("reviewer question")));
  assert.ok(projection.units[1].attention.some((a) => a.includes("open MRR finding")));
  assert.ok(projection.units[1].attention.some((a) => a.includes("human comment")));

  // Cached projection is served without re-running collectBattlefield.
  const cached = await readOrCollectBattlefield({ store, collectFn: async () => { throw new Error("should read cache"); } });
  assert.equal(cached.units.length, 2);
});
