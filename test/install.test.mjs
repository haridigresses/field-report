import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { activateSurfaces, installFieldReport } from "../scripts/install.mjs";
import { releasePayloadDigest } from "../src/release-integrity.mjs";

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

test("installer repairs a corrupted existing release payload and managed launcher", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    const installed = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    await writeFile(path.join(installed.releaseRoot, "bin", "fr.mjs"), "corrupted\n");
    await writeFile(installed.releaseLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const repaired = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    assert.equal(repaired.revision, installed.revision);
    assert.notEqual(await readFile(path.join(repaired.releaseRoot, "bin", "fr.mjs"), "utf8"), "corrupted\n");
    assert.match(await readFile(repaired.releaseLauncher, "utf8"), /FIELD_REPORT_RELEASE_REVISION/);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("failed activation restores the prior same-revision release during repair", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    const installed = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    const runtime = path.join(installed.releaseRoot, "bin", "fr.mjs");
    await writeFile(runtime, "corrupted before repair\n");
    await writeFile(path.join(fixture.home, ".claude", "settings.json"), "not json\n");
    await assert.rejects(installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }), /Cannot preserve Claude settings/);
    assert.equal(await readFile(runtime, "utf8"), "corrupted before repair\n");
    assert.match(await readFile(installed.releaseLauncher, "utf8"), /FIELD_REPORT_RELEASE_REVISION/);
    assert.match(await readFile(installed.preCommitHooks[0].hook, "utf8"), new RegExp(installed.releaseLauncher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("installer upgrades an exact legacy release hook to the digested release format", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    const legacy = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    const manifestPath = path.join(legacy.releaseRoot, "install-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.payloadDigest;
    manifest.schemaVersion = 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(fixture.sourceRoot, "docs", "fr-workflow.md"), `${await readFile(path.join(fixture.sourceRoot, "docs", "fr-workflow.md"), "utf8")}\n`);
    await exec("git", ["add", "docs/fr-workflow.md"], { cwd: fixture.sourceRoot });
    await exec("git", ["-c", "user.name=Field Report Test", "-c", "user.email=field-report@example.invalid", "commit", "-m", "next release"], {
      cwd: fixture.sourceRoot,
      env: { ...process.env, CODEX_CI: "0", CODEX_THREAD_ID: "" }
    });
    await exec("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: fixture.sourceRoot });
    const upgraded = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    assert.notEqual(upgraded.revision, legacy.revision);
    assert.equal(JSON.parse(await readFile(path.join(upgraded.releaseRoot, "install-manifest.json"), "utf8")).schemaVersion, 2);
    assert.match(await readFile(upgraded.preCommitHooks[0].hook, "utf8"), new RegExp(upgraded.releaseLauncher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
    assert.match(hook, /field-report-managed-pre-commit:v2/);
    assert.match(hook, /unset FIELD_REPORT_URL/);
    assert.match(hook, /unset FIELD_REPORT_CWD/);
    assert.match(hook, /hook pre-commit/);
    assert.match(hook, new RegExp(installed.releaseLauncher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await exec(installed.preCommitHooks[0].hook, [], { env: { FIELD_REPORT_URL: "http://127.0.0.1:1", FIELD_REPORT_CWD: "/not/the/checkout" } });
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer preserves and composes an unrelated pre-commit hook", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    const hook = path.join(fixture.sourceRoot, ".git", "hooks", "pre-commit");
    const original = "#!/bin/sh\nexit 0\n";
    await writeFile(hook, original, { mode: 0o755 });
    const installed = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    const preserved = `${hook}.field-report-preserved`;
    assert.equal(await readFile(preserved, "utf8"), original);
    assert.match(await readFile(hook, "utf8"), new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(await readFile(hook, "utf8"), new RegExp(installed.releaseLauncher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    assert.equal(await readFile(preserved, "utf8"), original);
    const wrapper = await readFile(hook, "utf8");
    await rm(hook);
    await assert.rejects(installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }), /wrapper is missing/);
    await writeFile(hook, wrapper, { mode: 0o755 });
    await rm(preserved);
    await assert.rejects(installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath }), /incomplete or drifted/);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer preserves a composed hook that merely copies the managed marker", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    const hook = path.join(fixture.sourceRoot, ".git", "hooks", "pre-commit");
    const composed = "#!/bin/sh\n# field-report-managed-pre-commit:v1\nunset FIELD_REPORT_URL\nunset FIELD_REPORT_CWD\nrun-other-checks\n";
    await writeFile(hook, composed, { mode: 0o755 });
    await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    assert.equal(await readFile(`${hook}.field-report-preserved`, "utf8"), composed);
    assert.match(await readFile(hook, "utf8"), /field-report-managed-pre-commit:v2/);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer preserves an exact-shaped hook that targets an unrelated launcher", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    const hook = path.join(fixture.sourceRoot, ".git", "hooks", "pre-commit");
    const unrelated = "#!/bin/sh\n# field-report-managed-pre-commit:v1\nunset FIELD_REPORT_URL\nunset FIELD_REPORT_CWD\nexec '/tmp/not-field-report/fr' hook pre-commit\n";
    await writeFile(hook, unrelated, { mode: 0o755 });
    await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    assert.equal(await readFile(`${hook}.field-report-preserved`, "utf8"), unrelated);
    assert.doesNotMatch(await readFile(hook, "utf8"), /not-field-report/);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("installer preserves a hook targeting an invalid SHA-named release directory", async () => {
  const fixture = await installFixture({ configuredProject: true });
  try {
    const revision = "a".repeat(40);
    const releaseRoot = path.join(fixture.home, ".local", "share", "field-report", "releases", revision);
    const launcher = path.join(releaseRoot, "fr");
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(path.join(releaseRoot, "install-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      revision,
      stateRoot: fixture.sourceRoot,
      nodeExecutable: process.execPath,
      payloadDigest: await releasePayloadDigest(releaseRoot)
    }));
    const hook = path.join(fixture.sourceRoot, ".git", "hooks", "pre-commit");
    const contents = `#!/bin/sh\n# field-report-managed-pre-commit:v1\nunset FIELD_REPORT_URL\nunset FIELD_REPORT_CWD\nexec '${launcher}' hook pre-commit\n`;
    await writeFile(hook, contents, { mode: 0o755 });
    const installed = await installFieldReport({ sourceRoot: fixture.sourceRoot, home: fixture.home, nodeExecutable: process.execPath });
    assert.equal(await readFile(`${hook}.field-report-preserved`, "utf8"), contents);
    assert.match(await readFile(hook, "utf8"), new RegExp(installed.releaseLauncher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
