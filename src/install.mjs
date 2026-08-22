import { lstat, mkdir, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SKILL_NAMES = ["field-report", "repo-coordinator", "workstream-orchestrator"];

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
