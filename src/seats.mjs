import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Field Report knows no model names. Which models fill each MRR seat, which
// provider each model id belongs to, and how each model launches live in the
// user's config file. Any model from a seat's provider fills it; a model from
// another provider is a substitution. A new model is a config edit, not a code
// change.

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

// Syntax only, independent of the config: recorded reviews keep their identity
// after a provider leaves the config.
export function normalizeId(model) {
  let text = String(model || "").trim().toLowerCase();
  if (text.startsWith("cursor-")) text = text.slice("cursor-".length);
  // One effort suffix, optionally followed by -fast.
  if (text.endsWith("-fast") && EFFORT_SUFFIX.test(text.slice(0, -5))) text = text.slice(0, -5);
  text = text.replace(EFFORT_SUFFIX, "");
  return NAME.test(text) ? text : null;
}

function providerOf(providers, id) {
  if (!id) return null;
  for (const [name, provider] of Object.entries(providers)) if (provider.prefixes.some((prefix) => id.startsWith(prefix))) return name;
  return null;
}

function parseModel(entry, label, providers) {
  onlyKeys(object(entry, label), ["id", "launch", "cliModel"], label);
  const id = normalizeId(entry.id);
  if (!id || id !== String(entry.id).trim().toLowerCase()) fail(`${label}.id must be a bare model id without a cursor- prefix or effort suffix (got ${JSON.stringify(entry.id)})`);
  if (!providerOf(providers, id)) fail(`${label}.id ${id} matches no configured provider prefix`);
  if (!LAUNCHERS.includes(entry.launch)) fail(`${label}.launch must be one of ${LAUNCHERS.join(", ")}`);
  if (entry.cliModel != null && (typeof entry.cliModel !== "string" || !CLI_MODEL.test(entry.cliModel.trim()))) fail(`${label}.cliModel must be one token of letters, numbers, dots, colons, slashes, underscores, and hyphens`);
  return { id, launch: entry.launch, cliModel: entry.cliModel?.trim() || id };
}

export function parseSeatConfig(raw) {
  object(raw, "the config");
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1");
  onlyKeys(raw, ["schemaVersion", "providers", "seats"], "the config");
  const providers = {};
  const seen = new Map();
  for (const [name, provider] of Object.entries(object(raw.providers, "providers"))) {
    if (!NAME.test(name)) fail(`provider name ${JSON.stringify(name)} uses lowercase letters, numbers, dots, and hyphens`);
    onlyKeys(object(provider, `providers.${name}`), ["prefixes"], `providers.${name}`);
    const { prefixes } = provider;
    if (!Array.isArray(prefixes) || !prefixes.length || !prefixes.every((item) => typeof item === "string" && item.trim())) fail(`providers.${name}.prefixes must be a non-empty string array`);
    const clean = prefixes.map((item) => item.trim().toLowerCase());
    for (const prefix of clean) {
      for (const [other, owner] of seen) if (prefix.startsWith(other) || other.startsWith(prefix)) fail(`prefix ${prefix} (${name}) overlaps ${other} (${owner})`);
      seen.set(prefix, name);
    }
    providers[name] = { prefixes: clean };
  }
  const rawSeats = object(raw.seats, "seats");
  const unknown = Object.keys(rawSeats).find((role) => !REVIEW_ROLES.includes(role));
  if (unknown) fail(`seats has unknown seat ${unknown}; seats are ${REVIEW_ROLES.join(", ")}`);
  const seats = {};
  for (const role of REVIEW_ROLES) {
    const seat = rawSeats[role];
    if (!seat) fail(`seats is missing seat ${role}`);
    onlyKeys(object(seat, `seats.${role}`), ["models"], `seats.${role}`);
    if (!Array.isArray(seat.models) || !seat.models.length) fail(`seats.${role} needs a non-empty models list`);
    const models = seat.models.map((entry, index) => parseModel(entry, `seats.${role}.models[${index}]`, providers));
    const provider = providerOf(providers, models[0].id);
    for (const model of models) if (providerOf(providers, model.id) !== provider) fail(`seats.${role} mixes providers; one seat is one provider (${model.id} is not ${provider})`);
    seats[role] = { role, provider, models };
  }
  const used = REVIEW_ROLES.map((role) => seats[role].provider);
  if (new Set(used).size !== used.length) fail(`seats must use three different providers (got ${used.join(", ")})`);
  return { providers, seats };
}

// Tests can inject a parsed config; the CLI reads the file once per process.
export function useSeatConfig(raw) { active = raw == null ? null : { source: "injected", config: parseSeatConfig(raw) }; return active?.config; }

export function seatConfig() {
  if (active) return active.config;
  const file = configPath();
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`No Field Report config at ${file}. Copy config/config.example.json from the Field Report checkout there (node scripts/install.mjs does this), then edit it to choose the model for each seat.`);
    throw error;
  }
  let raw;
  try { raw = JSON.parse(text); } catch (error) { fail(`${file} is not valid JSON: ${error.message}`); }
  active = { source: file, config: parseSeatConfig(raw) };
  return active.config;
}

export function configSource() { seatConfig(); return active.source; }

export function canonicalModel(model) {
  const id = normalizeId(model);
  return providerOf(seatConfig().providers, id) ? id : null;
}

export function providerForModel(model) { return providerOf(seatConfig().providers, normalizeId(model)); }

export function providerNames() { return Object.keys(seatConfig().providers); }

export function seatFor(role) {
  if (!REVIEW_ROLES.includes(role)) throw new Error("Unknown review role");
  return seatConfig().seats[role];
}

// How to launch a model: its own seat entry, else the first seated model of
// the same provider. A Cursor sibling keeps the requested effort suffix.
export function launchEntry(model) {
  const config = seatConfig();
  const id = normalizeId(model);
  const entries = REVIEW_ROLES.flatMap((role) => config.seats[role].models);
  const exact = entries.find((entry) => entry.id === id);
  if (exact) return exact;
  const provider = providerOf(config.providers, id);
  const sibling = provider && entries.find((entry) => providerOf(config.providers, entry.id) === provider);
  if (!sibling) return null;
  const raw = String(model).trim();
  return { id, launch: sibling.launch, cliModel: sibling.launch === "cursor" && CLI_MODEL.test(raw) ? raw : id };
}

export function modelsLaunchedBy(launch) {
  return REVIEW_ROLES.flatMap((role) => seatFor(role).models).filter((entry) => entry.launch === launch);
}
