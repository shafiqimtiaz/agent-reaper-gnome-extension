#!/usr/bin/env python3
import argparse, json, os, re, signal, sys, time

CLK = os.sysconf("SC_CLK_TCK")
ME = os.getuid()
AGENT_BIN = {"claude": "Claude Code", "codex": "Codex", "opencode": "OpenCode", "gemini": "Gemini CLI",
             "freebuff": "Codebuff", "codebuff": "Codebuff", "pi": "pi", "cursor-agent": "Cursor",
             "aider": "Aider", "goose": "Goose", "crush": "Crush", "amp": "Amp"}
MARKERS = [("CLAUDECODE", "Claude Code", "CLAUDE_PID"), ("CLAUDE_CODE_ENTRYPOINT", "Claude Code", "CLAUDE_PID"),
           ("OPENCODE", "OpenCode", None), ("CODEX_THREAD_ID", "Codex", None), ("CODEX_SESSION_ID", "Codex", None),
           ("CODEX_SANDBOX", "Codex", None), ("GEMINI_CLI", "Gemini CLI", None),
           ("CODEBUFF_LAUNCHER_PID", "Codebuff", "CODEBUFF_LAUNCHER_PID"), ("PI_CODING_AGENT", "pi", None),
           ("CURSOR_AGENT", "Cursor", None)]
PROTECT = re.compile(r"ollama|llama-server|^hex\b|/hex\b|herdr|stack_tray|containerd|dockerd|docker-proxy|postgres|mongod|mysqld|brave|(^|/)(google-)?chrome( |$)|desktop-plus|headroom serve|headroom proxy|gnome|tracker-miner|tracker3|evolution|Xorg|Xwayland|pipewire|wireplumber|dbus|systemd")


def read(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return b""


def snapshot():
    up = float(read("/proc/uptime").split()[0])
    procs = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        raw = read(f"/proc/{name}/stat").decode(errors="replace")
        if not raw:
            continue
        status = read(f"/proc/{name}/status").decode(errors="replace")
        uid = re.search(r"Uid:\s+(\d+)", status)
        if not uid or int(uid.group(1)) != ME:
            continue
        rest = raw[raw.rindex(")") + 2:].split()
        rss = re.search(r"VmRSS:\s+(\d+)", status)
        swap = re.search(r"VmSwap:\s+(\d+)", status)
        try:
            cwd = os.readlink(f"/proc/{name}/cwd")
        except OSError:
            cwd = ""
        pid = int(name)
        env = dict(kv.split(b"=", 1) for kv in read(f"/proc/{name}/environ").split(b"\0") if b"=" in kv)
        procs[pid] = dict(
            pid=pid, comm=raw[raw.index("(") + 1:raw.rindex(")")], state=rest[0], ppid=int(rest[1]),
            tty=int(rest[4]), start=int(rest[19]), age=up - int(rest[19]) / CLK,
            cmd=read(f"/proc/{name}/cmdline").replace(b"\0", b" ").decode(errors="replace").strip(), cwd=cwd,
            rss=int(rss.group(1)) // 1024 if rss else 0, swap=int(swap.group(1)) // 1024 if swap else 0,
            env={k.decode(errors="replace"): v.decode(errors="replace") for k, v in env.items()})
    return procs


def children_map(procs):
    kids = {}
    for p in procs.values():
        kids.setdefault(p["ppid"], []).append(p["pid"])
    return kids


def descendants(kids, root):
    out, stack = [], [root]
    while stack:
        for c in kids.get(stack.pop(), []):
            if c not in out:
                out.append(c)
                stack.append(c)
    return out


def text(p):
    return p["cmd"] or p["comm"]


def protected(p):
    return bool(PROTECT.search(p["cmd"]) or PROTECT.search(p["comm"]))


def orphan_parents(procs):
    ids = {1}
    for p in procs.values():
        if p["comm"] == "systemd" or p["cmd"].startswith("/sbin/init"):
            ids.add(p["pid"])
    return ids


def own_session(procs, kids, roots):
    pid = os.getpid()
    while pid in procs and procs[pid]["ppid"] not in roots:
        pid = procs[pid]["ppid"]
    return {pid, *descendants(kids, pid)}


def owner(env):
    for key, name, pid_var in MARKERS:
        if key in env:
            pid = env.get(pid_var or "", "")
            return name, int(pid) if pid.isdigit() else None
    if any("/antigravity" in v for v in env.values()):
        return "Antigravity", None
    return None, None


def agent_binary(p):
    first = p["cmd"].split(" ", 1)[0] if p["cmd"] else p["comm"]
    return AGENT_BIN.get(os.path.basename(first))


def candidates(procs, min_age):
    kids = children_map(procs)
    roots = orphan_parents(procs)
    safe = own_session(procs, kids, roots)
    found = {}

    def add(p, agent, reason):
        if p["pid"] not in safe and not protected(p):
            found.setdefault(p["pid"], (agent, reason))

    for p in procs.values():
        if p["age"] < min_age or p["state"] == "Z":
            continue
        orphan = p["ppid"] in roots
        agent = agent_binary(p)
        if agent:
            if p["state"] in ("T", "t") and orphan:
                add(p, agent, "stopped session")
            continue
        name, owner_pid = owner(p["env"])
        if not name:
            continue
        if orphan:
            add(p, name, "orphaned task")
        elif owner_pid is not None and owner_pid not in procs and p["tty"] == 0:
            add(p, name, "left by closed session")
        elif p["cwd"].endswith("(deleted)"):
            add(p, name, "folder deleted")

    zombie_count = {}
    for p in procs.values():
        if p["state"] == "Z":
            zombie_count[p["ppid"]] = zombie_count.get(p["ppid"], 0) + 1
    for parent, n in zombie_count.items():
        p = procs.get(parent)
        agent = p and agent_binary(p)
        if agent and n >= 3 and p["age"] >= min_age and (p["state"] in ("T", "t") or p["ppid"] in roots):
            add(p, agent, f"holding {n} zombies")

    def under_candidate(pid):
        pid = procs[pid]["ppid"]
        while pid in procs:
            if pid in found:
                return True
            pid = procs[pid]["ppid"]
        return False

    return {pid: v for pid, v in found.items() if not under_candidate(pid)}, kids


def kill_order(procs, kids, pids):
    order = []
    for pid in pids:
        for c in reversed(descendants(kids, pid)):
            if c in procs and not protected(procs[c]) and c not in order:
                order.append(c)
        if pid not in order:
            order.append(pid)
    return order


def signal_all(pids, sig):
    for pid in pids:
        try:
            os.kill(pid, sig)
        except OSError:
            pass


def alive(pid):
    raw = read(f"/proc/{pid}/stat").decode(errors="replace")
    return bool(raw) and raw[raw.rindex(")") + 2:].split()[0] != "Z"


def apply(procs, kids, found):
    order = kill_order(procs, kids, list(found))
    log = os.path.expanduser("~/.local/state/agent-reaper.log")
    os.makedirs(os.path.dirname(log), exist_ok=True)
    with open(log, "a") as f:
        for pid in order:
            agent, reason = found.get(pid, ("", "child"))
            f.write(f"{time.strftime('%F %T')} kill {pid} {agent} {reason} {text(procs[pid])[:120]}\n")
    signal_all(order, signal.SIGTERM)
    signal_all(order, signal.SIGCONT)
    time.sleep(5)
    signal_all([pid for pid in order if alive(pid)], signal.SIGKILL)
    time.sleep(1)
    killed = [pid for pid in order if not alive(pid)]
    return dict(attempted=len(order), killed=len(killed),
                freed_rss=sum(procs[p]["rss"] for p in killed), freed_swap=sum(procs[p]["swap"] for p in killed), log=log)


def main():
    ap = argparse.ArgumentParser(description="Find and optionally kill stale agent leftovers. Dry run by default.")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--min-age", default="1h")
    args = ap.parse_args()
    m = re.fullmatch(r"(\d+)([mhd])", args.min_age)
    if not m:
        sys.exit("--min-age like 30m, 6h, 1d")
    min_age = int(m.group(1)) * {"m": 60, "h": 3600, "d": 86400}[m.group(2)]

    procs = snapshot()
    found, kids = candidates(procs, min_age)
    rows = [dict(pid=pid, key=f"{pid}:{procs[pid]['start']}", agent=agent, reason=reason,
                 age_h=round(procs[pid]["age"] / 3600, 1), rss=procs[pid]["rss"], swap=procs[pid]["swap"],
                 cmd=text(procs[pid])[:120])
            for pid, (agent, reason) in sorted(found.items(), key=lambda kv: (kv[1], kv[0]))]
    result = dict(processes=len(procs), zombies=sum(1 for p in procs.values() if p["state"] == "Z"), candidates=rows)
    if args.apply and found:
        result["cleanup"] = apply(procs, kids, found)

    if args.json:
        print(json.dumps(result))
        return
    print(f"{result['processes']} processes of yours, {result['zombies']} zombies, min age {args.min_age}")
    for r in rows:
        print(f"{r['agent']:12} {r['reason']:24} pid {r['pid']:<8} {r['age_h']:5.1f}h {r['rss']:5}MB rss {r['swap']:5}MB swap  {r['cmd'][:70]}")
    if not rows:
        print("nothing to clean")
    elif "cleanup" in result:
        c = result["cleanup"]
        print(f"killed {c['killed']} of {c['attempted']} processes, freed {c['freed_rss']}MB rss {c['freed_swap']}MB swap; log {c['log']}")
    else:
        print("dry run; add --apply to kill")


if __name__ == "__main__":
    main()
