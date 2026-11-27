import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cursorModelIds, defaultProbe, doctor, formatDoctor } from "../src/doctor.mjs";
import { skillHostDirs, SKILL_NAMES } from "../src/install.mjs";
import { parseSeatConfig } from "../src/seats.mjs";

const exec = promisify(execFile);
const runtimeRoot = path.resolve(".");

const config = parseSeatConfig({
  schemaVersion: 1,
  seats: {
    "deep-code-review": { models: [{ id: "gpt-x", launch: "codex" }] },
    "structural-challenge": { models: [{ id: "grok-x", launch: "cursor", cliModel: "cursor-grok-x-high" }, { id: "neon-x", launch: "cursor", cliModel: "neon-x-high" }] },
    "fable-challenge": { models: [{ id: "claude-x", launch: "claude" }] }
  }
});

async function installedHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-doctor-"));
  await mkdir(path.join(home, ".local", "bin"), { recursive: true });
  await writeFile(path.join(home, ".local", "bin", "fr"), "#!/bin/sh\n");
  for (const host of skillHostDirs(home)) {
    await mkdir(host, { recursive: true });
    for (const name of SKILL_NAMES) await symlink(path.join(runtimeRoot, "skills", name), path.join(host, name));
  }
  const stateRoot = path.join(home, "state");
  await mkdir(stateRoot);
  await writeFile(path.join(stateRoot, "config.json"), "{}");
  return { home, stateRoot };
}

// Real filesystem; fake CLIs.
function probeWith(commands) {
  const real = defaultProbe();
  return { ...real, run: async (command, args, options) => {
    if (command === "git") return real.run(command, args, options);
    const key = `${command} ${args.join(" ")}`;
    return commands[key] || { code: "ENOENT", stdout: "", stderr: "" };
  } };
}

const allCommands = {
  "codex --version": { code: 0, stdout: "codex 1.0\n" },
  "claude --version": { code: 0, stdout: "claude 2.0\n" },
  "cursor-agent --version": { code: 0, stdout: "2026.11.22\n" },
  "cursor-agent --list-models": { code: 0, stdout: "Available models\n\ncursor-grok-x-high - Grok X High\nneon-x-high - Neon X\n" },
  "gh auth status": { code: 0, stdout: "" }
};

const byLabel = (results, label) => results.find((item) => item.label === label);

test("cursorModelIds reads the id before the display name", () => {
  assert.deepEqual([...cursorModelIds("Available models\n\nauto - Auto (default)\ngpt-5.3-codex-low - Codex 5.3 Low\n")], ["auto", "gpt-5.3-codex-low"]);
});

test("doctor passes on a fully installed machine", async () => {
  const { home, stateRoot } = await installedHome();
  const results = await doctor({ runtimeRoot, stateRoot, home, env: { PATH: path.join(home, ".local", "bin") }, nodeVersion: "24.1.0", loadConfig: () => config, probe: probeWith(allCommands) });
  assert.deepEqual(results.filter((item) => item.level !== "ok"), []);
  assert.match(formatDoctor(results), /Ready\.$/);
});

test("doctor fails a missing default launcher and a missing default cursor model, warns on fallbacks", async () => {
  const { home, stateRoot } = await installedHome();
  const commands = { ...allCommands, "claude --version": { code: "ENOENT", stdout: "" }, "cursor-agent --list-models": { code: 0, stdout: "neon-x-medium - Neon X\n" } };
  const results = await doctor({ runtimeRoot, stateRoot, home, env: { PATH: path.join(home, ".local", "bin") }, nodeVersion: "24.1.0", loadConfig: () => config, probe: probeWith(commands) });
  assert.equal(byLabel(results, "claude CLI").level, "fail");
  assert.equal(byLabel(results, "structural-challenge default grok-x").level, "fail");
  assert.equal(byLabel(results, "structural-challenge fallback neon-x").level, "warn");
  assert.match(formatDoctor(results), /problem\(s\) to fix/);
});

test("doctor reports an uninstalled machine and a broken config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-doctor-bare-"));
  const results = await doctor({ runtimeRoot, stateRoot: path.join(home, "state"), home, env: { PATH: "/usr/bin" }, nodeVersion: "18.19.0", loadConfig: () => { throw new Error("Config: schemaVersion must be 1"); }, probe: probeWith({}) });
  for (const label of ["node", "fr launcher", "state", "seat config"]) assert.equal(byLabel(results, label).level, "fail", label);
  assert.equal(byLabel(results, "PATH").level, "warn");
  assert.equal(byLabel(results, "gh").level, "warn");
  assert.ok(results.some((item) => item.label.startsWith("skills ") && item.level === "fail"));
});

test("doctor warns when a hook manager owns a tracked pre-commit hook", async () => {
  const { home, stateRoot } = await installedHome();
  const repo = await mkdtemp(path.join(os.tmpdir(), "fr-doctor-repo-"));
  await exec("git", ["init", "-q"], { cwd: repo });
  await mkdir(path.join(repo, ".husky"));
  await writeFile(path.join(repo, ".husky", "pre-commit"), "npm test\n");
  await exec("git", ["add", ".husky/pre-commit"], { cwd: repo });
  await exec("git", ["config", "core.hooksPath", ".husky"], { cwd: repo });
  const plain = await mkdtemp(path.join(os.tmpdir(), "fr-doctor-plain-"));
  await exec("git", ["init", "-q"], { cwd: plain });
  const projects = [{ id: "husky", repoPath: repo }, { id: "plain", repoPath: plain }, { id: "gone", repoPath: path.join(home, "nope") }];
  const results = await doctor({ runtimeRoot, stateRoot, home, env: { PATH: path.join(home, ".local", "bin") }, nodeVersion: "24.1.0", loadConfig: () => config, projects, probe: probeWith(allCommands) });
  assert.match(byLabel(results, "project husky").detail, /tracked file .*would overwrite it/);
  assert.equal(byLabel(results, "project husky").level, "warn");
  assert.match(byLabel(results, "project plain").detail, /fr hook install plain/);
  assert.equal(byLabel(results, "project gone").level, "fail");
  await writeFile(path.join(repo, ".husky", "pre-commit"), "npm test\nfr gate checkout\n");
  const again = await doctor({ runtimeRoot, stateRoot, home, env: { PATH: path.join(home, ".local", "bin") }, nodeVersion: "24.1.0", loadConfig: () => config, projects, probe: probeWith(allCommands) });
  assert.equal(byLabel(again, "project husky").level, "ok");
});

test("fr doctor does not create state on an uninitialized machine", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-doctor-cli-"));
  const stateRoot = path.join(home, "state");
  await exec(process.execPath, [path.resolve("bin/fr.mjs"), "doctor"], { env: { ...process.env, HOME: home, FIELD_REPORT_STATE_ROOT: stateRoot } }).catch((error) => assert.match(error.stdout, /FAIL state/));
  await assert.rejects(access(stateRoot));
});
