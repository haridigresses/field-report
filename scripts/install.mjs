#!/usr/bin/env node
import { chmod, lstat, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const bin = path.join(home, ".local", "bin", "fr");

async function replace(file, writer) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.next`;
  await writer(temporary);
  await rename(temporary, file);
}

await replace(bin, (temporary) => writeFile(temporary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", "fr.mjs"))} "$@"\n`, { mode: 0o755 }));
for (const name of ["field-report", "repo-coordinator", "workstream-orchestrator"]) {
  const skill = path.join(home, ".codex", "skills", name);
  await mkdir(path.dirname(skill), { recursive: true });
  try {
    const current = await lstat(skill);
    if (!current.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink skill path: ${skill}`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${skill}.${process.pid}.next`;
  await symlink(path.join(root, "skills", name), temporary);
  await rename(temporary, skill);
}
await chmod(path.join(root, "bin", "fr.mjs"), 0o755);
const state = await createStore().init();
process.stdout.write(`Installed Field Report launcher at ${bin}\nCanonical state: ${state}\nRepository hooks are explicit: fr hook install <project-id>\n`);
