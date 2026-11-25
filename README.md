# Agent Reaper

A GNOME Shell extension that finds stale processes left by AI coding agents and
kills them from the top bar.

Agents such as Claude Code, Codex and others start shells, MCP servers and dev
servers. When an agent is stopped or its terminal closes, these processes stay
alive and hold memory and swap. Agent Reaper finds them.

## What it finds

Only processes of the current user that are older than one hour:

- stopped agent processes whose parent is gone
- orphaned shells that only run agent or dev-server work
- orphaned Python multiprocessing workers and MCP servers
- dev servers (Vite, esbuild, npm run and others) whose folder was deleted
- agent processes that hold 3 or more zombie processes

It never touches the session that runs it, browsers, databases, Docker,
Ollama, GNOME or the other apps in its protect list. See `PROTECT` in
`agent-reaper.py`, and edit it for your own apps.

## How it works

- Click the icon: it shows each stale process with its age, memory and swap.
- **Clean now** kills them: children first, then the parent. It sends SIGTERM,
  waits 5 seconds, then sends SIGKILL to what is left. Each kill is logged to
  `~/.local/state/agent-reaper.log`.
- Every hour it checks in the background and notifies you when new stale
  processes appear. The notification has a **Clean** button.
- The icon turns orange with a count when something is stale.

## Install

Requires GNOME Shell 46 and Python 3.

```sh
git clone https://github.com/shafiqimtiaz/agent-reaper-gnome-extension.git
ln -s "$PWD/agent-reaper-gnome-extension" \
  ~/.local/share/gnome-shell/extensions/agent-reaper@shafiqimtiaz.github.io
```

Restart GNOME Shell (X11: Alt+F2, `r`, Enter; Wayland: log out and in), then:

```sh
gnome-extensions enable agent-reaper@shafiqimtiaz.github.io
```

## Command line

The script also works on its own. It is a dry run unless you add `--apply`.

```sh
python3 agent-reaper.py              # list stale processes
python3 agent-reaper.py --apply      # kill them
python3 agent-reaper.py --min-age 6h # only older than 6 hours
python3 agent-reaper.py --json       # output for scripts
```

## Tests

```sh
python3 -m unittest test_agent_reaper
```

## License

MIT
