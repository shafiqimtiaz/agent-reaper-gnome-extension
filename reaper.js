import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CLK_TCK = 100;
const KILL_GRACE_MS = 5000;
const AGENT_BIN = {
    claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', freebuff: 'Codebuff',
    codebuff: 'Codebuff', pi: 'pi', 'cursor-agent': 'Cursor', aider: 'Aider', goose: 'Goose', crush: 'Crush', amp: 'Amp',
};
const MARKERS = [
    ['CLAUDECODE', 'Claude Code', 'CLAUDE_PID'], ['CLAUDE_CODE_ENTRYPOINT', 'Claude Code', 'CLAUDE_PID'],
    ['OPENCODE', 'OpenCode', null], ['CODEX_THREAD_ID', 'Codex', null], ['CODEX_SESSION_ID', 'Codex', null],
    ['CODEX_SANDBOX', 'Codex', null], ['GEMINI_CLI', 'Gemini CLI', null],
    ['CODEBUFF_LAUNCHER_PID', 'Codebuff', 'CODEBUFF_LAUNCHER_PID'], ['PI_CODING_AGENT', 'pi', null],
    ['CURSOR_AGENT', 'Cursor', null],
];
const PROTECT = /ollama|llama-server|^hex\b|\/hex\b|herdr|stack_tray|containerd|dockerd|docker-proxy|postgres|mongod|mysqld|brave|(^|\/)(google-)?chrome( |$)|desktop-plus|headroom serve|headroom proxy|gnome|tracker-miner|tracker3|evolution|Xorg|Xwayland|pipewire|wireplumber|dbus|systemd/;
const decoder = new TextDecoder();

function loadContents(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, res) => {
            try {
                resolve(file.load_contents_finish(res)[1]);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    reject(e);
                else
                    resolve(new Uint8Array());
            }
        });
    });
}

async function readText(path, cancellable) {
    return decoder.decode(await loadContents(path, cancellable));
}

function readLink(path) {
    try {
        return GLib.file_read_link(path);
    } catch {
        return '';
    }
}

async function readProc(pid, uid, uptime, cancellable) {
    const status = await readText(`/proc/${pid}/status`, cancellable);
    const owner = status.match(/Uid:\s+(\d+)/);
    if (!owner || Number(owner[1]) !== uid)
        return null;
    const stat = await readText(`/proc/${pid}/stat`, cancellable);
    if (!stat)
        return null;
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const [cmdline, environ] = await Promise.all([
        readText(`/proc/${pid}/cmdline`, cancellable), readText(`/proc/${pid}/environ`, cancellable)]);
    const env = {};
    for (const entry of environ.split('\0')) {
        const at = entry.indexOf('=');
        if (at > 0)
            env[entry.slice(0, at)] = entry.slice(at + 1);
    }
    const kb = key => Number(status.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? 0);
    return {
        pid, comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), state: rest[0], ppid: Number(rest[1]),
        tty: Number(rest[4]), start: Number(rest[19]), age: uptime - Number(rest[19]) / CLK_TCK,
        cmd: cmdline.replaceAll('\0', ' ').trim(), cwd: readLink(`/proc/${pid}/cwd`),
        rss: Math.floor(kb('VmRSS') / 1024), swap: Math.floor(kb('VmSwap') / 1024), env,
    };
}

export async function snapshot(cancellable) {
    const uid = new Gio.Credentials().get_unix_user();
    const uptime = parseFloat(await readText('/proc/uptime', cancellable));
    const pids = [];
    const dir = GLib.Dir.open('/proc', 0);
    for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
        if (/^\d+$/.test(name))
            pids.push(Number(name));
    }
    dir.close();
    const procs = await Promise.all(pids.map(pid => readProc(pid, uid, uptime, cancellable)));
    return new Map(procs.filter(Boolean).map(p => [p.pid, p]));
}

export function childrenMap(procs) {
    const kids = new Map();
    for (const p of procs.values()) {
        if (!kids.has(p.ppid))
            kids.set(p.ppid, []);
        kids.get(p.ppid).push(p.pid);
    }
    return kids;
}

function descendants(kids, root) {
    const out = [];
    const stack = [root];
    while (stack.length) {
        for (const c of kids.get(stack.pop()) ?? []) {
            if (!out.includes(c)) {
                out.push(c);
                stack.push(c);
            }
        }
    }
    return out;
}

const text = p => p.cmd || p.comm;
const isProtected = p => PROTECT.test(p.cmd) || PROTECT.test(p.comm);
const stopped = p => p.state === 'T' || p.state === 't';

function orphanParents(procs) {
    const ids = new Set([1]);
    for (const p of procs.values()) {
        if (p.comm === 'systemd' || p.cmd.startsWith('/sbin/init'))
            ids.add(p.pid);
    }
    return ids;
}

function ownSession(procs, kids, roots, selfPid) {
    let pid = selfPid;
    while (procs.has(pid) && !roots.has(procs.get(pid).ppid))
        pid = procs.get(pid).ppid;
    return new Set([pid, ...descendants(kids, pid)]);
}

export function owner(env) {
    for (const [key, name, pidVar] of MARKERS) {
        if (key in env) {
            const pid = pidVar ? env[pidVar] ?? '' : '';
            return [name, /^\d+$/.test(pid) ? Number(pid) : null];
        }
    }
    if (Object.values(env).some(v => v.includes('/antigravity')))
        return ['Antigravity', null];
    return [null, null];
}

function agentBinary(p) {
    const first = p.cmd ? p.cmd.split(' ')[0] : p.comm;
    return AGENT_BIN[first.split('/').pop()] ?? null;
}

export function candidates(procs, minAge, selfPid) {
    const kids = childrenMap(procs);
    const roots = orphanParents(procs);
    const safe = ownSession(procs, kids, roots, selfPid);
    const found = new Map();
    const add = (p, agent, reason) => {
        if (!safe.has(p.pid) && !isProtected(p) && !found.has(p.pid))
            found.set(p.pid, [agent, reason]);
    };

    for (const p of procs.values()) {
        if (p.age < minAge || p.state === 'Z')
            continue;
        const orphan = roots.has(p.ppid);
        const agent = agentBinary(p);
        if (agent) {
            if (stopped(p) && orphan)
                add(p, agent, 'stopped session');
            continue;
        }
        const [name, ownerPid] = owner(p.env);
        if (!name)
            continue;
        if (orphan)
            add(p, name, 'orphaned task');
        else if (ownerPid !== null && !procs.has(ownerPid) && p.tty === 0)
            add(p, name, 'left by closed session');
        else if (p.cwd.endsWith('(deleted)'))
            add(p, name, 'folder deleted');
    }

    const zombieCount = new Map();
    for (const p of procs.values()) {
        if (p.state === 'Z')
            zombieCount.set(p.ppid, (zombieCount.get(p.ppid) ?? 0) + 1);
    }
    for (const [parent, n] of zombieCount) {
        const p = procs.get(parent);
        const agent = p && agentBinary(p);
        if (agent && n >= 3 && p.age >= minAge && (stopped(p) || roots.has(p.ppid)))
            add(p, agent, `holding ${n} zombies`);
    }

    const underCandidate = pid => {
        for (let up = procs.get(pid).ppid; procs.has(up); up = procs.get(up).ppid) {
            if (found.has(up))
                return true;
        }
        return false;
    };
    return {found: new Map([...found].filter(([pid]) => !underCandidate(pid))), kids};
}

export function killOrder(procs, kids, pids) {
    const order = [];
    for (const pid of pids) {
        for (const c of descendants(kids, pid).reverse()) {
            if (procs.has(c) && !isProtected(procs.get(c)) && !order.includes(c))
                order.push(c);
        }
        if (!order.includes(pid))
            order.push(pid);
    }
    return order;
}

function signal(pids, name, cancellable) {
    return new Promise(resolve => {
        const proc = Gio.Subprocess.new(['kill', '-s', name, ...pids.map(String)], Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_async(cancellable, (p, res) => {
            try {
                p.wait_finish(res);
            } catch {
                p.force_exit();
            }
            resolve();
        });
    });
}

function sleep(ms, cancellable) {
    return new Promise((resolve, reject) => {
        let handler = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            cancellable.disconnect(handler);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        handler = cancellable.connect(() => {
            GLib.source_remove(id);
            reject(new Error('cancelled'));
        });
    });
}

async function alive(pid, cancellable) {
    const stat = await readText(`/proc/${pid}/stat`, cancellable);
    return stat !== '' && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
}

function log(lines) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_state_dir(), 'agent-reaper.log']));
    try {
        file.get_parent().make_directory_with_parents(null);
    } catch {
    }
    const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
    stream.write_all(new TextEncoder().encode(lines.join('')), null);
    stream.close(null);
}

function rows(procs, found) {
    return [...found]
        .sort(([pa, [aa, ra]], [pb, [ab, rb]]) => aa.localeCompare(ab) || ra.localeCompare(rb) || pa - pb)
        .map(([pid, [agent, reason]]) => {
            const p = procs.get(pid);
            return {pid, key: `${pid}:${p.start}`, agent, reason, age_h: Math.round(p.age / 360) / 10,
                rss: p.rss, swap: p.swap, cmd: text(p).slice(0, 120)};
        });
}

export async function scan(cancellable, minAge = 3600) {
    const procs = await snapshot(cancellable);
    const {found, kids} = candidates(procs, minAge, new Gio.Credentials().get_unix_pid());
    return {procs, found, kids, result: {
        processes: procs.size,
        zombies: [...procs.values()].filter(p => p.state === 'Z').length,
        candidates: rows(procs, found),
    }};
}

export async function reap(cancellable, minAge = 3600) {
    const {procs, found, kids, result} = await scan(cancellable, minAge);
    if (!found.size)
        return result;
    const order = killOrder(procs, kids, [...found.keys()]);
    const stamp = GLib.DateTime.new_now_local().format('%F %T');
    log(order.map(pid => {
        const [agent, reason] = found.get(pid) ?? ['', 'child'];
        return `${stamp} kill ${pid} ${agent} ${reason} ${text(procs.get(pid)).slice(0, 120)}\n`;
    }));
    await signal(order, 'TERM', cancellable);
    await signal(order, 'CONT', cancellable);
    await sleep(KILL_GRACE_MS, cancellable);
    const survivors = [];
    for (const pid of order) {
        if (await alive(pid, cancellable))
            survivors.push(pid);
    }
    if (survivors.length)
        await signal(survivors, 'KILL', cancellable);
    const killed = [];
    for (const pid of order) {
        if (!await alive(pid, cancellable))
            killed.push(procs.get(pid));
    }
    result.cleanup = {
        attempted: order.length, killed: killed.length,
        freed_rss: killed.reduce((s, p) => s + p.rss, 0), freed_swap: killed.reduce((s, p) => s + p.swap, 0),
    };
    return result;
}
