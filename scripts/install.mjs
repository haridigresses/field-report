#!/usr/bin/env node
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.mjs";
import { linkSkills } from "../src/install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const binDir = path.join(home, ".local", "bin");
const bin = path.join(binDir, "fr");
const afOnboardSafe = path.join(binDir, "af-onboard-safe");
const cursorReview = path.join(binDir, "fr-cursor-review");

async function replace(file, writer) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.next`;
  await writer(temporary);
  await rename(temporary, file);
}

await replace(bin, (temporary) => writeFile(temporary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", "fr.mjs"))} "$@"\n`, { mode: 0o755 }));
await replace(afOnboardSafe, (temporary) => writeFile(temporary, `#!/bin/sh\nexec ${JSON.stringify(path.join(root, "bin", "af-onboard-safe"))} "$@"\n`, { mode: 0o755 }));
await replace(cursorReview, (temporary) => writeFile(temporary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", "fr-cursor-review.mjs"))} "$@"\n`, { mode: 0o755 }));
const skills = await linkSkills(root, home);
await chmod(path.join(root, "bin", "fr.mjs"), 0o755);
await chmod(path.join(root, "bin", "fr-cursor-review.mjs"), 0o755);
await chmod(path.join(root, "bin", "af-onboard-safe"), 0o755);
const state = await createStore().init();
process.stdout.write(`Installed Field Report launchers at ${bin}, ${cursorReview}, and ${afOnboardSafe}\nSkill links: ${skills.join(", ")}\nCanonical state: ${state}\nRepository hooks are explicit: fr hook install <project-id>\nMy Machines: start a worker for the target checkout with Cursor's agent CLI\n`);
