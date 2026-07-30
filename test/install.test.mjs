import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { activateSurfaces, installFieldReport } from "../scripts/install.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("activation rolls back every attempted surface after a late failure", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "field-report-activation-"));
  try {
    const existing = path.join(fixtureRoot, "existing");
    const created = path.join(fixtureRoot, "created");
    await writeFile(existing, "old\n", { mode: 0o600 });
    await assert.rejects(activateSurfaces([
      { destination: existing, write: () => writeFile(existing, "new\n", { mode: 0o755 }) },
      { destination: created, write: async () => { await writeFile(created, "partial\n"); throw new Error("injected late failure"); } }
    ]), /injected late failure/);
    assert.equal(await readFile(existing, "utf8"), "old\n");
    await assert.rejects(readFile(created), { code: "ENOENT" });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

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

test("installer rejects a corrupted existing release payload", async () => {
  const fixture = await installFixture();
  try {
    const installed = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    await writeFile(path.join(installed.releaseRoot, "bin", "fr.mjs"), "corrupted\n");
    await assert.rejects(installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }), /payload differs from the clean exact-main source/);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer reuses an intact release idempotently", async () => {
  const fixture = await installFixture();
  try {
    const first = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    const second = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    assert.equal(second.releaseRoot, first.releaseRoot);
    assert.equal(second.revision, first.revision);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer excludes ignored checkout files from the exact revision release", async () => {
  const fixture = await installFixture();
  try {
    const ignored = path.join(fixture.sourceRoot, "src", "ignored-injected.mjs");
    await writeFile(path.join(fixture.sourceRoot, ".git", "info", "exclude"), "src/ignored-injected.mjs\n");
    await writeFile(ignored, "throw new Error('must not ship');\n");
    const installed = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    await assert.rejects(readFile(path.join(installed.releaseRoot, "src", "ignored-injected.mjs")), { code: "ENOENT" });
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

test("installer does not activate the new launcher when a later surface fails", async () => {
  const fixture = await installFixture();
  try {
    await mkdir(path.join(fixture.home, ".claude"), { recursive: true });
    await writeFile(path.join(fixture.home, ".claude", "settings.json"), "not json\n");
    await assert.rejects(
      installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }),
      /Cannot preserve Claude settings/
    );
    await assert.rejects(readFile(path.join(fixture.home, ".local", "bin", "fr"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer preflights link conflicts before mutating hooks or launcher", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    await mkdir(path.join(fixture.home, ".codex", "skills", "field-report"), { recursive: true });
    await assert.rejects(
      installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }),
      /Refusing to replace non-symlink Field Report surface/
    );
    await assert.rejects(readFile(path.join(fixture.home, ".local", "bin", "fr"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(fixture.sourceRoot, ".git", "hooks", "pre-commit"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(fixture.home, ".claude", "settings.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer rejects a regular file where a managed parent directory is required", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    await mkdir(path.join(fixture.home, ".local"), { recursive: true });
    await writeFile(path.join(fixture.home, ".local", "bin"), "not a directory\n");
    await assert.rejects(
      installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }),
      /Expected a directory while preflighting/
    );
    await assert.rejects(readFile(path.join(fixture.sourceRoot, ".git", "hooks", "pre-commit"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(fixture.home, ".claude", "settings.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer rejects a directory at the launcher destination before mutation", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    await mkdir(path.join(fixture.home, ".local", "bin", "fr"), { recursive: true });
    await assert.rejects(
      installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }),
      /Refusing to replace unsupported Field Report surface/
    );
    await assert.rejects(readFile(path.join(fixture.sourceRoot, ".git", "hooks", "pre-commit"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(fixture.home, ".claude", "settings.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer requires directory search permission before mutating surfaces", async () => {
  const fixture = await installFixture({ configuredProject: true });
  const blockedParent = path.join(fixture.home, ".codex", "skills");
  try {
    await mkdir(blockedParent, { recursive: true });
    await chmod(blockedParent, 0o200);
    await assert.rejects(
      installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }),
      /permission denied|Cannot install Field Report surface/
    );
    await assert.rejects(readFile(path.join(fixture.sourceRoot, ".git", "hooks", "pre-commit"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(fixture.home, ".claude", "settings.json"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(fixture.home, ".local", "bin", "fr"), "utf8"), { code: "ENOENT" });
  } finally {
    await chmod(blockedParent, 0o700).catch(() => {});
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
    assert.match(hook, /unset FIELD_REPORT_CWD/);
    assert.match(hook, /hook pre-commit/);
    assert.match(hook, new RegExp(installed.releaseLauncher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await exec(installed.preCommitHooks[0].hook, [], { env: { FIELD_REPORT_URL: "http://127.0.0.1:1", FIELD_REPORT_CWD: "/not/the/checkout" } });
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
