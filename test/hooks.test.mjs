import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runGhWrapper } from "../bin/fr-gh.mjs";
import { classifyGhArgs, extractShellGhInvocations, handleHostHook, hasInstalledHostHooks, installHostHooks } from "../src/host-hooks.mjs";
import { hookState, isManagedHook, removeLegacyPreCommitHook } from "../src/hooks.mjs";
import { createStore } from "../src/store.mjs";

const exec = promisify(execFile);

test("legacy pre-commit hooks are detected and cleanly removed, restoring preserved user hooks", async () => {
  assert.equal(isManagedHook("# field-report-commit-gate:v4"), true);
  assert.equal(hookState("#!/bin/sh\n# field-report-commit-gate:v3\n"), "legacy-managed");
  assert.equal(hookState("npx lint-staged\nfr gate checkout\n"), "legacy-manual");
  assert.equal(hookState("#!/bin/sh\nnpm test\n"), "absent");

  const dir = await mkdtemp(path.join(os.tmpdir(), "fr-legacy-hook-"));
  const hook = path.join(dir, "pre-commit");
  const preserved = `${hook}.field-report-preserved`;
  await writeFile(hook, "#!/bin/sh\n# field-report-commit-gate:v4\nexec fr gate checkout\n");
  await writeFile(preserved, "#!/bin/sh\necho user-hook\n");

  const res = await removeLegacyPreCommitHook(hook, {
    readFileFn: (f) => readFile(f, "utf8").catch(() => null),
    existsFn: (f) => access(f).then(() => true, () => false)
  });
  assert.deepEqual(res, { removed: true, restoredPreserved: true });
  assert.match(await readFile(hook, "utf8"), /user-hook/);
});

test("classifyGhArgs and extractShellGhInvocations separate open PRs, draft PRs, ready PRs, and normal gh commands", () => {
  assert.equal(classifyGhArgs(["pr", "create", "--title", "x"]).action, "open-pr");
  assert.equal(classifyGhArgs(["-R", "owner/repo", "pr", "create", "--draft", "--title", "x"]).action, "draft-pr");
  assert.deepEqual(
    [classifyGhArgs(["pr", "create", "-R", "owner/repo", "--head", "owner:feat/other"]).action, classifyGhArgs(["pr", "create", "-R", "owner/repo", "--head", "owner:feat/other"]).explicitRepo, classifyGhArgs(["pr", "create", "-R", "owner/repo", "--head", "owner:feat/other"]).explicitHead],
    ["open-pr", "owner/repo", "feat/other"]
  );
  assert.equal(classifyGhArgs(["pr", "create", "-d"]).action, "draft-pr");
  assert.equal(classifyGhArgs(["pr", "create", "-df"]).action, "draft-pr");
  assert.equal(classifyGhArgs(["pr", "create", "-B", "develop"]).action, "open-pr");
  assert.equal(classifyGhArgs(["pr", "ready", "49"]).action, "ready-pr");
  assert.equal(classifyGhArgs(["pr", "ready", "--undo", "49"]).action, "allow");
  assert.equal(classifyGhArgs(["pr", "view", "49"]).action, "allow");
  assert.equal(classifyGhArgs(["issue", "create", "-t", "todo"]).action, "allow");

  const cmds = extractShellGhInvocations("git push -u origin feat/x && FOO=1 gh pr create --title 'Ship it'");
  assert.equal(cmds.length, 1);
  assert.equal(classifyGhArgs(cmds[0]).action, "open-pr");
});

test("installHostHooks preserves existing Claude/Cursor settings and PreToolUse + fr-gh block un-MRR'd PR open without [y/N]", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-host-hooks-"));
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", hooks: { Notification: [{ hooks: [{ type: "command", command: "say hi" }] }] } }));

  const installed = await installHostHooks({ frBin: "/opt/bin/fr", home });
  const claudeJson = await readFile(installed.claudeSettingsPath, "utf8");
  const cursorJson = await readFile(installed.cursorHooksPath, "utf8");
  assert.equal(hasInstalledHostHooks(claudeJson, "claude"), true);
  assert.equal(hasInstalledHostHooks(cursorJson, "cursor"), true);
  assert.equal(JSON.parse(claudeJson).theme, "dark");
  assert.equal(JSON.parse(claudeJson).hooks.Notification.length, 1);

  // Set up an enabled repo on a feature branch with NO MRR recorded.
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "fr@example.invalid"]);
  await exec("git", ["-C", repo, "config", "user.name", "FR"]);
  await writeFile(path.join(repo, "a.txt"), "1\n");
  await exec("git", ["-C", repo, "add", "a.txt"]);
  await exec("git", ["-C", repo, "commit", "-m", "init"]);
  await exec("git", ["clone", "--bare", repo, origin]);
  await exec("git", ["-C", repo, "remote", "add", "origin", origin]);
  await exec("git", ["-C", repo, "fetch", "origin"]);
  await exec("git", ["-C", repo, "checkout", "-b", "feat/unreviewed"]);
  await writeFile(path.join(repo, "a.txt"), "2\n");
  await exec("git", ["-C", repo, "commit", "-am", "change"]);

  const store = createStore(path.join(root, "state"));
  await store.saveProject({ id: "demo", repoPath: repo, githubRepo: "owner/demo" });

  // SessionStart writes CLAUDE_ENV_FILE and prints context.
  const envFile = path.join(root, "claude.env");
  const startRes = await handleHostHook("session-start", JSON.stringify({ session_id: "sess-abc", cwd: repo }), {
    store,
    env: { CLAUDE_ENV_FILE: envFile }
  });
  assert.match(startRes.stdout, /Field Report enabled for project 'demo'/);
  assert.match(await readFile(envFile, "utf8"), /FR_SESSION_ID='sess-abc'/);

  // Claude PreToolUse blocks non-draft gh pr create (exit 2) and MCP create_pull_request, allows --draft.
  const claudeBlocked = await handleHostHook("pre-tool", JSON.stringify({ tool_name: "Bash", cwd: repo, tool_input: { command: "gh pr create --title x" } }), { store });
  assert.equal(claudeBlocked.exitCode, 2);
  assert.match(claudeBlocked.stderr, /Field Report BLOCKED/);

  const mcpBlocked = await handleHostHook("pre-tool", JSON.stringify({ tool_name: "mcp__github__create_pull_request", cwd: repo, tool_input: { owner: "owner", repo: "demo", title: "x" } }), { store });
  assert.equal(mcpBlocked.exitCode, 2);

  const cursorBlocked = await handleHostHook("pre-tool", JSON.stringify({ hook_event_name: "beforeShellExecution", workspace_roots: [repo], command: "gh pr ready 12" }), { store });
  assert.equal(JSON.parse(cursorBlocked.stdout).permission, "deny");

  const draftAllowed = await handleHostHook("pre-tool", JSON.stringify({ tool_name: "Bash", cwd: repo, tool_input: { command: "gh pr create --draft --title wip" } }), { store });
  assert.equal(draftAllowed.exitCode, 0);

  // fr-gh wrapper: blocks non-draft unconditionally (no [y/N]), allows --draft with stderr notice.
  const errChunks = [];
  let spawned = 0;
  const mockSpawn = () => {
    spawned += 1;
    return { on: (ev, fn) => { if (ev === "exit") queueMicrotask(() => fn(0, null)); } };
  };
  const blockedCode = await runGhWrapper(["pr", "create", "--title", "x"], {
    env: { FIELD_REPORT_REAL_GH: "/usr/bin/true" },
    cwd: repo,
    store,
    spawnFn: mockSpawn,
    stderr: { write: (s) => errChunks.push(s) }
  });
  assert.equal(blockedCode, 1);
  assert.equal(spawned, 0);
  assert.match(errChunks.join(""), /Field Report BLOCKED 'gh pr create'/);

  errChunks.length = 0;
  const draftCode = await runGhWrapper(["pr", "create", "--draft", "--title", "wip"], {
    env: { FIELD_REPORT_REAL_GH: "/usr/bin/true" },
    cwd: repo,
    store,
    spawnFn: mockSpawn,
    stderr: { write: (s) => errChunks.push(s) }
  });
  assert.equal(draftCode, 0);
  assert.equal(spawned, 1);
  assert.match(errChunks.join(""), /Tell the user explicitly that MRR has not been run yet/);
});
