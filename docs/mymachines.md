# My Machines for Sol and Fable

Cursor Cloud Agents run their model loop in Cursor's cloud. My Machines makes their tool calls execute on a specific checkout on this host, so `codex` (Sol) and ordinary `claude` (Fable) can use the user's existing login-shell credentials.

Field Report prints the Sol and Fable CLI recipes. It does not probe host accessibility, start workers, or enumerate other repositories. Cursor owns worker lifecycle, authentication, and connectivity. See [My Machines](https://cursor.com/docs/cloud-agent/self-hosted-guides/my-machines).

## Host setup for one checkout

Install and sign in with Cursor's CLI, then start a worker in the target repository only:

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent worker start --name local --worker-dir /path/to/this/repo
```

Keep that process running while Cloud Agents should be able to invoke the CLIs. Do not pass other Field Report checkouts as extra `--worker-dir` flags. Cursor registers the git remote from that directory; a request for another repo should not run here.

Route work to this host while it is online: choose `local` in the Cloud Agent environment picker, or pass `worker=local` / `machine=local` from Slack, GitHub, or Linear. `agent worker debug` is Cursor's preflight.

## Invocation

Prefer a native same-type path when the invoking agent is that family. Cloud Agents are third-party: write the Field Report brief to a prompt file, then print the exact host command:

```bash
fr machines invoke sol --prompt-file /tmp/sol.txt --cwd /path/to/repo --kind review
fr machines invoke fable --prompt-file /tmp/fable.txt --cwd /path/to/repo --base <40-char-sha> --head <40-char-sha>
```

Sol CLI reviews use `gpt-5.6-sol` through `codex exec`. Fable CLI uses `claude-fable-5` through ordinary `claude` after confirming `HEAD` matches the brief and the worktree is clean, with Bash limited to the exact `git diff` of the brief SHAs.

If that command fails, report the failure. Do not treat a missing binary, a failed login, or a disconnected worker as a reason to substitute Cursor-hosted Sol/Fable models. Use ordinary `claude`, never `claude-aws`.

Bind the provider-run ID or last-message path with `fr review bind` before `fr review record`.
