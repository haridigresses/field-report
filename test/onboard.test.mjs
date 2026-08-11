import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const helper = path.resolve("bin/af-onboard-safe");

test("safe onboarding returns the exact cache for the installed AF version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-af-onboard-"));
  const fakeAf = path.join(root, "af");
  const version = "2.0.19";
  await writeFile(fakeAf, `#!/bin/sh\necho 'agent-fixes ${version}'\n`);
  await chmod(fakeAf, 0o755);
  const expected = await readFile(path.resolve("resources/af-onboard", `${version}.md`), "utf8");
  const { stdout } = await exec(helper, [], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
  assert.equal(stdout, expected);
});

test("safe onboarding fails closed when AF and cache versions differ", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-af-onboard-"));
  const fakeAf = path.join(root, "af");
  await writeFile(fakeAf, "#!/bin/sh\necho 'agent-fixes 999.0.0'\n");
  await chmod(fakeAf, 0o755);
  await assert.rejects(
    exec(helper, [], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } }),
    (error) => /no exact onboarding cache for AF 999\.0\.0/.test(error.stderr || "")
  );
});
