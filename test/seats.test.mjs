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
import { agyReviewCommand, devinReviewCommand } from "../src/machines.mjs";

const exec = promisify(execFile);
const cli = path.resolve("bin/fr.mjs");
const example = JSON.parse(await readFile(EXAMPLE_SEATS, "utf8"));
const clone = () => structuredClone(example);
const neon = { models: [{ id: "gemini-4-neon", launch: "cursor", cliModel: "gemini-4-neon-high" }] };
const withNeon = () => ({ ...clone(), seats: { ...clone().seats, "structural-challenge": neon } });

test("the example config seats the historical panel and passes validation", () => {
  const config = parseSeatConfig(example);
  assert.deepEqual(Object.fromEntries(Object.entries(config.seats).map(([role, seat]) => [role, [seat.provider, seat.models[0].id]])), {
    "deep-code-review": ["openai", "gpt-6-astra"],
    "structural-challenge": ["xai", "grok-4.6"],
    "fable-challenge": ["anthropic", "claude-opus-5-5"]
  });
});

test("config file rejects ambiguous or single-provider panels", () => {
  const broken = (edit) => { const raw = clone(); edit(raw); return () => parseSeatConfig(raw); };
  assert.throws(broken((raw) => { raw.schemaVersion = 2; }), /schemaVersion must be 1/);
  assert.throws(broken((raw) => { delete raw.seats["fable-challenge"]; }), /missing seat fable-challenge/);
  assert.throws(broken((raw) => { raw.seats["cheap-review"] = neon; }), /unknown seat cheap-review/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"] = { models: [{ id: "gpt-5.6-sol", launch: "codex" }] }; }), /three different providers \(got openai, openai, anthropic\)/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"].models.push({ id: "gemini-4-neon", launch: "cursor" }); }), /mixes providers/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"] = { models: [{ id: "muse-spark-1.3", launch: "cursor" }] }; }), /matches no configured provider prefix/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"] = { models: [{ id: "gemini-4-neon-high", launch: "cursor" }] }; }), /bare model id without a cursor- prefix or effort suffix/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"].models[0].launch = "ssh"; }), /launch must be one of codex, claude, cursor, devin, agy/);
  assert.throws(broken((raw) => { raw.providers.openai.prefixes.push("claude-"); }), /overlaps/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"].acccept = "listed"; }), /unknown key "acccept"/);
  assert.throws(broken((raw) => { raw.seats["structural-challenge"].models[0].cliModel = "grok; rm -rf ~"; }), /cliModel must be one token/);
  assert.throws(broken((raw) => { raw.accept = "any"; }), /accept must be provider or listed/);
});

test("a configured Gemini seat needs no code change and makes Grok the substitution", () => {
  try {
    useSeatConfig(withNeon());
    const seated = seatingFor("structural-challenge");
    assert.deepEqual([seated.intended, seated.intendedProvider, seated.substituted], ["gemini-4-neon", "google", false]);
    assert.equal(seatingFor("structural-challenge", "gemini-4-neon-xhigh").substituted, false);
    assert.equal(seatingFor("structural-challenge", "grok-4.6").substituted, true);
  } finally { useSeatConfig(null); }
});

test("a listed seat takes only its listed models unless the user approves another in session", () => {
  try {
    const raw = clone();
    raw.seats["structural-challenge"].accept = "listed";
    useSeatConfig(raw);
    assert.equal(seatingFor("structural-challenge", "grok-4.6-high").substituted, false);
    assert.equal(seatingFor("structural-challenge", "grok-4.7").substituted, true);
    assert.equal(seatingFor("deep-code-review", "gpt-7").substituted, false, "other seats keep the provider default");
    const approved = seatingFor("structural-challenge", "grok-4.7", null, "User: use grok-4.7 for this panel");
    assert.deepEqual([approved.substituted, approved.userApproved, approved.seatModels], [false, "User: use grok-4.7 for this panel", ["grok-4.6"]]);
    assert.equal(seatingFor("structural-challenge", "gpt-6-astra", null, "ok").substituted, true, "approval never covers another provider");
  } finally { useSeatConfig(null); }
});

test("Devin and Antigravity seats print their headless review recipes", () => {
  try {
    const raw = clone();
    raw.providers.cognition = { prefixes: ["swe-"] };
    raw.providers.google = { prefixes: ["gemini-"] };
    raw.seats["deep-code-review"] = { models: [{ id: "swe-1.6", launch: "devin" }] };
    raw.seats["structural-challenge"] = { models: [{ id: "gemini-4-neon", launch: "agy", cliModel: "gemini-4-neon-high" }] };
    useSeatConfig(raw);
    assert.equal(devinReviewCommand({ promptFile: "/tmp/p.txt", cwd: "/repo", model: "swe-1.6" }), 'cd "/repo" && devin --model swe-1.6 --permission-mode normal --respect-workspace-trust false --prompt-file "/tmp/p.txt" --print');
    assert.equal(agyReviewCommand({ promptFile: "/tmp/p.txt", cwd: "/repo", model: "gemini-4-neon" }), 'cd "/repo" && agy --model gemini-4-neon-high --mode plan --sandbox --output-format stream-json --input-format text --print < "/tmp/p.txt"');
  } finally { useSeatConfig(null); }
});

test("editing the config later does not reinterpret recorded seating", () => {
  const head = "a".repeat(40), baseHead = "b".repeat(40), claim = "Ship it";
  const brief = (role, model, intendedModel, intendedProvider) => ({ id: crypto.randomUUID(), event: "created", type: "review", kind: "mrr", role, claim, claimRevision: 1, head, baseHead, model, route: "cli", ownerTaskIdAtBrief: "owner", intendedModel, intendedProvider });
  const envelope = (delegation, reviewerTaskId) => validateReview({
    reviewComplete: true, independent: true, verdict: "GO", kind: "mrr", role: delegation.role, delegationId: delegation.id, claim, reviewerTaskId, head, baseHead, model: delegation.model, route: "cli",
    findings: [], unresolved: [], summary: "Clean.",
    scores: { mergeReadiness: 90, structuralRisk: 10, implementationQuality: 80, evidenceConfidence: 90, outcomeConfidence: 80 },
    scoreRationale: { mergeReadiness: "n", structuralRisk: "n", implementationQuality: "n", evidenceConfidence: "n", outcomeConfidence: "n" },
    necessity: "necessary", simplerPath: "None found.", scopeDrift: "none", contractIntegrity: "sound", evidenceQuality: "strong"
  }, delegation);
  const delegations = [
    brief("deep-code-review", "gpt-6-astra", "gpt-6-astra", "openai"),
    brief("structural-challenge", "grok-4.6", "grok-4.6", "xai"),
    brief("fable-challenge", "claude-opus-5-5", "claude-opus-5-5", "anthropic")
  ];
  const reviews = delegations.map((delegation, index) => envelope(delegation, `run-${index}`));
  const args = { kind: "mrr", target: { head, baseHead }, workstream: { claim, claimRevision: 1, ownerTaskId: "owner" }, reviews, delegations };
  assert.equal(evaluateGate(args).ready, true);
  try {
    useSeatConfig(withNeon());
    assert.equal(evaluateGate(args).ready, true, "a Grok GO briefed under the old config still fills its job");
    assert.equal(evaluateGate(args).notes.length, 0);
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
  assert.match(machine, /structural-challenge: xai \(accepts any model from this provider\)\n  intended: grok-4\.6 via cursor \(cursor-grok-4\.6-high\)/);
  assert.match(machine, /fable-challenge: anthropic \(accepts any model from this provider\)\n  intended: claude-opus-5-5 via claude\n  next: claude-fable-5-1 via claude/);
  await writeFile(seats, JSON.stringify(withNeon()));
  const brief = JSON.parse(await run(["review", "brief", "outcome", "--kind", "mrr", "--role", "structural-challenge"]));
  assert.equal(brief.delegation.intendedModel, "gemini-4-neon");
  assert.equal(brief.delegation.intendedProvider, "google");
  assert.equal(brief.execution.launch, "fr-cursor-review --model gemini-4-neon-high --print --output-format stream-json --sandbox enabled --trust < <prompt>");
});
