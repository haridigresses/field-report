#!/usr/bin/env node
import { mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();

async function link(target, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try { await unlink(destination); } catch {}
  await symlink(target, destination);
}

async function installClaudeHooks() {
  const file = path.join(home, ".claude", "settings.json");
  let settings = {};
  try { settings = JSON.parse(await readFile(file, "utf8")); } catch {}
  settings.hooks ||= {};
  const additions = {
    SessionStart: { matcher: "", hooks: [{ type: "command", command: "fr hook session-start", timeout: 15 }] },
    Stop: { matcher: "", hooks: [{ type: "command", command: "fr hook stop", timeout: 15 }] }
  };
  for (const [event, addition] of Object.entries(additions)) {
    settings.hooks[event] ||= [];
    const exists = settings.hooks[event].some((entry) => entry.hooks?.some((hook) => hook.command === addition.hooks[0].command));
    if (!exists) settings.hooks[event].push(addition);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.next`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

await link(path.join(root, "bin", "fr.mjs"), path.join(home, ".local", "bin", "fr"));
await link(path.join(root, "skills", "field-report"), path.join(home, ".codex", "skills", "field-report"));
await link(path.join(root, "skills", "field-report"), path.join(home, ".claude", "skills", "field-report"));
await link(path.join(root, "integrations", "claude", "commands", "fr.md"), path.join(home, ".claude", "commands", "fr.md"));
await installClaudeHooks();

process.stdout.write("Installed fr, the Field Report skill for Codex and Claude, /fr for Claude, and quiet Claude session hooks.\n");
