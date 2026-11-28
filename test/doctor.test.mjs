import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { agyModelIds, cursorModelIds, defaultProbe, devinModelIds, doctor, formatDoctor } from "../src/doctor.mjs";
import { installHostHooks } from "../src/host-hooks.mjs";
import { installPreCommitHook } from "../src/hooks.mjs";
import { installHostOnboarding, skillHostDirs, SKILL_NAMES } from "../src/install.mjs";
import { parseSeatConfig } from "../src/seats.mjs";

const exec = promisify(execFile);
const runtimeRoot = path.resolve(".");

const config = parseSeatConfig({
  schemaVersion: 1,
  seats: {
    correctness: { models: [{ id: "swe-1.6", launch: "devin" }] },
    design: { models: [{ id: "grok-x", launch: "cursor", cliModel: "cursor-grok-x-high" }, { id: "gemini-4-neon", launch: "agy", cliModel: "gemini-4-neon-high" }] },
    intent: { models: [{ id: "claude-x", launch: "claude" }] }
  }
});

async function installedHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-doctor-"));
  const binDir = path.join(home, ".local", "bin");
  await mkdir(binDir, { recursive: true });
  for (const name of ["fr", "gh", "fr-cursor-review", "fr-devin-review"]) {
    const file = path.join(binDir, name);
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o755);
  }
  for (const host of skillHostDirs(home)) {
    await mkdir(host, { recursive: true });
    for (const name of SKILL_NAMES) await symlink(path.join(runtimeRoot, "skills", name), path.join(host, name));
  }
  await mkdir(path.join(home, ".config", "devin"), { recursive: true });
  await installHostHooks({ frBin: path.join(binDir, "fr"), home });
  await installHostOnboarding({ repoRoot: runtimeRoot, home });
  const stateRoot = path.join(home, "state");
  await mkdir(stateRoot);
  await writeFile(path.join(stateRoot, "config.json"), "{}");
  return { home, stateRoot };
}

function probeWith(commands) {
  const real = defaultProbe();
  return {
    ...real,
    run: async (command, args, options) => {
      if (command === "git") return real.run(command, args, options);
      const base = path.basename(command);
      const key = `${base} ${args.join(" ")}`;
      return commands[key] || { code: "ENOENT", stdout: "", stderr: "" };
    }
  };
}

const allCommands = {
  "devin --version": { code: 0, stdout: "devin 1.0\n" },
  "devin models list --format json": { code: 0, stdout: JSON.stringify({ families: [{ slug: "swe-1.6", aliases: [], variants: [] }] }) },
  "claude --version": { code: 0, stdout: "claude 2.0\n" },
  "cursor-agent --version": { code: 0, stdout: "2026.11.22\n" },
  "cursor-agent --list-models": { code: 0, stdout: "cursor-grok-x-high - Grok X\n" },
  "agy --version": { code: 0, stdout: "agy 2.0\n" },
  "agy models": { code: 0, stdout: "gemini-4-neon-high\tGemini 4 Neon High\n" },
  "gh auth status": { code: 0, stdout: "" },
  "zsh --version": { code: 0, stdout: "zsh 5.9\n" }
};

const byLabel = (results, label) => results.find((item) => item.label === label);

test("model ID parsers handle cursor, agy, and devin output formats", () => {
  assert.deepEqual([...cursorModelIds("auto - Auto\ngpt-5.3-low - Codex\n")], ["auto", "gpt-5.3-low"]);
  assert.deepEqual([...agyModelIds("Header without tab\ngemini-4-neon-high\tGemini 4 Neon\n")], ["gemini-4-neon-high"]);
  assert.deepEqual([...devinModelIds(JSON.stringify({ families: [{ slug: "swe-1.6", aliases: ["swe"], variants: [{ model_uid: "swe-1.6-fast" }] }] }))], ["swe-1.6", "swe", "swe-1.6-fast"]);
});

test("doctor passes on a fully installed machine across cursor, agy, devin, and claude with v5 CRR hook", async () => {
  const { home, stateRoot } = await installedHome();
  const repo = await mkdtemp(path.join(os.tmpdir(), "fr-doc-ok-repo-"));
  await exec("git", ["init", "-q"], { cwd: repo });
  await installPreCommitHook(path.join(repo, ".git", "hooks", "pre-commit"), path.join(home, ".local", "bin", "fr"));
  const results = await doctor({
    runtimeRoot,
    stateRoot,
    home,
    env: { PATH: path.join(home, ".local", "bin") },
    nodeVersion: "24.1.0",
    loadConfig: () => config,
    projects: [{ id: "okrepo", repoPath: repo }],
    probe: probeWith(allCommands)
  });
  assert.deepEqual(results.filter((item) => item.level !== "ok"), []);
  assert.match(formatDoctor(results), /Ready\.$/);
});

test("doctor catches shell rc footguns, disabled hooks/plugins, legacy pre-commit hooks, and duplicate projects", async () => {
  const { home, stateRoot } = await installedHome();
  await writeFile(path.join(home, ".zshrc"), "alias claude='command claude --system-prompt-file ~/.claude/my-rules.txt'\nalias gh='/opt/homebrew/bin/gh'\n");
  await mkdir(path.join(home, ".gemini", "config"), { recursive: true });
  await writeFile(path.join(home, ".gemini", "config", "config.json"), JSON.stringify({ plugins: { "field-report": { enabled: false } } }));
  await writeFile(path.join(home, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));

  const repo = await mkdtemp(path.join(os.tmpdir(), "fr-doc-repo-"));
  await exec("git", ["init", "-q"], { cwd: repo });
  await mkdir(path.join(repo, ".git", "hooks"), { recursive: true });
  await writeFile(path.join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n# field-report-commit-gate:v4\n");

  const results = await doctor({
    runtimeRoot,
    stateRoot,
    home,
    env: { PATH: path.join(home, ".local", "bin") },
    nodeVersion: "24.1.0",
    loadConfig: () => config,
    projects: [{ id: "one", repoPath: repo }, { id: "dup", repoPath: repo }],
    probe: probeWith(allCommands)
  });
  assert.match(byLabel(results, "shell .zshrc:1").detail, /wipes Claude Code's built-in skill/);
  assert.match(byLabel(results, "shell .zshrc:2").detail, /alias\/function for 'gh'/);
  assert.equal(byLabel(results, "antigravity plugin").level, "fail");
  assert.equal(byLabel(results, "claude local settings").level, "fail");
  assert.match(byLabel(results, "project one").detail, /legacy Field Report pre-commit hook/);
  assert.match(byLabel(results, "project dup").detail, /shares repository with project 'one'/);

  const bareHome = await mkdtemp(path.join(os.tmpdir(), "fr-doctor-bare-"));
  const bareState = path.join(bareHome, "state");
  await exec(process.execPath, [path.resolve("bin/fr.mjs"), "doctor"], {
    env: { ...process.env, HOME: bareHome, FIELD_REPORT_HOME: bareHome, FIELD_REPORT_STATE_ROOT: bareState }
  }).catch((error) => assert.match(error.stdout, /FAIL state/));
  await assert.rejects(access(bareState));
});
