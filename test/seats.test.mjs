import "./support/seats.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { EXAMPLE_SEATS } from "./support/seats.mjs";
import { evaluateMrrGate, seatingFor, validateReview } from "../src/policy.mjs";
import { parseSeatConfig, seatConfig, useSeatConfig } from "../src/seats.mjs";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
const example = JSON.parse(await readFile(EXAMPLE_SEATS, "utf8"));
const clone = () => structuredClone(example);
const neon = { models: [{ id: "gemini-4-neon", launch: "agy", cliModel: "gemini-4-neon-high" }] };
const withNeon = () => ({ ...clone(), seats: { ...clone().seats, design: neon } });

test("the example config seats the three-lab default panel", () => {
  const config = parseSeatConfig(example);
  assert.deepEqual(Object.fromEntries(Object.entries(config.seats).map(([role, seat]) => [role, seat.models.map((model) => model.id)])), {
    correctness: ["gpt-6-astra", "gpt-5.6-sol"],
    design: ["grok-4.6"],
    intent: ["claude-opus-5-5", "claude-fable-5-1", "claude-fable-5"]
  });
});

test("config file accepts codex, claude, cursor, agy, devin, and native launchers and rejects malformed seats", () => {
  const multi = parseSeatConfig({
    schemaVersion: 1,
    seats: {
      correctness: { models: [{ id: "gpt-x", launch: "codex" }, { id: "devin-x", launch: "devin" }] },
      design: { models: [{ id: "gemini-4-neon", launch: "agy", cliModel: "gemini-4-neon-high" }, { id: "grok-4.6", launch: "cursor", cliModel: "cursor-grok-4.6-high" }] },
      intent: { models: [{ id: "claude-opus-5-5", launch: "claude" }, { id: "local-host", launch: "native" }] }
    }
  });
  assert.equal(multi.seats.design.models[0].launch, "agy");
  assert.equal(multi.seats.correctness.models[1].launch, "devin");
  assert.equal(multi.seats.intent.models[1].launch, "native");

  const broken = (edit) => { const raw = clone(); edit(raw); return () => parseSeatConfig(raw); };
  assert.throws(broken((raw) => { raw.schemaVersion = 2; }), /schemaVersion must be 1/);
  assert.throws(broken((raw) => { delete raw.seats.intent; }), /missing seat intent/);
  assert.throws(broken((raw) => { raw.seats["cheap-review"] = neon; }), /unknown seat cheap-review/);
  assert.throws(broken((raw) => { raw.seats["fable-challenge"] = raw.seats.intent; delete raw.seats.intent; }), /seats were renamed/);
  assert.throws(broken((raw) => { raw.seats.design = { models: [] }; }), /needs a non-empty models list/);
  assert.throws(broken((raw) => { raw.seats.design.models.push({ id: "grok-4.6", launch: "cursor", cliModel: "cursor-grok-4.6-high" }); }), /lists a model twice/);
  assert.throws(broken((raw) => { raw.seats.design = { models: [{ id: "gpt-6-astra", launch: "cursor" }] }; }), /gpt-6-astra launches differently in two seats/);
  assert.throws(broken((raw) => { raw.seats.design = { models: [{ id: "gemini-4-neon-high", launch: "cursor" }] }; }), /bare model id without a cursor- prefix or effort suffix/);
  assert.throws(broken((raw) => { raw.seats.design.models[0].launch = "ssh"; }), /launch must be one of codex, claude, cursor, agy, devin, native/);
  assert.throws(broken((raw) => { raw.seats.design.models[0].cliModel = "grok; rm -rf ~"; }), /cliModel must be one token/);
});

test("plans in the config file fail with a pointer to per-project plan homes", () => {
  assert.throws(() => parseSeatConfig({ ...clone(), plans: { home: "ref" } }), /plans moved to each project/);
});

test("editing the config later does not reinterpret recorded reviews", () => {
  const head = "a".repeat(40), baseHead = "b".repeat(40), branch = "feat/x";
  const makeBrief = (role) => ({ id: randomUUID(), kind: "mrr", role, branch, head, baseHead, model: seatingFor(role).model, seatModels: seatingFor(role).seatModels, route: "cli" });
  const makeReview = (brief) => validateReview({
    reviewComplete: true, independent: true, verdict: "GO", kind: "mrr", role: brief.role, runId: brief.id, branch, head, baseHead, model: brief.model, route: "cli",
    findings: [], unresolved: [], summary: "Clean.",
    ...(brief.role === "intent" ? { intentSummary: "Goal: ship x." } : {}),
    scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 85, evidenceConfidence: 90, outcomeConfidence: 85 },
    scoreRationale: { mergeReadiness: "r", structuralRisk: "r", implementationQuality: "r", evidenceConfidence: "r", outcomeConfidence: "r" },
    necessity: "necessary", simplerPath: "None.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong"
  }, brief);
  const briefs = ["correctness", "design", "intent"].map(makeBrief);
  const reviews = briefs.map(makeReview);
  assert.equal(evaluateMrrGate({ target: { branch, head, baseHead }, reviews }).ready, true);
  try {
    useSeatConfig(withNeon());
    assert.equal(evaluateMrrGate({ target: { branch, head, baseHead }, reviews }).ready, true);
  } finally {
    useSeatConfig(null);
  }
});

test("a missing config file explains how to create one", () => {
  const previous = process.env.FIELD_REPORT_CONFIG;
  try {
    process.env.FIELD_REPORT_CONFIG = path.join(os.tmpdir(), "fr-no-such-config.json");
    useSeatConfig(null);
    assert.throws(() => seatConfig(), /No Field Report config at .*fr-no-such-config\.json/);
  } finally {
    process.env.FIELD_REPORT_CONFIG = previous;
    useSeatConfig(null);
  }
});

test("fr seats prints the resolved panel and native --brief follows config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-seats-cli-"));
  const repo = path.join(root, "repo"), origin = path.join(root, "origin.git"), state = path.join(root, "state"), seats = path.join(root, "config.json");
  await writeFile(seats, JSON.stringify(withNeon()));
  const env = { ...process.env, FIELD_REPORT_STATE_ROOT: state, FIELD_REPORT_CONFIG: seats };
  const run = async (args) => (await exec(process.execPath, [cli, ...args], { cwd: repo, env })).stdout;

  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "fr@example.invalid"]);
  await exec("git", ["-C", repo, "config", "user.name", "FR"]);
  await writeFile(path.join(repo, "README.md"), "init\n");
  await exec("git", ["-C", repo, "add", "README.md"]);
  await exec("git", ["-C", repo, "commit", "-m", "init"]);
  await exec("git", ["clone", "--bare", repo, origin]);
  await exec("git", ["-C", repo, "remote", "add", "origin", origin]);
  await exec("git", ["-C", repo, "fetch", "origin"]);
  await exec("git", ["-C", repo, "checkout", "-b", "feat/demo"]);
  await writeFile(path.join(repo, "README.md"), "demo\n");
  await exec("git", ["-C", repo, "commit", "-am", "demo"]);

  await run(["project", "add", "sample", "--repo", repo]);
  const out = await run(["seats"]);
  assert.match(out, /design: gemini-4-neon \(agy:gemini-4-neon-high, default\)/);

  // --brief is refused unless the seat explicitly lists a launch="native" model.
  await assert.rejects(run(["mrr", "--brief", "--seat", "design"]), /has no model with launch="native"/);

  const withNative = { ...clone(), seats: { ...clone().seats, design: { models: [{ id: "gemini-4-neon", launch: "native" }] } } };
  await writeFile(seats, JSON.stringify(withNative));
  const briefOut = JSON.parse(await run(["mrr", "--brief", "--seat", "design"]));
  assert.equal(briefOut.brief.model, "gemini-4-neon");
  assert.deepEqual(briefOut.brief.seatModels, ["gemini-4-neon"]);
  // Minting a second brief on the same head is refused (prevents discarding a NO_GO).
  await assert.rejects(run(["mrr", "--brief", "--seat", "design"]), /Brief already issued for design on head/);
});
