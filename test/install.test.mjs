import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { installFieldReport } from "../scripts/install.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function installFixture({ configuredProject = false } = {}) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "field-report-install-"));
  const sourceRoot = path.join(fixtureRoot, "source");
  const home = path.join(fixtureRoot, "home");
  await Promise.all([mkdir(sourceRoot), mkdir(home)]);
  for (const entry of ["bin", "docs", "integrations", "scripts", "skills", "src", "package.json"]) {
    await cp(path.join(root, entry), path.join(sourceRoot, entry), { recursive: true });
  }
  await mkdir(path.join(sourceRoot, "config"));
  await mkdir(path.join(sourceRoot, "workstreams"));
  await writeFile(path.join(sourceRoot, "config", "projects.json"), JSON.stringify({ projects: configuredProject ? [{ id: "sample", repoPath: sourceRoot }] : [] }));
  await exec("git", ["init", "-b", "main"], { cwd: sourceRoot });
  await exec("git", ["add", "."], { cwd: sourceRoot });
  await exec("git", ["-c", "user.name=Field Report Test", "-c", "user.email=field-report@example.invalid", "commit", "-m", "fixture"], { cwd: sourceRoot });
  await exec("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: sourceRoot });
  return { fixtureRoot, home, sourceRoot };
}

test("installer pins the launcher and skills to one clean exact commit", async () => {
  const fixture = await installFixture();
  try {
    const installed = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    assert.match(installed.revision, /^[0-9a-f]{40}$/);
    assert.equal(await realpath(installed.stateRoot), await realpath(fixture.sourceRoot));
    assert.equal(await readFile(path.join(installed.releaseRoot, "install-manifest.json"), "utf8").then(JSON.parse).then((value) => value.revision), installed.revision);
    const launcher = await readFile(installed.launcher, "utf8");
    assert.match(launcher, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(launcher, new RegExp(installed.releaseRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await writeFile(path.join(fixture.sourceRoot, "bin", "fr.mjs"), "throw new Error('mutable source used');\n");
    const { stdout } = await exec(installed.launcher, ["doctor"]);
    assert.match(stdout, /^Field Report doctor: OK/m);
    assert.match(stdout, new RegExp(`Runtime: .*${installed.revision}`));
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer refuses an uncommitted release payload", async () => {
  const fixture = await installFixture();
  try {
    await writeFile(path.join(fixture.sourceRoot, "docs", "fr-workflow.md"), "dirty\n");
    await assert.rejects(
      installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }),
      /Refusing to install a release with uncommitted/
    );
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer refuses an uncommitted installer", async () => {
  const fixture = await installFixture();
  try {
    await writeFile(path.join(fixture.sourceRoot, "scripts", "install.mjs"), "throw new Error('dirty installer');\n");
    await assert.rejects(
      installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }),
      /Refusing to install a release with uncommitted/
    );
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer adds only a locally scoped managed pre-commit hook", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    const installed = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    assert.equal(installed.preCommitHooks.length, 1);
    const hook = await readFile(installed.preCommitHooks[0].hook, "utf8");
    assert.match(hook, /field-report-managed-pre-commit:v1/);
    assert.match(hook, /unset FIELD_REPORT_URL/);
    assert.match(hook, /hook pre-commit/);
    await exec(installed.preCommitHooks[0].hook, [], { env: { FIELD_REPORT_URL: "http://127.0.0.1:1" } });
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer refuses to overwrite an unrelated pre-commit hook", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    const hook = path.join(fixture.sourceRoot, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await assert.rejects(
      installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }),
      /Refusing to overwrite the existing pre-commit hook/
    );
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
