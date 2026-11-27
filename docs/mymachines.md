# My Machines for host CLI reviewers

Cursor Cloud Agents run their model loop in Cursor's cloud. My Machines makes their tool calls execute on a specific checkout on this host, so `codex` and ordinary `claude` can use the user's existing login-shell credentials.

Field Report prints the `codex` and `claude` CLI recipes for the models your config file launches with them. It does not probe host accessibility, start workers, or enumerate other repositories. Cursor owns worker lifecycle, authentication, and connectivity. See [My Machines](https://cursor.com/docs/cloud-agent/self-hosted-guides/my-machines).

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

Prefer a native same-type path when the invoking agent is that provider. Cloud Agents are third-party: write the Field Report brief to a prompt file, then print the exact host command:

```bash
fr machines invoke codex --prompt-file /tmp/brief.txt --cwd /path/to/repo --kind review
fr machines invoke claude --prompt-file /tmp/brief.txt --cwd /path/to/repo --base <40-char-sha> --head <40-char-sha>
```

Without `--model`, each launcher uses the first seated model that the config file launches with it (`fr seats` shows them). Pass `--model` to pick another; the config file must launch that model with the same CLI. `codex` reviews run through `codex exec -m`. `claude` reviews run through ordinary `claude --model` after confirming `HEAD` matches the brief and the worktree is clean, with Bash limited to the exact `git diff` of the brief SHAs.

If that command fails, report the failure. Do not treat a missing binary, a failed login, or a disconnected worker as a reason to substitute Cursor-hosted models. Use ordinary `claude`, never `claude-aws`.

Bind the provider-run ID or last-message path with `fr review bind` before `fr review record`.
