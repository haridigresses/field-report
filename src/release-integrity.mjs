import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { releaseLauncherText } from "./hooks.mjs";

const excludedReleaseFiles = new Set(["fr", "install-manifest.json"]);
const exec = promisify(execFile);
export const releasePayloadEntries = ["bin", "docs", "integrations", "scripts", "skills", "src", "package.json"];

async function hashEntry(hash, root, relative) {
  const absolute = path.join(root, relative);
  const stat = await lstat(absolute);
  if (stat.isDirectory()) {
    hash.update(`directory\0${relative}\0`);
    const children = (await readdir(absolute)).sort();
    for (const child of children) await hashEntry(hash, root, path.join(relative, child));
    return;
  }
  if (stat.isSymbolicLink()) {
    hash.update(`symlink\0${relative}\0${await readlink(absolute)}\0`);
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported installed release entry: ${absolute}`);
  const contents = await readFile(absolute);
  hash.update(`file\0${relative}\0${contents.length}\0`);
  hash.update(contents);
}

export async function releasePayloadDigest(root) {
  const hash = createHash("sha256");
  const entries = (await readdir(root)).filter((entry) => !excludedReleaseFiles.has(entry)).sort();
  for (const entry of entries) await hashEntry(hash, root, entry);
  return hash.digest("hex");
}

export async function materializeGitRelease(sourceRoot, revision) {
  const snapshot = await mkdtemp(path.join(os.tmpdir(), `field-report-source-${revision.slice(0, 12)}-`));
  const archive = path.join(snapshot, "release.tar");
  try {
    await exec("git", ["archive", "--format=tar", "--output", archive, revision, "--", ...releasePayloadEntries], { cwd: sourceRoot, timeout: 30_000, maxBuffer: 1024 * 1024 });
    await exec("tar", ["-xf", archive, "-C", snapshot], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    await rm(archive, { force: true });
    return snapshot;
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

export async function gitRevisionPayloadDigest(sourceRoot, revision) {
  const snapshot = await materializeGitRelease(sourceRoot, revision);
  try { return await releasePayloadDigest(snapshot); }
  finally { await rm(snapshot, { recursive: true, force: true }); }
}

export async function assertInstalledReleaseClaim({ runtimeRoot, stateRoot, revision, nodeExecutable = null }) {
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "install-manifest.json"), "utf8"));
  const metadataMismatch = manifest.revision !== revision
    || manifest.stateRoot !== stateRoot
    || !path.isAbsolute(manifest.nodeExecutable || "")
    || (nodeExecutable && manifest.nodeExecutable !== nodeExecutable);
  if (![1, 2].includes(manifest.schemaVersion) || metadataMismatch) throw new Error(`Installed Field Report release metadata does not match ${revision}`);
  return manifest;
}

export async function assertInstalledRelease({ runtimeRoot, stateRoot, revision, nodeExecutable = null, allowLegacySchema1 = false }) {
  const manifest = await assertInstalledReleaseClaim({ runtimeRoot, stateRoot, revision, nodeExecutable });
  const payloadMatches = manifest.schemaVersion === 2
    ? manifest.payloadDigest === await releasePayloadDigest(runtimeRoot)
    : allowLegacySchema1 && manifest.schemaVersion === 1;
  if (!payloadMatches) {
    throw new Error(`Installed Field Report release payload does not match ${revision}`);
  }
  const launcher = path.join(runtimeRoot, "fr");
  const [contents, stat] = await Promise.all([readFile(launcher, "utf8"), lstat(launcher)]);
  const expected = releaseLauncherText({ stateRoot, runtimeRoot, revision, nodeExecutable: manifest.nodeExecutable });
  if (!stat.isFile() || !(stat.mode & 0o111) || contents !== expected) throw new Error(`Installed Field Report release launcher does not match ${revision}`);
  return manifest;
}
