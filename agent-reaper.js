#!/usr/bin/env -S gjs -m
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

import {reap, scan} from './reaper.js';

const USAGE = 'usage: agent-reaper [--apply] [--json] [--min-age 30m|6h|1d]';

function parse(argv) {
    const opts = {apply: false, json: false, minAge: '1h'};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--apply')
            opts.apply = true;
        else if (argv[i] === '--json')
            opts.json = true;
        else if (argv[i] === '--min-age')
            opts.minAge = argv[++i] ?? '';
        else
            throw new Error(USAGE);
    }
    const m = opts.minAge.match(/^(\d+)([mhd])$/);
    if (!m)
        throw new Error(USAGE);
    opts.seconds = Number(m[1]) * {m: 60, h: 3600, d: 86400}[m[2]];
    return opts;
}

function report(result, opts) {
    print(`${result.processes} processes of yours, ${result.zombies} zombies, min age ${opts.minAge}`);
    for (const r of result.candidates) {
        print(`${r.agent.padEnd(12)} ${r.reason.padEnd(24)} pid ${String(r.pid).padEnd(8)} ${r.age_h.toFixed(1).padStart(5)}h ` +
            `${String(r.rss).padStart(5)}MB rss ${String(r.swap).padStart(5)}MB swap  ${r.cmd.slice(0, 70)}`);
    }
    const c = result.cleanup;
    if (!result.candidates.length)
        print('nothing to clean');
    else if (c)
        print(`killed ${c.killed} of ${c.attempted} processes, freed ${c.freed_rss}MB rss ${c.freed_swap}MB swap`);
    else
        print('dry run; add --apply to kill');
}

let opts;
try {
    opts = parse(system.programArgs);
} catch (e) {
    printerr(e.message);
    system.exit(2);
}

const loop = new GLib.MainLoop(null, false);
let code = 0;
const cancellable = new Gio.Cancellable();
(opts.apply ? reap(cancellable, opts.seconds) : scan(cancellable, opts.seconds).then(s => s.result))
    .then(result => (opts.json ? print(JSON.stringify(result)) : report(result, opts)))
    .catch(e => {
        printerr(e.message);
        code = 1;
    })
    .finally(() => loop.quit());
loop.run();
system.exit(code);
