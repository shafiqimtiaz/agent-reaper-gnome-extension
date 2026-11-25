import * as reaper from './reaper.js';

const SYSTEMD = 2457;
const DAY = 86400;
const SELF = 99999;
const CLAUDE = {CLAUDECODE: '1', CLAUDE_PID: '4000'};
let failures = 0;
let count = 0;

function proc(pid, ppid, cmd, {state = 'S', tty = 0, age = DAY, cwd = '/home/u', comm = null, env = {}} = {}) {
    return {pid, ppid, cmd, state, tty, age, cwd, start: pid, rss: 10, swap: 20, env,
        comm: comm ?? (cmd ? cmd.split(' ')[0].split('/').pop() : '')};
}

function table(...procs) {
    const base = [proc(1, 0, '/sbin/init', {comm: 'systemd'}),
        proc(SYSTEMD, 1, '/usr/lib/systemd/systemd --user', {comm: 'systemd'})];
    return new Map([...base, ...procs].map(p => [p.pid, p]));
}

function zombies(parent, first, n) {
    return Array.from({length: n}, (_, i) => proc(first + i, parent, '', {state: 'Z', comm: 'node'}));
}

const found = procs => reaper.candidates(procs, 3600, SELF).found;

function test(name, fn) {
    count++;
    try {
        fn();
    } catch (e) {
        failures++;
        print(`FAIL ${name}: ${e.message}`);
    }
}

function assert(cond, message) {
    if (!cond)
        throw new Error(message);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('markers name the agent', () => {
    const cases = [[CLAUDE, 'Claude Code'], [{OPENCODE: '1'}, 'OpenCode'], [{CODEX_THREAD_ID: 't'}, 'Codex'],
        [{GEMINI_CLI: '1'}, 'Gemini CLI'], [{PI_CODING_AGENT: 'true'}, 'pi'], [{CODEBUFF_LAUNCHER_PID: '9'}, 'Codebuff'],
        [{VSCODE_GIT_ASKPASS_NODE: '/usr/share/antigravity/antigravity'}, 'Antigravity'], [{}, null]];
    for (const [env, name] of cases)
        assert(reaper.owner(env)[0] === name, `${JSON.stringify(env)} gave ${reaper.owner(env)[0]}`);
});

test('desktop app with zombies is kept', () => {
    assert(!found(table(proc(500, SYSTEMD, '/usr/lib/slack/slack'), ...zombies(500, 501, 3))).has(500), 'slack found');
});

test('stopped agent with zombies is found', () => {
    assert(found(table(proc(600, SYSTEMD, 'claude --chrome', {state: 'T'}), ...zombies(600, 601, 5))).has(600), 'not found');
});

test('orphan without agent marker is kept', () => {
    const f = found(table(proc(700, SYSTEMD, 'bash backfill.sh', {comm: 'bash'}), proc(701, 700, 'python3 migrate.py')));
    assert(f.size === 0, `found ${[...f.keys()]}`);
});

test('orphaned agent task is found once', () => {
    const f = found(table(proc(800, SYSTEMD, 'bash -c ui', {comm: 'bash', env: CLAUDE}),
        proc(801, 800, 'npm run start:dev', {env: CLAUDE}),
        proc(802, 801, 'node /repo/node_modules/.bin/vite', {env: CLAUDE})));
    assert(same([...f.keys()], [800]), `found ${[...f.keys()]}`);
    assert(f.get(800)[0] === 'Claude Code', `agent ${f.get(800)[0]}`);
});

test('task of live agent is kept', () => {
    const f = found(table(proc(4000, 3000, 'claude', {tty: 34816}), proc(801, 4000, 'npm run dev', {env: CLAUDE})));
    assert(f.size === 0, `found ${[...f.keys()]}`);
});

test('detached task of closed agent is found', () => {
    assert(found(table(proc(3000, SYSTEMD, 'herdr-core'), proc(801, 3000, 'node server.js', {env: CLAUDE}))).has(801), 'not found');
});

test('task of closed agent in open terminal is kept', () => {
    const f = found(table(proc(3000, SYSTEMD, 'bash', {tty: 34817}), proc(801, 3000, 'vite', {tty: 34817, env: CLAUDE})));
    assert(f.size === 0, `found ${[...f.keys()]}`);
});

test('young process is kept', () => {
    assert(!found(table(proc(900, SYSTEMD, 'claude --chrome', {state: 'T', age: 60}))).has(900), 'found');
});

test('own session is kept', () => {
    assert(!found(table(proc(SELF, SYSTEMD, 'claude --chrome', {state: 'T'}))).has(SELF), 'found');
});

test('protected descendant is skipped and children go first', () => {
    const procs = table(proc(800, SYSTEMD, 'bash -c ui', {comm: 'bash'}),
        proc(801, 800, 'node /repo/node_modules/.bin/vite'),
        proc(802, 800, 'python3 /stack/tray/stack_tray.py'));
    const order = reaper.killOrder(procs, reaper.childrenMap(procs), [800]);
    assert(same(order, [801, 800]), `order ${order}`);
});

print(`${count - failures}/${count} passed`);
if (failures)
    imports.system.exit(1);
