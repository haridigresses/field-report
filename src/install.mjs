import { lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SKILL_NAMES = ["field-report", "brr", "fr-grill-me", "fr-ask-questions"];
export const REMOVED_SKILL_NAMES = ["repo-coordinator", "workstream-orchestrator"];

export function skillHostDirs(home = os.homedir()) {
  return [
    path.join(home, ".codex", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".cursor", "skills")
  ];
}

export async function linkSkills(repoRoot, home = os.homedir()) {
  const destinations = [];
  for (const host of skillHostDirs(home)) {
    for (const removed of REMOVED_SKILL_NAMES) {
      const stale = path.join(host, removed);
      try {
        const stat = await lstat(stale);
        if (stat.isSymbolicLink()) {
          const target = await readlink(stale);
          if (target.includes("field-report")) await rm(stale, { force: true });
        }
      } catch {}
    }
    for (const name of SKILL_NAMES) {
      const skill = path.join(host, name);
      try {
        const current = await lstat(skill);
        if (!current.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink skill path: ${skill}`);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      destinations.push(skill);
    }
  }
  const linked = [];
  for (const skill of destinations) {
    await mkdir(path.dirname(skill), { recursive: true });
    const temporary = `${skill}.${process.pid}.next`;
    await symlink(path.join(repoRoot, "skills", path.basename(skill)), temporary);
    await rename(temporary, skill);
    linked.push(skill);
  }
  return linked;
}
