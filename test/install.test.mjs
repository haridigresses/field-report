import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { linkSkills, skillHostDirs, SKILL_NAMES } from "../src/install.mjs";

const exec = promisify(execFile);
const installer = path.resolve("scripts/install.mjs");
const repoRoot = path.resolve(".");

test("linkSkills updates Codex, Claude, and Cursor hosts atomically", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-skills-"));
  const stale = path.join(home, "stale-skill");
  await mkdir(stale);
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await symlink(stale, path.join(home, ".claude", "skills", "field-report"));
  const linked = await linkSkills(repoRoot, home);
  for (const host of skillHostDirs(home)) {
    for (const name of SKILL_NAMES) assert.equal(await readlink(path.join(host, name)), path.join(repoRoot, "skills", name));
  }
  assert.equal(linked.length, 3 * SKILL_NAMES.length);
});

test("linkSkills refuses to replace a real directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-skills-dir-"));
  const skill = path.join(home, ".codex", "skills", "field-report");
  await mkdir(skill, { recursive: true });
  await assert.rejects(linkSkills(repoRoot, home), /Refusing to replace non-symlink skill path/);
  assert.equal((await lstat(skill)).isDirectory(), true);
});

test("linkSkills preflights every destination before replacing any link", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-skills-preflight-"));
  await mkdir(path.join(home, ".claude", "skills", "field-report"), { recursive: true });
  await assert.rejects(linkSkills(repoRoot, home), /Refusing to replace non-symlink skill path/);
  await assert.rejects(lstat(path.join(home, ".codex", "skills", "field-report")));
  await assert.rejects(lstat(path.join(home, ".cursor", "skills", "field-report")));
});

test("installer writes launchers and skill links under HOME", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-install-"));
  const state = path.join(home, "state");
  const { stdout } = await exec(process.execPath, [installer], { env: { ...process.env, HOME: home, FIELD_REPORT_STATE_ROOT: state } });
  assert.match(stdout, new RegExp(`Installed Field Report launchers at ${home}/.local/bin/fr, ${home}/.local/bin/fr-cursor-review, ${home}/.local/bin/fr-devin-review`));
  assert.match(stdout, new RegExp(`Skill links: .*${home}/.codex/skills/field-report`));
  assert.match(stdout, new RegExp(`${home}/.claude/skills/field-report`));
  assert.match(stdout, new RegExp(`${home}/.cursor/skills/field-report`));
  assert.equal(await readlink(path.join(home, ".cursor", "skills", "field-report")), path.join(repoRoot, "skills", "field-report"));
});

test("installer seeds the config file from the example once and never overwrites it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-install-seats-"));
  const state = path.join(home, "state");
  const env = { ...process.env, HOME: home, FIELD_REPORT_STATE_ROOT: state };
  delete env.FIELD_REPORT_CONFIG;
  delete env.XDG_CONFIG_HOME;
  const seats = path.join(home, ".config", "field-report", "config.json");
  assert.match((await exec(process.execPath, [installer], { env })).stdout, new RegExp(`Config created from config/config.example.json: ${seats}`));
  assert.equal(await readFile(seats, "utf8"), await readFile(path.join(repoRoot, "config", "config.example.json"), "utf8"));
  await writeFile(seats, "{\"edited\": true}\n");
  assert.match((await exec(process.execPath, [installer], { env })).stdout, new RegExp(`Config kept: ${seats}`));
  assert.equal(await readFile(seats, "utf8"), "{\"edited\": true}\n");
});
