import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Field Report hardcodes no model names. The user's config file lists the
// models valid for each MRR seat (the first is the default; later entries are
// start-failure fallbacks) and how each launches.

export const REVIEW_ROLES = ["correctness", "design", "intent"];

export const SEAT_PURPOSES = {
  correctness: "Bugs, security, data integrity, error paths, and whether the tests cover them.",
  design: "How it is built: whether it is needed, whether it is the simplest mechanism, and whether it respects boundaries.",
  intent: "What it does: whether it matches your requests, BRR plan, and decisions, with no unrequested scope."
};

const RENAMED_SEATS = { "deep-code-review": "correctness", "structural-challenge": "design", "fable-challenge": "intent" };

// Supported reviewer launchers. CLI launchers run isolated subprocesses; native
// prints/records a brief for an isolated host subagent.
export const LAUNCHERS = ["codex", "claude", "cursor", "agy", "devin", "native"];
export const CLI_LAUNCHERS = LAUNCHERS.filter((launch) => launch !== "native");

const NAME = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
const EFFORT_SUFFIX = /-(?:thinking-(?:xhigh|high|medium|low|max)|xhigh|high|medium|low|fast|max)$/;
const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

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

export function normalizeId(model) {
  let text = String(model || "").trim().toLowerCase();
  if (text.startsWith("cursor-")) text = text.slice("cursor-".length);
  if (text.endsWith("-fast") && EFFORT_SUFFIX.test(text.slice(0, -5))) text = text.slice(0, -5);
  text = text.replace(EFFORT_SUFFIX, "");
  return NAME.test(text) ? text : null;
}

function parseModel(entry, label) {
  onlyKeys(object(entry, label), ["id", "launch", "cliModel"], label);
  if (typeof entry.id !== "string" || !entry.id.trim()) fail(`${label}.id is missing; give each model an id`);
  const id = normalizeId(entry.id);
  if (!id || id !== String(entry.id).trim().toLowerCase()) fail(`${label}.id must be a bare model id without a cursor- prefix or effort suffix (got ${JSON.stringify(entry.id)})`);
  if (!LAUNCHERS.includes(entry.launch)) fail(`${label}.launch must be one of ${LAUNCHERS.join(", ")}`);
  if (entry.cliModel != null && (typeof entry.cliModel !== "string" || !CLI_MODEL.test(entry.cliModel.trim()))) fail(`${label}.cliModel must be one token of letters, numbers, dots, colons, slashes, underscores, and hyphens`);
  return { id, launch: entry.launch, cliModel: entry.cliModel?.trim() || id };
}

export function parseSeatConfig(raw) {
  object(raw, "the config");
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (raw.plans !== undefined) fail(`plans moved to each project; remove it from ${configPath()} and set it with fr project update <id> --plans <home>, or on the settings page`);
  onlyKeys(raw, ["schemaVersion", "seats"], "the config");
  const rawSeats = object(raw.seats, "seats");
  const unknown = Object.keys(rawSeats).find((role) => !REVIEW_ROLES.includes(role));
  if (unknown && RENAMED_SEATS[unknown]) fail(`seats were renamed (${Object.entries(RENAMED_SEATS).map(([old, now]) => `${old} → ${now}`).join(", ")}); rename the keys in ${configPath()}`);
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
    for (const model of models) {
      const seen = launches.get(model.id);
      if (seen && (seen.launch !== model.launch || seen.cliModel !== model.cliModel)) fail(`${model.id} launches differently in two seats; give it one launch and cliModel`);
      launches.set(model.id, model);
    }
    seats[role] = { role, models };
  }
  return { seats };
}

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
  if (!REVIEW_ROLES.includes(role)) throw new Error(`Unknown review role: ${role}`);
  return seatConfig().seats[role];
}

export function launchEntry(model) {
  const id = normalizeId(model);
  return REVIEW_ROLES.flatMap((role) => seatConfig().seats[role].models).find((entry) => entry.id === id) || null;
}

export function modelsLaunchedBy(launch) {
  return REVIEW_ROLES.flatMap((role) => seatFor(role).models).filter((entry) => entry.launch === launch);
}

export async function readRawConfig(file = configPath()) {
  let text;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "config.example.json");
    return { path: file, exists: false, raw: JSON.parse(await readFile(example, "utf8")), error: null };
  }
  let raw;
  try { raw = JSON.parse(text); } catch (error) { return { path: file, exists: true, raw: null, error: `${file} is not valid JSON: ${error.message}` }; }
  try { parseSeatConfig(raw); return { path: file, exists: true, raw, error: null }; }
  catch (error) { return { path: file, exists: true, raw, error: error.message }; }
}

export async function saveSeatConfig(raw, file = configPath()) {
  const config = parseSeatConfig(raw);
  await mkdir(path.dirname(file), { recursive: true });
  let target = file;
  try { target = await realpath(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${target}.${process.pid}.next`;
  await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`);
  await rename(temporary, target);
  active = { source: file, config };
  return config;
}
