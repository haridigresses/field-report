#!/usr/bin/env node
import { chmod, copyFile, constants, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.mjs";
import { linkSkills } from "../src/install.mjs";
import { configPath } from "../src/seats.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const binDir = path.join(home, ".local", "bin");
const bin = path.join(binDir, "fr");
// Review wrappers that launchers run through.
const WRAPPERS = ["fr-cursor-review", "fr-devin-review"];

async function replace(file, writer) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.next`;
  await writer(temporary);
  await rename(temporary, file);
}

await replace(bin, (temporary) => writeFile(temporary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", "fr.mjs"))} "$@"\n`, { mode: 0o755 }));
for (const name of WRAPPERS) await replace(path.join(binDir, name), (temporary) => writeFile(temporary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", `${name}.mjs`))} "$@"\n`, { mode: 0o755 }));
const skills = await linkSkills(root, home);
await chmod(path.join(root, "bin", "fr.mjs"), 0o755);
for (const name of WRAPPERS) await chmod(path.join(root, "bin", `${name}.mjs`), 0o755);
const state = await createStore().init();
const seats = configPath();
let seatsNote = `Config kept: ${seats}`;
try { await mkdir(path.dirname(seats), { recursive: true }); await copyFile(path.join(root, "config", "config.example.json"), seats, constants.COPYFILE_EXCL); seatsNote = `Config created from config/config.example.json: ${seats} (edit it to choose models)`; }
catch (error) { if (error.code !== "EEXIST") throw error; }
process.stdout.write(`Installed Field Report launchers at ${[bin, ...WRAPPERS.map((name) => path.join(binDir, name))].join(", ")}\nSkill links: ${skills.join(", ")}\nCanonical state: ${state}\n${seatsNote}\nRepository hooks are explicit: fr hook install <project-id>\nMy Machines: start a worker for the target checkout with Cursor's agent CLI\nNext: fr doctor\n`);
