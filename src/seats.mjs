import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Field Report knows no model names. The user's config file lists the models
// valid for each MRR seat (the first is the default) and how each launches.
// The shipped example seats three labs; that is a suggestion, not a rule. A
// model may serve several seats.

export const REVIEW_ROLES = ["deep-code-review", "structural-challenge", "fable-challenge"];
// Each launcher runs reviewers without MCP servers.
export const LAUNCHERS = ["codex", "claude", "cursor"];
const NAME = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
// A cursor- prefix and one effort or speed suffix name the same model.
const EFFORT_SUFFIX = /-(?:thinking-(?:xhigh|high|medium|low|max)|xhigh|high|medium|low|fast|max)$/;
// CLI model ids go into shell commands, so they stay one plain token.
const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

// FIELD_REPORT_CONFIG, else $XDG_CONFIG_HOME/field-report/config.json, else
// ~/.config/field-report/config.json.
export function configPath() {
  if (process.env.FIELD_REPORT_CONFIG) return process.env.FIELD_REPORT_CONFIG;
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "field-report", "config.json");
}

let active = null;

function fail(message) { throw new Error(`Config: ${message}`); }

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function onlyKeys(value, allowed, label) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) fail(`${label} has unknown key ${JSON.stringify(extra)}; allowed keys are ${allowed.join(", ")}`);
}

// Syntax only, independent of the config, so recorded reviews keep their
// identity after the config changes.
export function normalizeId(model) {
  let text = String(model || "").trim().toLowerCase();
  if (text.startsWith("cursor-")) text = text.slice("cursor-".length);
  // One effort suffix, optionally followed by -fast.
  if (text.endsWith("-fast") && EFFORT_SUFFIX.test(text.slice(0, -5))) text = text.slice(0, -5);
  text = text.replace(EFFORT_SUFFIX, "");
  return NAME.test(text) ? text : null;
}

function parseModel(entry, label) {
  onlyKeys(object(entry, label), ["id", "launch", "cliModel"], label);
  const id = normalizeId(entry.id);
  if (!id || id !== String(entry.id).trim().toLowerCase()) fail(`${label}.id must be a bare model id without a cursor- prefix or effort suffix (got ${JSON.stringify(entry.id)})`);
  if (!LAUNCHERS.includes(entry.launch)) fail(`${label}.launch must be one of ${LAUNCHERS.join(", ")}`);
  if (entry.cliModel != null && (typeof entry.cliModel !== "string" || !CLI_MODEL.test(entry.cliModel.trim()))) fail(`${label}.cliModel must be one token of letters, numbers, dots, colons, slashes, underscores, and hyphens`);
  return { id, launch: entry.launch, cliModel: entry.cliModel?.trim() || id };
}

// Where BRR plans live. Field Report stores only this pointer; the agent reads
// and writes the plan there through its host's MCP connector.
export const PLAN_HOMES = ["repo", "linear", "notion", "ref"];

function parsePlans(raw) {
  if (raw == null) return { home: "repo", where: null };
  onlyKeys(object(raw, "plans"), ["home", "where"], "plans");
  if (!PLAN_HOMES.includes(raw.home)) fail(`plans.home must be one of ${PLAN_HOMES.join(", ")}`);
  if (raw.where != null && (typeof raw.where !== "string" || !raw.where.trim() || /[\u0000-\u001f\u007f]/.test(raw.where))) fail("plans.where must be a single line of text");
  if (raw.home === "repo" && raw.where != null) fail("plans.where does not apply to repo; plans go in docs/plans/");
  return { home: raw.home, where: raw.where?.trim() || null };
}

export function parseSeatConfig(raw) {
  object(raw, "the config");
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1");
  onlyKeys(raw, ["schemaVersion", "seats", "plans"], "the config");
  const rawSeats = object(raw.seats, "seats");
  const unknown = Object.keys(rawSeats).find((role) => !REVIEW_ROLES.includes(role));
  if (unknown) fail(`seats has unknown seat ${unknown}; seats are ${REVIEW_ROLES.join(", ")}`);
  const seats = {};
  const launches = new Map();
  for (const role of REVIEW_ROLES) {
    const seat = rawSeats[role];
    if (!seat) fail(`seats is missing seat ${role}`);
    onlyKeys(object(seat, `seats.${role}`), ["models"], `seats.${role}`);
    if (!Array.isArray(seat.models) || !seat.models.length) fail(`seats.${role} needs a non-empty models list`);
    const models = seat.models.map((entry, index) => parseModel(entry, `seats.${role}.models[${index}]`));
    const ids = models.map((model) => model.id);
    if (new Set(ids).size !== ids.length) fail(`seats.${role} lists a model twice`);
    // One model launches one way, whichever seat it serves.
    for (const model of models) {
      const seen = launches.get(model.id);
      if (seen && (seen.launch !== model.launch || seen.cliModel !== model.cliModel)) fail(`${model.id} launches differently in two seats; give it one launch and cliModel`);
      launches.set(model.id, model);
    }
    seats[role] = { role, models };
  }
  return { seats, plans: parsePlans(raw.plans) };
}

// Tests can inject a parsed config; the CLI reads the file once per process.
export function useSeatConfig(raw) { active = raw == null ? null : { source: "injected", config: parseSeatConfig(raw) }; return active?.config; }

export function seatConfig() {
  if (active) return active.config;
  const file = configPath();
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`No Field Report config at ${file}. Copy config/config.example.json from the Field Report checkout there (node scripts/install.mjs does this), then edit it to choose the models for each seat.`);
    throw error;
  }
  let raw;
  try { raw = JSON.parse(text); } catch (error) { fail(`${file} is not valid JSON: ${error.message}`); }
  active = { source: file, config: parseSeatConfig(raw) };
  return active.config;
}

export function configSource() { seatConfig(); return active.source; }

export function seatFor(role) {
  if (!REVIEW_ROLES.includes(role)) throw new Error("Unknown review role");
  return seatConfig().seats[role];
}

// How to launch a model: its config entry from any seat, or null.
export function launchEntry(model) {
  const id = normalizeId(model);
  return REVIEW_ROLES.flatMap((role) => seatConfig().seats[role].models).find((entry) => entry.id === id) || null;
}

export function modelsLaunchedBy(launch) {
  return REVIEW_ROLES.flatMap((role) => seatFor(role).models).filter((entry) => entry.launch === launch);
}

export function describePlans() {
  const { home, where } = seatConfig().plans;
  if (home === "repo") return "docs/plans/ in this repository";
  const name = { linear: "Linear", notion: "Notion", ref: "Ref" }[home];
  return `${name}${where ? ` (${where})` : ""}, through this host's ${name} MCP connector`;
}
