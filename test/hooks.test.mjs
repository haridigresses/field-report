import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runGhWrapper } from "../bin/fr-gh.mjs";
import { classifyGhArgs, detectShellHarnessViolation, handleHostHook, hasInstalledHostHooks, installHostHooks } from "../src/host-hooks.mjs";
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

test("classifyGhArgs and detectShellHarnessViolation enforce open, draft, ready, merge, explicit-path gh, and workflow/release gates", () => {
  assert.equal(classifyGhArgs(["pr", "create", "--title", "x"]).action, "open-pr");
  assert.equal(classifyGhArgs(["-R", "owner/repo", "pr", "create", "--draft", "--title", "x"]).action, "draft-pr");
  assert.deepEqual(
    [classifyGhArgs(["pr", "create", "-R", "owner/repo", "--head", "owner:feat/other"]).action, classifyGhArgs(["pr", "create", "-R", "owner/repo", "--head", "owner:feat/other"]).explicitRepo, classifyGhArgs(["pr", "create", "-R", "owner/repo", "--head", "owner:feat/other"]).explicitHead],
    ["open-pr", "owner/repo", "feat/other"]
  );
  assert.equal(classifyGhArgs(["pr", "create", "-d"]).action, "draft-pr");
  assert.equal(classifyGhArgs(["pr", "create", "-df"]).action, "draft-pr");
  assert.equal(classifyGhArgs(["pr", "ready", "49"]).action, "ready-pr");
  assert.equal(classifyGhArgs(["pr", "merge", "50", "--squash"]).action, "merge-pr");
  assert.equal(classifyGhArgs(["pr", "merge", "--help"]).action, "allow");
  assert.equal(classifyGhArgs(["pr", "create", "--title", "-H", "--draft"]).action, "draft-pr");
  assert.equal(classifyGhArgs(["pr", "create", "--title", "-h"]).action, "open-pr");
  assert.equal(classifyGhArgs(["pr", "create", "--help"]).action, "allow");
  assert.equal(classifyGhArgs(["api", "repos/owner/repo/pulls"]).action, "allow");
  assert.equal(classifyGhArgs(["pr", "ready", "--undo", "49"]).action, "allow");
  assert.equal(classifyGhArgs(["pr", "view", "49"]).action, "allow");
  assert.equal(classifyGhArgs(["issue", "create", "-t", "todo"]).action, "allow");

  // Explicit-path /.../gh calls are denied, except ~/.local/bin/gh, diagnostics (`auth status`/`--version`), and read-only file utilities (`ls`/`which`).
  assert.equal(detectShellHarnessViolation("/opt/homebrew/bin/gh pr create --title x")?.kind, "deny");
  assert.equal(detectShellHarnessViolation("env FOO=1 '/usr/local/bin/gh' -R o/r pr merge 17")?.kind, "deny");
  assert.equal(detectShellHarnessViolation("/opt/homebrew/bin/gh api repos/o/r/pulls -f title=x")?.kind, "deny");
  assert.equal(detectShellHarnessViolation("/Users/u/.local/bin/gh pr create --title x"), null);
  assert.equal(detectShellHarnessViolation("/opt/homebrew/bin/gh auth status"), null);
  assert.equal(detectShellHarnessViolation("ls -la /opt/homebrew/bin/gh && which /opt/homebrew/bin/gh"), null);
  assert.equal(detectShellHarnessViolation("cd /tmp/wt && gh pr create --title x"), null);

  // Manual workflow run / release create always ask for human confirmation.
  assert.equal(detectShellHarnessViolation("gh workflow run publish.yml -f publish=true")?.kind, "ask");
  assert.equal(detectShellHarnessViolation("gh -R o/r release create v0.1.0")?.kind, "ask");
});

test("PreToolUse blocks explicit-path gh, MCP open/ready/merge, and asks on workflow/release without false-blocking shell cd across worktrees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-host-hooks-"));
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await mkdir(path.join(home, ".config", "devin"), { recursive: true });
  await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", hooks: { Notification: [{ hooks: [{ type: "command", command: "say hi" }] }] } }));
  await writeFile(path.join(home, ".config", "devin", "config.json"), JSON.stringify({ version: 1, theme_mode: "dark" }));

  const installed = await installHostHooks({ frBin: "/opt/bin/fr", home });
  assert.equal(hasInstalledHostHooks(await readFile(installed.claudeSettingsPath, "utf8"), "claude"), true);
  assert.equal(hasInstalledHostHooks(await readFile(installed.cursorHooksPath, "utf8"), "cursor"), true);
  assert.equal(hasInstalledHostHooks(await readFile(installed.agyHooksPath, "utf8"), "agy"), true);
  assert.equal(hasInstalledHostHooks(await readFile(installed.devinConfigPath, "utf8"), "devin"), true);

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

  // SessionStart writes CLAUDE_ENV_FILE and prints the complete BRR/TRR/CRR/MRR + red-CI banner.
  const envFile = path.join(root, "claude.env");
  const startRes = await handleHostHook("session-start", JSON.stringify({ session_id: "sess-abc", cwd: repo }), {
    store,
    env: { CLAUDE_ENV_FILE: envFile }
  });
  assert.match(startRes.stdout, /Field Report ACTIVE for repository 'demo'/);
  assert.match(startRes.stdout, /gh run view --log-failed/);
  assert.match(await readFile(envFile, "utf8"), /FR_SESSION_ID='sess-abc'/);

  // Bare `gh` with `cd wt` passes straight through PreToolUse (no false block against `repo` on `main`!).
  const shellCdAllowedInHook = await handleHostHook("pre-tool", JSON.stringify({
    tool_name: "Bash",
    cwd: repo,
    tool_input: { command: `cd "${wt}" && gh pr create --title x` }
  }), { store });
  assert.equal(shellCdAllowedInHook.exitCode, 0);

  // Explicit `/opt/homebrew/bin/gh pr create` IS hard-denied in Antigravity, Claude, and Cursor!
  const agyExplicitGhDenied = await handleHostHook("pre-tool", JSON.stringify({
    hookEventName: "PreToolUse",
    workspacePaths: [repo],
    toolCall: { id: "1", name: "run_command", args: { CommandLine: "/opt/homebrew/bin/gh pr create --title bypass" } }
  }), { store });
  assert.equal(JSON.parse(agyExplicitGhDenied.stdout).decision, "deny");

  const claudeExplicitGhDenied = await handleHostHook("pre-tool", JSON.stringify({
    tool_name: "Bash",
    cwd: repo,
    tool_input: { command: "/opt/homebrew/bin/gh pr create --title bypass" }
  }), { store });
  assert.equal(claudeExplicitGhDenied.exitCode, 2);

  // `gh workflow run ... publish=true` returns `force_ask` (Antigravity) and `ask` (Cursor & Claude)!
  const agyWorkflowAsk = await handleHostHook("pre-tool", JSON.stringify({
    hookEventName: "PreToolUse",
    workspacePaths: [repo],
    toolCall: { id: "2", name: "run_command", args: { CommandLine: "gh workflow run publish.yml -f publish=true" } }
  }), { store });
  assert.equal(JSON.parse(agyWorkflowAsk.stdout).decision, "force_ask");

  const claudeWorkflowAsk = await handleHostHook("pre-tool", JSON.stringify({
    tool_name: "Bash",
    cwd: repo,
    tool_input: { command: "gh release create v0.1.0" }
  }), { store });
  assert.equal(claudeWorkflowAsk.exitCode, 0);
  assert.equal(JSON.parse(claudeWorkflowAsk.stdout).hookSpecificOutput.permissionDecision, "ask");

  const cursorWorkflowAsk = await handleHostHook("pre-tool", JSON.stringify({
    hook_event_name: "beforeShellExecution",
    workspace_roots: [repo],
    command: "gh workflow run publish.yml"
  }), { store });
  assert.equal(JSON.parse(cursorWorkflowAsk.stdout).permission, "ask");

  // MCP PR-open, PR-ready (`pull_request_write` method=update draft=false), and PR-merge are ALL blocked!
  const mcpBlocked = await handleHostHook("pre-tool", JSON.stringify({
    tool_name: "mcp__github__create_pull_request",
    cwd: wt,
    tool_input: { owner: "owner", repo: "demo", title: "x", head: "feat/unreviewed" }
  }), { store });
  assert.equal(mcpBlocked.exitCode, 2);

  const mcpWriteUpdateReadyBlocked = await handleHostHook("pre-tool", JSON.stringify({
    tool_name: "mcp__github__pull_request_write",
    cwd: wt,
    tool_input: { method: "update", draft: false, owner: "owner", repo: "demo", pullNumber: 12, head: "feat/unreviewed" }
  }), { store });
  assert.equal(mcpWriteUpdateReadyBlocked.exitCode, 2);

  const mcpMergeBlocked = await handleHostHook("pre-tool", JSON.stringify({
    tool_name: "mcp__github__merge_pull_request",
    cwd: repo,
    tool_input: { owner: "owner", repo: "demo", pullNumber: 12 }
  }), { store });
  assert.equal(mcpMergeBlocked.exitCode, 2);
  assert.match(mcpMergeBlocked.stderr, /agents never merge/);

  // Antigravity SessionStart + deduplicated PreInvocation prompt capture.
  const agyStart = await handleHostHook("session-start", JSON.stringify({ hookEventName: "SessionStart", conversationId: "agy-conv-1", workspacePaths: [repo] }), { store });
  assert.match(JSON.parse(agyStart.stdout).injectSteps[0].systemMessage.systemMessage, /Field Report ACTIVE for repository 'demo'/);
  await handleHostHook("prompt-submit", JSON.stringify({ hookEventName: "PreInvocation", conversationId: "agy-conv-1", workspacePaths: [repo], lastUserInput: "Build safe feature", invocationNum: 1 }), { store });
  await handleHostHook("prompt-submit", JSON.stringify({ hookEventName: "PreInvocation", conversationId: "agy-conv-1", workspacePaths: [repo], lastUserInput: "Build safe feature", invocationNum: 2 }), { store });
  assert.equal((await store.prompts("demo", "agy-conv-1")).length, 1);

  const errChunks = [];
  let spawned = 0;
  const mockSpawn = () => {
    spawned += 1;
    return { on: (ev, fn) => { if (ev === "exit") queueMicrotask(() => fn(0, null)); } };
  };

  // `gh pr merge` is mechanically blocked by fr-gh on enabled repos (even from `main`), and allowed on unregistered repos!
  const mergeBlockedCode = await runGhWrapper(["pr", "merge", "17", "--squash"], {
    env: { FIELD_REPORT_REAL_GH: "/usr/bin/true" },
    cwd: repo,
    store,
    spawnFn: mockSpawn,
    stderr: { write: (s) => errChunks.push(s) }
  });
  assert.equal(mergeBlockedCode, 1);
  assert.equal(spawned, 0);
  assert.match(errChunks.join(""), /Field Report BLOCKED 'gh pr merge'/);

  const unmanagedMergeAllowed = await runGhWrapper(["pr", "merge", "17", "-R", "other/unmanaged"], {
    env: { FIELD_REPORT_REAL_GH: "/usr/bin/true" },
    cwd: repo,
    store,
    spawnFn: mockSpawn,
    stderr: { write: () => {} }
  });
  assert.equal(unmanagedMergeAllowed, 0);
  assert.equal(spawned, 1);

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
  assert.equal(bypassAttempt, 1);

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
  assert.match(errChunks.join(""), /Tell the user explicitly that MRR has not been run yet/);

  // Project without --github (`githubRepo: null`) still blocks fork/remote MCP, Cursor stdio beforeMCPExecution, and -R URL/host-prefixed forms!
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

  for (const repoArg of ["owner/demo", "github.com/owner/demo", "https://github.com/owner/demo.git"]) {
    const code = await runGhWrapper(["pr", "create", "-R", repoArg, "--title", "x"], {
      env: { FIELD_REPORT_REAL_GH: "/usr/bin/true" },
      cwd: wt,
      store,
      spawnFn: mockSpawn,
      stderr: { write: () => {} }
    });
    assert.equal(code, 1, `-R ${repoArg} must match fork remote and block`);
  }

  await exec("git", ["-C", repo, "remote", "set-url", "origin", origin]);
  await exec("git", ["-C", repo, "remote", "remove", "upstream"]);
  await store.updateProject("demo", { githubRepo: "owner/demo" });

  // Numeric `gh pr ready 99` evaluates PR #99's own branch via gh pr view rather than current checkout.
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
