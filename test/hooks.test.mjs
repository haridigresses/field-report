import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runGhWrapper } from "../bin/fr-gh.mjs";
import { classifyGhArgs, handleHostHook, hasInstalledHostHooks, installHostHooks } from "../src/host-hooks.mjs";
import { CURRENT_HOOK_MARKER, hookState, installPreCommitHook, isManagedHook, removePreCommitHook } from "../src/hooks.mjs";
import { createStore } from "../src/store.mjs";

const exec = promisify(execFile);

test("pre-commit v5 CRR hook installs cleanly, chains preserved user hooks, and restores them on removal", async () => {
  assert.equal(isManagedHook("# field-report-commit-gate:v4"), true);
  assert.equal(isManagedHook(CURRENT_HOOK_MARKER), true);
  assert.equal(hookState(`#!/bin/sh\n${CURRENT_HOOK_MARKER}\n`), "current");
  assert.equal(hookState("#!/bin/sh\n# field-report-commit-gate:v4\n"), "legacy-managed");
  assert.equal(hookState("npx lint-staged\nfr gate checkout\n"), "legacy-manual");
  assert.equal(hookState("npx lint-staged\nfr gate commit\n"), "manual-current");
  assert.equal(hookState("#!/bin/sh\nnpm test\n"), "unmanaged");
  assert.equal(hookState(""), "absent");

  const dir = await mkdtemp(path.join(os.tmpdir(), "fr-crr-hook-"));
  const hook = path.join(dir, "pre-commit");
  await writeFile(hook, "#!/bin/sh\necho user-hook\n", { mode: 0o755 });

  const installed = await installPreCommitHook(hook, "/opt/bin/fr");
  assert.equal(installed.installed, true);
  assert.equal(installed.preservedExisting, true);
  assert.match(await readFile(hook, "utf8"), /field-report-commit-gate:v5/);
  assert.match(await readFile(`${hook}.field-report-preserved`, "utf8"), /user-hook/);

  const res = await removePreCommitHook(hook, {
    readFileFn: (f) => readFile(f, "utf8").catch(() => null),
    existsFn: (f) => access(f).then(() => true, () => false)
  });
  assert.deepEqual(res, { removed: true, restoredPreserved: true });
  assert.match(await readFile(hook, "utf8"), /user-hook/);
});

test("classifyGhArgs separates open PRs, draft PRs, ready PRs, and normal gh commands without misclassifying flag values", () => {
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
  assert.equal(classifyGhArgs(["pr", "ready", "49"]).selector, "49");
  assert.equal(classifyGhArgs(["pr", "create", "--title", "-H", "--draft"]).action, "draft-pr");
  assert.equal(classifyGhArgs(["pr", "create", "--title", "-h"]).action, "open-pr", "-h passed as --title value must NOT be treated as --help");
  assert.equal(classifyGhArgs(["pr", "create", "--help"]).action, "allow");
  assert.equal(classifyGhArgs(["api", "repos/owner/repo/pulls"]).action, "allow");
  assert.equal(classifyGhArgs(["pr", "ready", "--undo", "49"]).action, "allow");
  assert.equal(classifyGhArgs(["pr", "view", "49"]).action, "allow");
  assert.equal(classifyGhArgs(["issue", "create", "-t", "todo"]).action, "allow");
  assert.equal(classifyGhArgs(["pr", "create", "--draft=true"]).action, "draft-pr");
});

test("MCP-only PreToolUse never false-blocks shell cd across worktrees, while fr-gh enforces cwd gate with zero env bypasses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-host-hooks-"));
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await mkdir(path.join(home, ".config", "devin"), { recursive: true });
  await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", hooks: { Notification: [{ hooks: [{ type: "command", command: "say hi" }] }] } }));
  // Legacy Cursor beforeShellExecution entry is automatically cleaned out on upgrade!
  await writeFile(path.join(home, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "'/opt/bin/fr' _hook pre-tool" }] } }));
  await writeFile(path.join(home, ".config", "devin", "config.json"), JSON.stringify({ version: 1, theme_mode: "dark" }));

  const installed = await installHostHooks({ frBin: "/opt/bin/fr", home });
  const claudeJson = await readFile(installed.claudeSettingsPath, "utf8");
  const cursorJson = await readFile(installed.cursorHooksPath, "utf8");
  const agyJson = await readFile(installed.agyHooksPath, "utf8");
  const devinJson = await readFile(installed.devinConfigPath, "utf8");
  assert.equal(hasInstalledHostHooks(claudeJson, "claude"), true);
  assert.equal(hasInstalledHostHooks(cursorJson, "cursor"), true);
  assert.equal(hasInstalledHostHooks(agyJson, "agy"), true);
  assert.equal(hasInstalledHostHooks(devinJson, "devin"), true);
  assert.equal(JSON.parse(cursorJson).hooks.beforeShellExecution, undefined, "legacy beforeShellExecution hook must be removed");

  // Set up an enabled repo on `main` AND a feature branch in a worktree.
  const repo = path.join(root, "repo");
  const wt = path.join(root, "repo-wt");
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
  await exec("git", ["-C", repo, "worktree", "add", "-b", "feat/unreviewed", wt]);
  await writeFile(path.join(wt, "a.txt"), "2\n");
  await exec("git", ["-C", wt, "commit", "-am", "change"]);

  const store = createStore(path.join(root, "state"));
  await store.saveProject({ id: "demo", repoPath: repo, githubRepo: "owner/demo" });

  // SessionStart writes CLAUDE_ENV_FILE and prints the complete BRR/TRR/CRR/MRR banner.
  const envFile = path.join(root, "claude.env");
  const startRes = await handleHostHook("session-start", JSON.stringify({ session_id: "sess-abc", cwd: repo }), {
    store,
    env: { CLAUDE_ENV_FILE: envFile }
  });
  assert.match(startRes.stdout, /Field Report ACTIVE for repository 'demo'/);
  assert.match(startRes.stdout, /BRR, MRR, TRR, or CRR/);
  assert.match(await readFile(envFile, "utf8"), /FR_SESSION_ID='sess-abc'/);

  // Shell commands (`cd wt && gh pr create ...`) are NOT blocked by PreToolUse against the session's `main` folder;
  // instead `~/.local/bin/gh` evaluates them in `wt` where `gh` actually runs!
  const shellCdAllowedInHook = await handleHostHook("pre-tool", JSON.stringify({
    tool_name: "Bash",
    cwd: repo,
    tool_input: { command: `cd "${wt}" && gh pr create --title x` }
  }), { store });
  assert.equal(shellCdAllowedInHook.exitCode, 0);

  // MCP PR-open/ready tools ARE blocked across Claude, Cursor, and Antigravity!
  const mcpBlocked = await handleHostHook("pre-tool", JSON.stringify({
    tool_name: "mcp__github__create_pull_request",
    cwd: wt,
    tool_input: { owner: "owner", repo: "demo", title: "x", head: "feat/unreviewed" }
  }), { store });
  assert.equal(mcpBlocked.exitCode, 2);

  const agyMcpBlocked = await handleHostHook("pre-tool", JSON.stringify({
    hookEventName: "PreToolUse",
    workspacePaths: [wt],
    toolCall: { id: "1", name: "mcp_github_create_pull_request", args: { owner: "owner", repo: "demo", title: "x", head: "feat/unreviewed" } }
  }), { store });
  assert.equal(JSON.parse(agyMcpBlocked.stdout).decision, "deny");

  // Antigravity SessionStart + deduplicated PreInvocation prompt capture.
  const agyStart = await handleHostHook("session-start", JSON.stringify({ hookEventName: "SessionStart", conversationId: "agy-conv-1", workspacePaths: [repo] }), { store });
  assert.match(JSON.parse(agyStart.stdout).injectSteps[0].systemMessage.systemMessage, /Field Report ACTIVE for repository 'demo'/);
  await handleHostHook("prompt-submit", JSON.stringify({ hookEventName: "PreInvocation", conversationId: "agy-conv-1", workspacePaths: [repo], lastUserInput: "Build safe feature", invocationNum: 1 }), { store });
  await handleHostHook("prompt-submit", JSON.stringify({ hookEventName: "PreInvocation", conversationId: "agy-conv-1", workspacePaths: [repo], lastUserInput: "Build safe feature", invocationNum: 2 }), { store });
  assert.equal((await store.prompts("demo", "agy-conv-1")).length, 1);

  // Project without --github (`githubRepo: null`) still blocks fork/remote MCP and -R calls!
  await store.updateProject("demo", { githubRepo: "" });
  await exec("git", ["-C", repo, "remote", "set-url", "origin", "https://github.com/forkuser/demo.git"]);
  await exec("git", ["-C", repo, "remote", "add", "upstream", "git@github.com:owner/demo.git"]);

  const cursorStdioMcpBlocked = await handleHostHook("pre-tool", JSON.stringify({
    hook_event_name: "beforeMCPExecution",
    workspace_roots: [wt],
    tool_name: "create_pull_request",
    command: "npx -y @modelcontextprotocol/server-github",
    tool_input: JSON.stringify({ owner: "owner", repo: "demo", title: "x", head: "feat/unreviewed" })
  }), { store });
  assert.equal(JSON.parse(cursorStdioMcpBlocked.stdout).permission, "deny");

  const errChunks = [];
  let spawned = 0;
  const mockSpawn = () => {
    spawned += 1;
    return { on: (ev, fn) => { if (ev === "exit") queueMicrotask(() => fn(0, null)); } };
  };
  for (const repoArg of ["owner/demo", "github.com/owner/demo", "https://github.com/owner/demo.git"]) {
    const code = await runGhWrapper(["pr", "create", "-R", repoArg, "--title", "x"], {
      env: { FIELD_REPORT_REAL_GH: "/usr/bin/true" },
      cwd: wt,
      store,
      spawnFn: mockSpawn,
      stderr: { write: (s) => errChunks.push(s) }
    });
    assert.equal(code, 1);
  }
  assert.equal(spawned, 0);

  await exec("git", ["-C", repo, "remote", "set-url", "origin", origin]);
  await exec("git", ["-C", repo, "remote", "remove", "upstream"]);
  await store.updateProject("demo", { githubRepo: "owner/demo" });

  // Forged HOME, FIELD_REPORT_STATE_ROOT, AND FIELD_REPORT_ALLOW_TEST_ROOT=1 are ALL ignored by fr-gh!
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "fr-shim-home-"));
  const canonicalStore = createStore(path.join(homeRoot, ".local", "state", "field-report"));
  await canonicalStore.saveProject({ id: "demo", repoPath: repo, githubRepo: "owner/demo" });
  const bypassAttempt = await runGhWrapper(["pr", "create", "--title", "x"], {
    env: {
      HOME: path.join(root, "forged-empty-home"),
      FIELD_REPORT_ALLOW_TEST_ROOT: "1",
      FIELD_REPORT_STATE_ROOT: path.join(root, "forged-empty-state"),
      FIELD_REPORT_REAL_GH: "/usr/bin/true"
    },
    homeDir: homeRoot,
    cwd: wt,
    spawnFn: mockSpawn,
    stderr: { write: () => {} }
  });
  assert.equal(bypassAttempt, 1, "FIELD_REPORT_ALLOW_TEST_ROOT=1 must NOT disable the production gh shim");

  // Draft PR passes through with stderr reminder.
  errChunks.length = 0;
  const draftCode = await runGhWrapper(["pr", "create", "--draft", "--title", "wip"], {
    env: { FIELD_REPORT_REAL_GH: "/usr/bin/true" },
    cwd: wt,
    store,
    spawnFn: mockSpawn,
    stderr: { write: (s) => errChunks.push(s) }
  });
  assert.equal(draftCode, 0);
  assert.equal(spawned, 1);
  assert.match(errChunks.join(""), /Tell the user explicitly that MRR has not been run yet/);

  // Numeric `gh pr ready 99` evaluates PR #99's own branch via gh pr view.
  const fakeGh = path.join(root, "fake-gh");
  await writeFile(fakeGh, `#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n  echo '{"number":99,"headRefName":"feat/unreviewed","headRefOid":"'$(git -C "${wt}" rev-parse HEAD)'","baseRefName":"main"}'\n  exit 0\nfi\necho "ALLOWED $@"\n`, { mode: 0o755 });
  const numericReadyBlocked = await runGhWrapper(["pr", "ready", "99"], {
    env: { FIELD_REPORT_REAL_GH: fakeGh },
    cwd: repo,
    store,
    spawnFn: mockSpawn,
    stderr: { write: () => {} }
  });
  assert.equal(numericReadyBlocked, 1);

  // Corrupt JSONL / project JSON fails CLOSED in both MCP PreToolUse and fr-gh.
  await mkdir(path.join(root, "state", "branches", "demo"), { recursive: true });
  await writeFile(path.join(root, "state", "branches", "demo", "feat%2Funreviewed.jsonl"), "{corrupt-json\n");
  const corruptMcp = await handleHostHook("pre-tool", JSON.stringify({ tool_name: "mcp__github__create_pull_request", cwd: wt, tool_input: { owner: "owner", repo: "demo", title: "x" } }), { store });
  assert.equal(corruptMcp.exitCode, 2);
  await writeFile(path.join(root, "state", "projects", "broken.json"), "{not-valid-json\n");
  await assert.rejects(
    runGhWrapper(["pr", "create", "--title", "x"], { env: { FIELD_REPORT_REAL_GH: "/usr/bin/true" }, cwd: wt, store, spawnFn: mockSpawn, stderr: { write: () => {} } }),
    /SyntaxError|JSON/
  );
});
