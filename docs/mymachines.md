# My Machines for Sol and Fable

Cursor Cloud Agents run their model loop in Cursor's cloud. My Machines makes their tool calls execute on this host, so `codex` (Sol) and ordinary `claude` (Fable) can run with the user's existing login-shell credentials.

Managed Cursor VMs cannot reach those CLIs. If this session is not executing on a My Machines worker, `fr machines status` reports them unavailable.

## Host setup

1. Install the Cursor CLI and sign in:

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent --version
```

2. Confirm the review CLIs resolve in the login shell Field Report uses:

```bash
zsh -ic 'command -v codex'
zsh -ic 'command -v claude'
fr machines status
```

`accessible` is true only when both `codex` and `claude` resolve. Do not restore `claude-aws`.

3. Start one long-lived worker per checkout. Field Report prints the commands:

```bash
fr machines worker
```

The default machine name is `local`. Override with `--name`. Keep each process running while Cloud Agents should be able to invoke the CLIs. A worker is bound to the git remote of `--worker-dir`; start a separate worker in each Field Report project checkout.

4. Route work to this host while it is online:

- In the Cloud Agent environment picker, choose `local` under My Machines / Remote Control.
- From Slack, GitHub, or Linear, include `worker=local` or `machine=local`. Those are the only trigger options that target My Machines.

`agent worker debug` reports whether Cursor can see a matching worker.

## Cloud Agent invocation

Before launching Sol or Fable, run `fr machines status --json`. If `accessible` is false, stop and report that the local machine is not serving those CLIs. Do not substitute Cursor-hosted models for required Sol or Fable evidence.

Write the Field Report brief to a prompt file, then print the exact host command:

```bash
fr machines invoke sol --prompt-file /tmp/sol.txt --cwd /path/to/repo --kind review
fr machines invoke fable --prompt-file /tmp/fable.txt --cwd /path/to/repo --base <40-char-sha> --head <40-char-sha>
```

Sol reviews use `gpt-5.6-sol` through `codex exec` with `--ephemeral --sandbox read-only --ask-for-approval never`. Sol work uses `--sandbox workspace-write`. Fable uses `claude-fable-5` through ordinary `claude` in `dontAsk` mode, with Bash limited to the exact `git diff` of the brief SHAs.

Bind the provider-run ID or last-message path with `fr review bind` before `fr review record`.
