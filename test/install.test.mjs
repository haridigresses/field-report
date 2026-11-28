import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { linkSkills, REMOVED_SKILL_NAMES, skillHostDirs, SKILL_NAMES } from "../src/install.mjs";

const exec = promisify(execFile);
const installer = path.resolve("scripts/install.mjs");
const repoRoot = path.resolve(".");

test("linkSkills updates Codex, Claude, and Cursor hosts atomically and prunes removed Field Report skill links", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-skills-"));
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await symlink(path.join(repoRoot, "skills", "repo-coordinator"), path.join(home, ".claude", "skills", "repo-coordinator"));

  const linked = await linkSkills(repoRoot, home);
  for (const host of skillHostDirs(home)) {
    for (const name of SKILL_NAMES) assert.equal(await readlink(path.join(host, name)), path.join(repoRoot, "skills", name));
    for (const old of REMOVED_SKILL_NAMES) await assert.rejects(lstat(path.join(host, old)));
  }
  assert.equal(linked.length, 3 * SKILL_NAMES.length);
});

test("linkSkills refuses to replace a real directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-skills-dir-"));
  const skill = path.join(home, ".codex", "skills", "field-report");
  await mkdir(skill, { recursive: true });
  await assert.rejects(linkSkills(repoRoot, home), /Refusing to replace non-symlink skill path/);
});

test("installer writes fr, fr-cursor-review, fr-devin-review, and gh launchers, host hooks, and config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-install-"));
  const state = path.join(home, "state");
  const env = { ...process.env, HOME: home, FIELD_REPORT_STATE_ROOT: state };
  delete env.FIELD_REPORT_CONFIG;
  delete env.XDG_CONFIG_HOME;

  const { stdout } = await exec(process.execPath, [installer], { env });
  assert.match(stdout, /Installed launchers in .*: fr, fr-cursor-review, fr-devin-review, gh/);
  assert.match(stdout, /Host hooks configured:/);
  const seats = path.join(home, ".config", "field-report", "config.json");
  assert.equal(await readFile(seats, "utf8"), await readFile(path.join(repoRoot, "config", "config.example.json"), "utf8"));
  await writeFile(seats, "{\"edited\": true}\n");
  assert.match((await exec(process.execPath, [installer], { env })).stdout, /Config kept:/);
  assert.equal(await readFile(seats, "utf8"), "{\"edited\": true}\n");
});
