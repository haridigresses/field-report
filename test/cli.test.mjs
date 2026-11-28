import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
const ghWrapper = path.resolve("bin/fr-gh.mjs");

test("end-to-end branch-keyed loop: zero registration, worktree support, convergent single-seat rerun, fr accept, and PR-open gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-e2e-"));
  const repo = path.join(root, "repo");
  const wt = path.join(root, "repo-wt");
  const origin = path.join(root, "origin.git");
  const state = path.join(root, "state");
  const binDir = path.join(root, "mock-bin");
  const configFile = path.join(root, "config.json");

  await mkdir(binDir, { recursive: true });

  // Mock claude binary that inspects the prompt to know which seat is running:
  // - design returns NO_GO on first commit (when marker "FIXED" is absent in repo/feature.txt), then GO once fixed!
  // - correctness and intent return GO (and intent emits intentSummary from USER CONTRACT).
  const mockClaude = path.join(binDir, "claude");
  const mockScript = [
    `#!${process.execPath}`,
    `import { readFileSync } from "node:fs";`,
    `const prompt = process.argv[process.argv.length - 1] || "";`,
    `const runId = (prompt.match(/runId="([^"]+)"/) || [])[1];`,
    `const isIntent = prompt.includes("Seat: intent.");`,
    `const isDesign = prompt.includes("Seat: design.");`,
    `const isCrr = prompt.includes("CRR (pre-commit sanity check)");`,
    `const fixed = (() => { try { return readFileSync("feature.txt", "utf8").includes("FIXED"); } catch { return false; } })();`,
    `const base = {`,
    `  reviewComplete: true, independent: true, runId,`,
    `  scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 88, evidenceConfidence: 92, outcomeConfidence: 90 },`,
    `  scoreRationale: { mergeReadiness: "ok", structuralRisk: "low", implementationQuality: "good", evidenceConfidence: "high", outcomeConfidence: "aligned" }`,
    `};`,
    `if (isCrr) {`,
    `  console.log(JSON.stringify({ ...base, verdict: "GO", findings: [], summary: "CRR clean." }));`,
    `} else if (isDesign && !fixed) {`,
    `  console.log(JSON.stringify({ ...base, verdict: "NO_GO", findings: ["Simplify helper"], unresolved: [], questions: [], summary: "Needs trim.", necessity: "necessary", simplerPath: "Inline helper.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong" }));`,
    `} else {`,
    `  console.log(JSON.stringify({`,
    `    ...base, verdict: "GO", findings: [], unresolved: [], questions: [], summary: "Solid.",`,
    `    ...(isIntent ? { intentSummary: prompt.includes("Ship login gate") ? "Goal: Ship login gate." : "Goal: default." } : {}),`,
    `    necessity: "necessary", simplerPath: "None.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong"`,
    `  }));`,
    `}`
  ].join("\n");
  await writeFile(mockClaude, mockScript, { mode: 0o755 });

  const mockRealGh = path.join(binDir, "real-gh");
  await writeFile(mockRealGh, `#!/bin/sh\necho "REAL_GH $@"\n`, { mode: 0o755 });

  await writeFile(configFile, JSON.stringify({
    schemaVersion: 1,
    seats: {
      correctness: { models: [{ id: "claude-c", launch: "claude" }] },
      design: { models: [{ id: "claude-d", launch: "claude" }] },
      intent: { models: [{ id: "claude-i", launch: "claude" }] }
    }
  }));

  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "fr@example.invalid"]);
  await exec("git", ["-C", repo, "config", "user.name", "FR"]);
  await writeFile(path.join(repo, "feature.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "feature.txt"]);
  await exec("git", ["-C", repo, "commit", "-m", "base"]);
  await exec("git", ["clone", "--bare", repo, origin]);
  await exec("git", ["-C", repo, "remote", "add", "origin", origin]);
  await exec("git", ["-C", repo, "fetch", "origin"]);

  // Work inside a git worktree without any branch registration!
  await exec("git", ["-C", repo, "worktree", "add", "-b", "feat/login", wt]);

  const env = {
    ...process.env,
    ZDOTDIR: root,
    FIELD_REPORT_STATE_ROOT: state,
    FIELD_REPORT_CONFIG: configFile,
    FIELD_REPORT_REAL_GH: mockRealGh,
    FR_SESSION_ID: "sess-e2e",
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`
  };
  const runFr = (args, cwd = wt, input = null) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, ...args], { cwd, env }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
  });

  await runFr(["init"], repo);
  await runFr(["project", "add", "app", "--repo", repo, "--github", "owner/app"], repo);

  // User submits prompt in main `repo` folder (on `main` branch!).
  await runFr(["_hook", "prompt-submit"], repo, JSON.stringify({ session_id: "sess-e2e", cwd: repo, prompt: "Ship login gate" }));

  // Make working change in worktree, run stateless fr crr, then commit.
  await writeFile(path.join(wt, "feature.txt"), "v1\n");
  const crrOut = await runFr(["crr"], wt);
  assert.match(crrOut.stdout, /CRR \(claude-c\): GO/);

  await exec("git", ["-C", wt, "commit", "-am", "v1"]);

  // Before MRR, non-draft `gh pr create` fails; `--draft` succeeds!
  await assert.rejects(exec(process.execPath, [ghWrapper, "pr", "create", "--title", "Login"], { cwd: wt, env }), /BLOCKED 'gh pr create'/);
  const draftRes = await exec(process.execPath, [ghWrapper, "pr", "create", "--draft", "--title", "Login"], { cwd: wt, env });
  assert.match(draftRes.stdout, /REAL_GH pr create --draft/);
  assert.match(draftRes.stderr, /MRR has not been run yet/);

  // Run MRR on v1: correctness & intent GO, design NO_GO -> exits 1 (BLOCKED).
  let mrrV1;
  try { await runFr(["mrr"], wt); assert.fail("expected NO_GO exit 1"); }
  catch (err) { mrrV1 = err; }
  assert.match(mrrV1.stdout, /BLOCKED/);
  assert.match(mrrV1.stdout, /Goal: Ship login gate\./);
  assert.match(mrrV1.stdout, /F1: Simplify helper/);

  // Fix on v2 commit and run bare `fr mrr`: reruns ONLY `design`, carrying correctness & intent forward -> READY!
  await writeFile(path.join(wt, "feature.txt"), "v2 FIXED\n");
  await exec("git", ["-C", wt, "commit", "-am", "fix helper"]);
  const mrrV2 = await runFr(["mrr"], wt);
  assert.match(mrrV2.stdout, /READY \(carried; not reviewed on this HEAD by: correctness, intent\)/);

  // Now non-draft `gh pr create` passes through!
  const openRes = await exec(process.execPath, [ghWrapper, "pr", "create", "--title", "Login"], { cwd: wt, env });
  assert.match(openRes.stdout, /REAL_GH pr create --title Login/);

  // `fr status` works purely locally with zero GitHub calls.
  const statusRes = await runFr(["status"], wt);
  assert.match(statusRes.stdout, /READY \(carried/);
});
