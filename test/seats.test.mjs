import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { EXAMPLE_SEATS } from "./support/seats.mjs";
import { evaluateGate, seatingFor, validateReview } from "../src/policy.mjs";
import { parseSeatConfig, seatConfig, seatFor, useSeatConfig } from "../src/seats.mjs";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
const example = JSON.parse(await readFile(EXAMPLE_SEATS, "utf8"));
const clone = () => structuredClone(example);
const neon = { models: [{ id: "gemini-4-neon", launch: "cursor", cliModel: "gemini-4-neon-high" }] };
const withNeon = () => ({ ...clone(), seats: { ...clone().seats, "structural-challenge": neon } });

test("the example config seats the three-lab default panel", () => {
  const config = parseSeatConfig(example);
  assert.deepEqual(Object.fromEntries(Object.entries(config.seats).map(([role, seat]) => [role, seat.models.map((model) => model.id)])), {
    "deep-code-review": ["gpt-6-astra", "gpt-5.6-sol"],
    "structural-challenge": ["grok-4.6"],
    "fable-challenge": ["claude-opus-5-5", "claude-fable-5-1", "claude-fable-5"]
  });
});

test("config file rejects malformed seats", () => {
  const broken = (edit) => { const raw = clone(); edit(raw); return () => parseSeatConfig(raw); };
  assert.throws(broken((raw) => { raw.schemaVersion = 2; }), /schemaVersion must be 1/);
  assert.throws(broken((raw) => { delete raw.seats["fable-challenge"]; }), /missing seat fable-challenge/);
  assert.throws(broken((raw) => { raw.seats["cheap-review"] = neon; }), /unknown seat cheap-review/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"] = { models: [] }; }), /needs a non-empty models list/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"].models.push({ id: "grok-4.6", launch: "cursor", cliModel: "cursor-grok-4.6-high" }); }), /lists a model twice/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"] = { models: [{ id: "gpt-6-astra", launch: "cursor" }] }; }), /gpt-6-astra launches differently in two seats/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"] = { models: [{ id: "gemini-4-neon-high", launch: "cursor" }] }; }), /bare model id without a cursor- prefix or effort suffix/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"].models[0].launch = "ssh"; }), /launch must be one of codex, claude, cursor/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"].accept = "listed"; }), /unknown key "accept"/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"].models[0].cliModel = "grok; rm -rf ~"; }), /cliModel must be one token/);
  assert.throws(broken((raw) => { raw.providers = {}; }), /unknown key "providers"/);
});

test("any model, from any lab, can fill any seat the config lists it in", () => {
  const sameEverywhere = { schemaVersion: 1, seats: Object.fromEntries(["deep-code-review", "structural-challenge", "fable-challenge"].map((role) => [role, neon])) };
  try {
    useSeatConfig(sameEverywhere);
    for (const role of ["deep-code-review", "structural-challenge", "fable-challenge"]) assert.equal(seatingFor(role, "gemini-4-neon-xhigh").model, "gemini-4-neon");
    assert.throws(() => seatingFor("structural-challenge", "grok-4.6"), /not a valid structural-challenge model/);
  } finally { useSeatConfig(null); }
});

test("editing the config later does not reinterpret recorded reviews", () => {
  const head = "a".repeat(40), baseHead = "b".repeat(40), claim = "Ship it";
  const brief = (role) => ({ id: crypto.randomUUID(), event: "created", type: "review", kind: "mrr", role, claim, claimRevision: 1, head, baseHead, model: seatingFor(role).model, seatModels: seatingFor(role).seatModels, route: "cli", ownerTaskIdAtBrief: "owner" });
  const envelope = (delegation, reviewerTaskId) => validateReview({
    reviewComplete: true, independent: true, verdict: "GO", kind: "mrr", role: delegation.role, delegationId: delegation.id, claim, reviewerTaskId, head, baseHead, model: delegation.model, route: "cli",
    findings: [], unresolved: [], summary: "Clean.",
    scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 80, evidenceConfidence: 90, outcomeConfidence: 80 },
    scoreRationale: { mergeReadiness: "n", structuralRisk: "n", implementationQuality: "n", evidenceConfidence: "n", outcomeConfidence: "n" },
    necessity: "necessary", simplerPath: "None found.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong"
  }, delegation);
  const delegations = ["deep-code-review", "structural-challenge", "fable-challenge"].map(brief);
  const pending = brief("structural-challenge");
  const reviews = delegations.map((delegation, index) => envelope(delegation, `run-${index}`));
  const args = { kind: "mrr", target: { head, baseHead }, workstream: { claim, claimRevision: 1, ownerTaskId: "owner" }, reviews, delegations };
  assert.equal(evaluateGate(args).ready, true);
  try {
    useSeatConfig(withNeon());
    assert.equal(evaluateGate(args).ready, true, "a Grok GO briefed before Grok left the config still counts");
    assert.equal(envelope(pending, "late-grok").model, "grok-4.6", "a Grok brief issued before the edit still records");
  } finally { useSeatConfig(null); }
});

test("a missing config file explains how to create one", () => {
  const previous = process.env.FIELD_REPORT_CONFIG;
  try {
    process.env.FIELD_REPORT_CONFIG = path.join(os.tmpdir(), "fr-no-such-config.json");
    useSeatConfig(null);
    assert.throws(() => seatConfig(), /No Field Report config at .*fr-no-such-config\.json\. Copy config\/config\.example\.json/);
  } finally { process.env.FIELD_REPORT_CONFIG = previous; useSeatConfig(null); }
});

test("fr seats prints the resolved panel, and briefs follow the config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-seats-cli-"));
  const repo = path.join(root, "repo"), origin = path.join(root, "origin.git"), state = path.join(root, "state"), seats = path.join(root, "config.json");
  await writeFile(seats, JSON.stringify(clone()));
  const env = { ...process.env, FIELD_REPORT_STATE_ROOT: state, FIELD_REPORT_CONFIG: seats };
  delete env.CODEX_THREAD_ID;
  const run = async (args) => (await exec(process.execPath, [cli, ...args], { cwd: repo, env })).stdout;
  await exec("git", ["init", "-b", "main", repo]);
  for (const [key, value] of [["user.email", "fr-test@example.invalid"], ["user.name", "Field Report Test"]]) await exec("git", ["config", key, value], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "test\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  await exec("git", ["clone", "--bare", repo, origin]);
  await exec("git", ["remote", "add", "origin", origin], { cwd: repo });
  await exec("git", ["fetch", "origin"], { cwd: repo });
  await exec("git", ["checkout", "-b", "feature"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "feature\n");
  await exec("git", ["commit", "-am", "feature"], { cwd: repo });
  await run(["project", "add", "sample", "--label", "Sample", "--repo", repo]);
  await run(["create", "outcome", "--project", "sample", "--title", "Outcome", "--outcome", "Ship it", "--branch", "feature", "--owner-task", "owner-1"]);
  const machine = await run(["seats"]);
  assert.match(machine, new RegExp(`Config: ${seats}`));
  assert.match(machine, /structural-challenge:\n  default: grok-4\.6 via cursor \(cursor-grok-4\.6-high\)/);
  assert.match(machine, /fable-challenge:\n  default: claude-opus-5-5 via claude\n  also valid: claude-fable-5-1 via claude/);
  await writeFile(seats, JSON.stringify(withNeon()));
  const brief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge"]));
  assert.deepEqual([brief.delegation.model, brief.delegation.seatModels], ["gemini-4-neon", ["gemini-4-neon"]]);
  assert.equal(brief.execution.launch, "fr-cursor-review --model gemini-4-neon-high --print --output-format stream-json --sandbox enabled --trust < <prompt>");
});
