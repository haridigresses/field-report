#!/usr/bin/env node
import { chmod, copyFile, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installProjectPreCommitHook, quote } from "../src/hooks.mjs";
import { installHostHooks } from "../src/host-hooks.mjs";
import { installHostOnboarding, linkSkills } from "../src/install.mjs";
import { configPath } from "../src/seats.mjs";
import { createStore } from "../src/store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const binDir = path.join(home, ".local", "bin");
const launchers = [
  ["fr", "fr.mjs"],
  ["fr-cursor-review", "fr-cursor-review.mjs"],
  ["fr-devin-review", "fr-devin-review.mjs"],
  ["gh", "fr-gh.mjs"]
];

async function replace(file, writer) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.next`;
  await writer(temporary);
  await rename(temporary, file);
}

// If a real non-Field-Report 'gh' binary already lives at ~/.local/bin/gh,
// preserve it at ~/.local/bin/gh.real so findRealGh finds it instead of losing it.
const ghTarget = path.join(binDir, "gh");
try {
  const existingGh = await readFile(ghTarget, "utf8");
  if (!existingGh.includes("fr-gh.mjs")) {
    await rename(ghTarget, path.join(binDir, "gh.real"));
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

for (const [name, script] of launchers) {
  const target = path.join(binDir, name);
  const source = path.join(root, "bin", script);
  await chmod(source, 0o755).catch(() => {});
  await replace(target, (temporary) => writeFile(temporary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`, { mode: 0o755 }));
}

const frBin = path.join(binDir, "fr");
const skills = await linkSkills(root, home);
const store = createStore();
const state = await store.init();
const hooks = await installHostHooks({ frBin, home });
const onboarding = await installHostOnboarding({ repoRoot: root, home });

let installedHooks = 0;
for (const project of await store.projects()) {
  const res = await installProjectPreCommitHook(project.repoPath, frBin);
  if (res.installed) installedHooks += 1;
}

const seats = configPath();
let seatsNote = `Config kept: ${seats}`;
try {
  await mkdir(path.dirname(seats), { recursive: true });
  await copyFile(path.join(root, "config", "config.example.json"), seats, constants.COPYFILE_EXCL);
  seatsNote = `Config created from config/config.example.json: ${seats} (edit it to choose models)`;
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}

process.stdout.write([
  `Installed launchers in ${binDir}: ${launchers.map(([name]) => name).join(", ")}`,
  `Host hooks configured: ${[hooks.claudeSettingsPath, hooks.cursorHooksPath, hooks.agyHooksPath, hooks.devinConfigPath].filter(Boolean).join(", ")}`,
  `Always-on rules configured: ${onboarding.claudeMdPath}, ${onboarding.codexMdPath}, ${onboarding.cursorRulePath}, ${onboarding.agyRulesPath}`,
  onboarding.repairedShellFiles.length ? `Repaired shell alias (--append-system-prompt-file): ${onboarding.repairedShellFiles.join(", ")}` : "",
  `Skill links (${skills.length}): ${skills.join(", ")}`,
  `Canonical state: ${state}${installedHooks ? ` (installed CRR pre-commit hook on ${installedHooks} project(s))` : ""}`,
  seatsNote,
  "Next: fr doctor"
].filter(Boolean).join("\n") + "\n");
