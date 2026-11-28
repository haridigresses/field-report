import "./support/seats.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  agyInvokeCommand,
  claudeInvokeCommand,
  claudeInvokeInner,
  codexInvokeCommand,
  cursorReviewCommand,
  devinInvokeCommand
} from "../src/machines.mjs";
import { useSeatConfig } from "../src/seats.mjs";

const exec = promisify(execFile);
const sha = "a".repeat(40);
const head = "b".repeat(40);

test("codex, claude, cursor, agy, and devin invoke commands isolate MCP and enforce read-only diff rules", () => {
  const repo = "/tmp/work repo";
  const prompt = "/tmp/brief's.txt";
  const astra = codexInvokeCommand({ promptFile: prompt, cwd: repo, kind: "review" });
  assert.match(astra, /^zsh \+o banghist -ic /);
  assert.match(astra, /command codex exec -m gpt-6-astra -s read-only --ignore-user-config --json --color never/);

  const claudeInner = claudeInvokeInner({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head });
  assert.match(claudeInner, /--strict-mcp-config --mcp-config '\{"mcpServers":\{\}\}'/);
  const claude = claudeInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head });
  assert.match(claude, /command claude --print --permission-mode dontAsk/);
  assert.doesNotMatch(claude, /claude-aws/);
  assert.match(claude, /--strict-mcp-config/);

  const cursor = cursorReviewCommand({ model: "grok-4.6" });
  assert.equal(cursor, "fr-cursor-review --model cursor-grok-4.6-high --print --output-format stream-json --sandbox enabled --trust < <prompt>");

  try {
    useSeatConfig({
      schemaVersion: 1,
      seats: {
        correctness: { models: [{ id: "swe-1.6", launch: "devin" }] },
        design: { models: [{ id: "gemini-4-neon", launch: "agy", cliModel: "gemini-4-neon-high" }] },
        intent: { models: [{ id: "claude-opus-5-5", launch: "claude" }] }
      }
    });
    const agy = agyInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head, model: "gemini-4-neon" });
    assert.match(agy, /command agy --mode plan --sandbox --disable-slash-commands --output-format json --model gemini-4-neon-high/);
    assert.match(agy, /write_file\(\*\)/);
    assert.match(agy, /edit_file\(\*\)/);
    assert.match(agy, /mcp\(\*\)/);

    const devin = devinInvokeCommand({ promptFile: prompt, cwd: repo, baseSha: sha, headSha: head, model: "swe-1.6" });
    assert.match(devin, /fr-devin-review --base /);
    assert.doesNotMatch(devin, /--sandbox/);
  } finally {
    useSeatConfig(null);
  }
});

test("claude inner command enforces exact HEAD and clean worktree on MRR, and allows dirty tree on CRR", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fr-claude-run-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const prompt = path.join(root, "prompt.txt");
  const log = path.join(root, "claude.log");
  await mkdir(bin);
  await writeFile(prompt, "brief");
  await writeFile(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > ${JSON.stringify(log)}\n`);
  await chmod(path.join(bin, "claude"), 0o755);
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "test"]);
  await writeFile(path.join(repo, "file.txt"), "ok\n");
  await exec("git", ["-C", repo, "add", "file.txt"]);
  await exec("git", ["-C", repo, "commit", "-m", "init"]);
  const realHead = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };

  await exec("sh", ["-c", claudeInvokeInner({ promptFile: prompt, cwd: repo, baseSha: realHead, headSha: realHead })], { env });
  assert.match(await readFile(log, "utf8"), /claude-opus-5-5/);

  await writeFile(path.join(repo, "file.txt"), "dirty\n");
  await assert.rejects(exec("sh", ["-c", claudeInvokeInner({ promptFile: prompt, cwd: repo, baseSha: realHead, headSha: realHead, requireClean: true })], { env }));
  await exec("sh", ["-c", claudeInvokeInner({ promptFile: prompt, cwd: repo, baseSha: realHead, headSha: realHead, requireClean: false })], { env });
});
