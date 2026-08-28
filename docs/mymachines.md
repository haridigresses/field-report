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

`accessible.sol` and `accessible.fable` are independent. Missing Codex does not make Fable unavailable. Do not restore `claude-aws`.

3. Start one long-lived worker. Field Report prints a single command with a `--worker-dir` for each checkout:

```bash
fr machines worker
```

The default machine name is `local`. Override with `--name`. Keep that process running while Cloud Agents should be able to invoke the CLIs. The Cursor agent CLI allows only one worker daemon per user data dir; extra `agent worker start` processes fail on `worker.lock`. `--worker-dir` is repeatable, so one `local` process can expose every Field Report checkout.

4. Route work to this host while it is online:

- In the Cloud Agent environment picker, choose `local` under My Machines / Remote Control.
- From Slack, GitHub, or Linear, include `worker=local` or `machine=local`. Those are the only trigger options that target My Machines.

`agent worker debug` reports whether Cursor can see a matching worker.

## Cloud Agent invocation

Before launching a third-party Sol or Fable CLI, run `fr machines status --json` and check `accessible.sol` or `accessible.fable` for the CLI you need. Missing Sol does not block Fable. If that flag is false, stop and report that the local machine is not serving that CLI. Do not substitute Cursor-hosted models. Prefer a native same-type path when the invoking agent is that family.

Write the Field Report brief to a prompt file, then print the exact host command:

```bash
fr machines invoke sol --prompt-file /tmp/sol.txt --cwd /path/to/repo --kind review
fr machines invoke fable --prompt-file /tmp/fable.txt --cwd /path/to/repo --base <40-char-sha> --head <40-char-sha>
```

Sol CLI reviews use `gpt-5.6-sol` through `codex exec -m gpt-5.6-sol -s read-only --ignore-user-config`. Sol work uses `-s workspace-write`. Fable CLI uses `claude-fable-5` through ordinary `claude` in `dontAsk` mode after confirming `HEAD` matches the brief, with Bash limited to the exact `git diff` of the brief SHAs.

Bind the provider-run ID or last-message path with `fr review bind` before `fr review record`.
