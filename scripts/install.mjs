#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, chmod, copyFile, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { quote, removeLegacyPreCommitHook } from "../src/hooks.mjs";
import { installHostHooks } from "../src/host-hooks.mjs";
import { linkSkills } from "../src/install.mjs";
import { configPath } from "../src/seats.mjs";
import { createStore } from "../src/store.mjs";

const exec = promisify(execFile);
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

for (const [name, script] of launchers) {
  const target = path.join(binDir, name);
  const source = path.join(root, "bin", script);
  await chmod(source, 0o755).catch(() => {});
  await replace(target, (temporary) => writeFile(temporary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`, { mode: 0o755 }));
}

const skills = await linkSkills(root, home);
const store = createStore();
const state = await store.init();
const hooks = await installHostHooks({ frBin: path.join(binDir, "fr"), home });

// Clean up any legacy Field Report pre-commit hooks on registered projects.
let cleanedHooks = 0;
for (const project of await store.projects()) {
  try {
    const hookOut = (await exec("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: project.repoPath, timeout: 5_000 })).stdout.trim();
    const res = await removeLegacyPreCommitHook(hookOut, {
      readFileFn: (f) => readFile(f, "utf8").catch(() => null),
      existsFn: (f) => access(f).then(() => true, () => false)
    });
    if (res.removed) cleanedHooks += 1;
  } catch {}
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
  `Host hooks configured: ${hooks.claudeSettingsPath}, ${hooks.cursorHooksPath}`,
  `Skill links: ${skills.join(", ")}`,
  `Canonical state: ${state}${cleanedHooks ? ` (removed ${cleanedHooks} legacy pre-commit hook(s))` : ""}`,
  seatsNote,
  "Next: fr doctor"
].join("\n") + "\n");
