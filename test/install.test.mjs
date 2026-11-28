import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { detectShellRcFootguns, hasInstalledOnboarding, installHostOnboarding, linkSkills, REMOVED_SKILL_NAMES, repairShellRcFiles, skillHostDirs, SKILL_NAMES } from "../src/install.mjs";

const exec = promisify(execFile);
const installer = path.resolve("scripts/install.mjs");
const repoRoot = path.resolve(".");

test("linkSkills updates Codex, Claude, Cursor, Devin, and Antigravity plugin hosts atomically and prunes removed skills", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-skills-"));
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await symlink(path.join(repoRoot, "skills", "repo-coordinator"), path.join(home, ".claude", "skills", "repo-coordinator"));

  const agyStaleDir = path.join(home, ".gemini", "config", "plugins", "field-report", "skills", "workstream-orchestrator");
  const agyOldCopy = path.join(home, ".gemini", "config", "plugins", "field-report", "skills", "field-report");
  await mkdir(agyStaleDir, { recursive: true });
  await mkdir(agyOldCopy, { recursive: true });

  const linked = await linkSkills(repoRoot, home);
  for (const host of skillHostDirs(home)) {
    for (const name of SKILL_NAMES) assert.equal(await readlink(path.join(host, name)), path.join(repoRoot, "skills", name));
    for (const old of REMOVED_SKILL_NAMES) await assert.rejects(lstat(path.join(host, old)));
  }
  assert.equal(linked.length, 5 * SKILL_NAMES.length);
});

test("linkSkills refuses to replace a real directory in shared user skill roots", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-skills-dir-"));
  const skill = path.join(home, ".codex", "skills", "field-report");
  await mkdir(skill, { recursive: true });
  await assert.rejects(linkSkills(repoRoot, home), /Refusing to replace non-symlink skill path/);
});

test("installHostOnboarding preserves pre/post user content and repairs destructive claude --system-prompt-file shell aliases", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-onboard-"));
  const onboardingFile = path.join(home, ".local", "share", "field-report", "host-onboarding.md");
  const claudeMd = path.join(home, ".claude", "CLAUDE.md");
  const codexMd = path.join(home, ".codex", "AGENTS.md");
  const zshrc = path.join(home, ".zshrc");

  await mkdir(path.dirname(onboardingFile), { recursive: true });
  await mkdir(path.dirname(claudeMd), { recursive: true });
  await mkdir(path.dirname(codexMd), { recursive: true });

  await writeFile(onboardingFile, "Custom header.\n\n<!-- field-report-host -->\nOld\n<!-- /field-report-host -->\n\n## Standing review authorization\nUser standing auth preserved.\n");
  await writeFile(claudeMd, "<!-- field-report-host -->\nOld block\n<!-- /field-report-host -->\n\n## Standing review authorization\nKeep me.\n");
  await writeFile(codexMd, "# Global Codex Instructions\n\n- For repository delivery work, read `/Users/x/.local/share/field-report/host-onboarding.md` and follow the installed Field Report skill.\n- Extra bullet.\n\n<!-- context7 -->\nKeep ctx7.\n<!-- context7 -->\n");
  await writeFile(zshrc, "export PATH=/Users/x/.local/bin:$PATH\nalias claude='command claude --system-prompt-file ~/.claude/my-rules.txt'\n");

  assert.equal(detectShellRcFootguns(await readFile(zshrc, "utf8")).length, 1);

  const paths = await installHostOnboarding({ repoRoot, home });
  assert.deepEqual(paths.repairedShellFiles, [zshrc]);
  assert.match(await readFile(zshrc, "utf8"), /--append-system-prompt-file ~\/\.claude\/my-rules\.txt/);
  assert.equal(detectShellRcFootguns(await readFile(zshrc, "utf8")).length, 0);
  assert.deepEqual(await repairShellRcFiles(home), [], "second run is a clean no-op");

  const updatedOnboarding = await readFile(paths.onboardingPath, "utf8");
  assert.equal(hasInstalledOnboarding(updatedOnboarding), true);
  assert.match(updatedOnboarding, /Custom header\./);
  assert.match(updatedOnboarding, /User standing auth preserved\./);

  assert.equal(hasInstalledOnboarding(await readFile(paths.claudeMdPath, "utf8")), true);
  assert.equal(hasInstalledOnboarding(await readFile(paths.codexMdPath, "utf8")), true);
  assert.equal(hasInstalledOnboarding(await readFile(paths.cursorRulePath, "utf8"), "cursor-mdc"), true);
  assert.equal(hasInstalledOnboarding(await readFile(paths.agyRulesPath, "utf8")), true);
});

test("installer writes launchers, 5-host hooks & rules, and preserves pre-existing ~/.local/bin/gh at gh.real", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fr-install-"));
  const state = path.join(home, "state");
  const env = { ...process.env, HOME: home, FIELD_REPORT_STATE_ROOT: state };
  delete env.FIELD_REPORT_CONFIG;
  delete env.XDG_CONFIG_HOME;

  await mkdir(path.join(home, ".local", "bin"), { recursive: true });
  await writeFile(path.join(home, ".local", "bin", "gh"), "#!/bin/sh\necho real-user-gh\n", { mode: 0o755 });

  const { stdout } = await exec(process.execPath, [installer], { env });
  assert.match(stdout, /Installed launchers in .*: fr, fr-cursor-review, fr-devin-review, gh/);
  assert.match(stdout, /Always-on rules configured:/);
  assert.match(await readFile(path.join(home, ".local", "bin", "gh.real"), "utf8"), /real-user-gh/);
  const seats = path.join(home, ".config", "field-report", "config.json");
  assert.equal(await readFile(seats, "utf8"), await readFile(path.join(repoRoot, "config", "config.example.json"), "utf8"));
  await writeFile(seats, "{\"edited\": true}\n");
  assert.match((await exec(process.execPath, [installer], { env })).stdout, /Config kept:/);
  assert.equal(await readFile(seats, "utf8"), "{\"edited\": true}\n");
});
