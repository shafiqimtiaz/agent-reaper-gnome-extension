import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {reap as reapTasks, scan} from './reaper.js';

const CHECK_SECONDS = 3600;
const AUTO_SECONDS = 900;
const FIRST_CHECK_SECONDS = 60;
const MAX_ROWS = 8;
const DIM = 140;
const FAINT = 100;
const WRAPPERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'npm', 'npx', 'uv', 'bun', 'deno']);
const AGENT_STYLE = {
    'Claude Code': 'claude', 'Codex': 'codex', 'OpenCode': 'opencode', 'Gemini CLI': 'gemini',
    'Antigravity': 'antigravity', 'Codebuff': 'codebuff', 'pi': 'pi', 'Cursor': 'cursor',
};

function modePath() {
    return GLib.build_filenamev([GLib.get_user_state_dir(), 'agent-reaper-mode']);
}

function readMode() {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(modePath())[1]).trim() === 'auto';
    } catch {
        return false;
    }
}

// Carry an auto mode picked in 2.2 over to GSettings.
function migrateMode(settings) {
    if (settings.get_user_value('auto-reap') === null && readMode())
        settings.set_boolean('auto-reap', true);
}

const megabytes = rows => rows.reduce((sum, c) => sum + c.rss + c.swap, 0);

function size(mb) {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function age(hours) {
    return hours >= 48 ? `${Math.round(hours / 24)}d` : hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(hours * 60)}m`;
}

function taskName(cmd) {
    const parts = cmd.split(' ').filter(Boolean).map(t => (t.startsWith('/') ? t.split('/').pop() : t));
    if (WRAPPERS.has(parts[0]) && parts[1] && !parts[1].startsWith('-') && cmd.split(' ').filter(Boolean)[1].includes('/'))
        parts.shift();
    const name = parts.join(' ');
    return name.length > 34 ? `${name.slice(0, 33)}…` : name;
}

function reasonStyle(reason) {
    if (reason.startsWith('stopped'))
        return 'stopped';
    if (reason.startsWith('holding'))
        return 'zombie';
    if (reason.startsWith('folder'))
        return 'deleted';
    if (reason.startsWith('left'))
        return 'closed';
    return 'orphan';
}

function label(text, style, opacity = 255) {
    const l = new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER});
    l.opacity = opacity;
    return l;
}

function staticItem(style) {
    return new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false, style_class: style});
}

function groupByAgent(rows) {
    const groups = new Map();
    for (const c of rows) {
        const agent = c.agent || 'Agent';
        if (!groups.has(agent))
            groups.set(agent, []);
        groups.get(agent).push(c);
    }
    return [...groups.entries()].sort((a, b) => megabytes(b[1]) - megabytes(a[1]));
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext, gicon) {
        super._init(0.0, 'Agent Reaper');
        this._autoMode = ext.auto;
        this._lastScan = null;
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box ar-panel'});
        this._icon = new St.Icon({gicon, style_class: 'system-status-icon'});
        this._icon.set_pivot_point(0.5, 0.9);
        this._badge = label('', 'ar-badge');
        this._badge.hide();
        this._box.add_child(this._badge);
        this._box.add_child(this._icon);
        this.add_child(this._box);
        this.menu.box.add_style_class_name('ar-menu');

        const header = staticItem('ar-header');
        const head = new St.BoxLayout({vertical: true, x_expand: true});
        const titleRow = new St.BoxLayout({style_class: 'ar-title-row'});
        titleRow.add_child(new St.Icon({gicon, style_class: 'ar-title-icon'}));
        titleRow.add_child(label('Agent Reaper', 'ar-title', DIM));
        head.add_child(titleRow);
        this._figure = label('—', 'ar-figure');
        this._sub = label('Open to scan', 'ar-sub', DIM);
        head.add_child(this._figure);
        head.add_child(this._sub);
        header.add_child(head);
        this.menu.addMenuItem(header);

        this._autoSwitch = new PopupMenu.PopupSwitchMenuItem('Auto reap every 15 minutes', ext.auto);
        this._autoSwitch.add_style_class_name('ar-switch');
        this._autoSwitch.connect('toggled', (_item, state) => ext.setAuto(state));
        this.menu.addMenuItem(this._autoSwitch);

        this._list = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._list);

        this._reap = new PopupMenu.PopupBaseMenuItem({style_class: 'ar-reap'});
        this._reapText = label('Reap', 'ar-reap-text');
        this._reapText.x_expand = true;
        this._reapSize = label('', 'ar-reap-size');
        this._reap.add_child(this._reapText);
        this._reap.add_child(this._reapSize);
        this._reap.connect('activate', () => ext.clean());
        this._reap.setSensitive(false);
        this.menu.addMenuItem(this._reap);

        const foot = staticItem('ar-foot');
        this._foot = label('Scans every hour', 'ar-foot-text', FAINT);
        foot.add_child(this._foot);
        this.menu.addMenuItem(foot);
        this.setAuto(ext.auto);

        this._menuSignal = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                ext.check(false);
        });
    }

    destroy() {
        this.menu.disconnect(this._menuSignal);
        super.destroy();
    }

    reap() {
        return new Promise(resolve => {
            this._icon.ease({
                rotation_angle_z: -35,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._icon.ease({
                    rotation_angle_z: 0,
                    duration: 260,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                }),
            });
            if (!this._badge.visible) {
                resolve();
                return;
            }
            this._badge.ease({
                translation_x: -18,
                opacity: 0,
                duration: 320,
                delay: 90,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this._badge.hide();
                    this._badge.translation_x = 0;
                    this._badge.opacity = 255;
                    resolve();
                },
            });
        });
    }

    _setState(state, count) {
        for (const s of ['due', 'error', 'reaped'])
            this._box.remove_style_class_name(`ar-${s}`);
        if (state)
            this._box.add_style_class_name(`ar-${state}`);
        this._badge.text = String(count);
        this._badge.visible = count > 0;
    }

    _setFigure(text, style) {
        this._figure.text = text;
        for (const s of ['ar-figure-clear', 'ar-figure-error'])
            this._figure.remove_style_class_name(s);
        if (style)
            this._figure.add_style_class_name(style);
    }

    showBusy(text) {
        this._sub.text = text;
        this._reap.setSensitive(false);
    }

    showResult(result) {
        const rows = result.candidates;
        const mb = megabytes(rows);
        this._list.removeAll();
        if (rows.length) {
            this._setFigure(size(mb), null);
            const agents = new Set(rows.map(c => c.agent)).size;
            this._sub.text = `held by ${rows.length} leftover ${rows.length === 1 ? 'task' : 'tasks'} from ${agents} ${agents === 1 ? 'agent' : 'agents'}`;
            this._fillList(rows);
        } else {
            this._setFigure('All clear', 'ar-figure-clear');
            this._sub.text = 'No leftover agent tasks';
        }
        this._reapText.text = rows.length ? `Reap ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}` : 'Nothing to reap';
        this._reapSize.text = rows.length ? size(mb) : '';
        this._reap.setSensitive(rows.length > 0);
        this._lastScan = GLib.DateTime.new_now_local();
        this._refreshFoot();
        this._setState(rows.length ? 'due' : null, rows.length);
    }

    showSweep(result) {
        const c = result.cleanup;
        const killed = c ? c.killed : 0;
        const freed = c ? c.freed_rss + c.freed_swap : 0;
        this._list.removeAll();
        this._lastScan = GLib.DateTime.new_now_local();
        if (killed) {
            this._setFigure(`−${size(freed)}`, 'ar-figure-clear');
            this._sub.text = `Auto-reaped ${killed} ${killed === 1 ? 'task' : 'tasks'}`;
        } else {
            this._setFigure('All clear', 'ar-figure-clear');
            this._sub.text = 'Nothing to reap';
        }
        this._reapText.text = 'Nothing to reap';
        this._reapSize.text = '';
        this._reap.setSensitive(false);
        this._refreshFoot();
        this._setState(killed ? 'reaped' : null, killed);
    }

    setAuto(auto) {
        this._autoMode = auto;
        if (auto)
            this._box.add_style_class_name('ar-auto');
        else
            this._box.remove_style_class_name('ar-auto');
        if (this._autoSwitch.state !== auto)
            this._autoSwitch.setToggleState(auto);
        this._refreshFoot();
    }

    _refreshFoot() {
        if (this._autoMode) {
            this._foot.text = this._lastScan
                ? `Auto every 15 min  ·  next ${this._lastScan.add_seconds(AUTO_SECONDS).format('%H:%M')}`
                : 'Auto · clears every 15 min';
        } else {
            this._foot.text = this._lastScan
                ? `Scanned ${this._lastScan.format('%H:%M')}  ·  next ${this._lastScan.add_seconds(CHECK_SECONDS).format('%H:%M')}`
                : 'Scans every hour';
        }
    }

    _fillList(rows) {
        let shown = 0;
        for (const [agent, tasks] of groupByAgent(rows)) {
            if (shown >= MAX_ROWS)
                break;
            this._list.addMenuItem(this._groupHeader(agent, tasks));
            for (const c of tasks) {
                if (shown >= MAX_ROWS)
                    break;
                this._list.addMenuItem(this._row(c));
                shown++;
            }
        }
        if (rows.length > shown) {
            const more = staticItem('ar-more');
            more.add_child(label(`+ ${rows.length - shown} more, all reaped together`, 'ar-more-text', FAINT));
            this._list.addMenuItem(more);
        }
    }

    _groupHeader(agent, tasks) {
        const item = staticItem('ar-group');
        item.add_child(new St.Widget({
            style_class: `ar-dot ar-agent-${AGENT_STYLE[agent] ?? 'other'}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const name = label(agent, 'ar-group-name');
        name.x_expand = true;
        item.add_child(name);
        item.add_child(label(`${tasks.length}  ·  ${size(megabytes(tasks))}`, 'ar-group-meta', DIM));
        return item;
    }

    _row(c) {
        const item = staticItem('ar-row');
        item.add_child(new St.Widget({style_class: `ar-bar ar-bar-${reasonStyle(c.reason)}`, y_expand: true}));
        const body = new St.BoxLayout({vertical: true, x_expand: true});
        body.add_child(label(taskName(c.cmd), 'ar-name'));
        body.add_child(label(`${c.reason}  ·  ${age(c.age_h)} old`, 'ar-meta', DIM));
        item.add_child(body);
        item.add_child(label(size(c.rss + c.swap), 'ar-size', DIM));
        return item;
    }

    showError(message) {
        this._list.removeAll();
        this._setFigure('Scan failed', 'ar-figure-error');
        this._sub.text = message;
        this._reap.setSensitive(false);
        this._setState('error', 0);
    }
});

export default class AgentReaperExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
        this._gicon = Gio.icon_new_for_string(GLib.build_filenamev([this.path, 'icons', 'agent-reaper-symbolic.svg']));
        this._notified = new Set();
        this._busy = false;
        this._settings = this.getSettings();
        migrateMode(this._settings);
        this._auto = this._settings.get_boolean('auto-reap');
        this._settingsSignal = this._settings.connect('changed', (_settings, key) => {
            if (key === 'auto-reap')
                this.setAuto(_settings.get_boolean('auto-reap'));
        });
        this._first = this._timer = 0;
        this._indicator = new Indicator(this, this._gicon);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._schedule();
    }

    get auto() {
        return this._auto;
    }

    get minAge() {
        return this._settings.get_int('min-age-hours') * 3600;
    }

    setAuto(auto) {
        if (this._auto === auto)
            return;
        this._auto = auto;
        this._settings.set_boolean('auto-reap', auto);
        this._indicator?.setAuto(auto);
        this._schedule();
        if (auto)
            this.sweep();
        else
            this.check(false);
    }

    _schedule() {
        for (const id of ['_first', '_timer']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        if (this._auto) {
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, AUTO_SECONDS, () => {
                this.sweep();
                return GLib.SOURCE_CONTINUE;
            });
            return;
        }
        this._first = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, FIRST_CHECK_SECONDS, () => {
            this._first = 0;
            this.check(true);
            return GLib.SOURCE_REMOVE;
        });
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_SECONDS, () => {
            this.check(true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._first)
            GLib.source_remove(this._first);
        if (this._timer)
            GLib.source_remove(this._timer);
        this._first = this._timer = 0;
        this._auto = false;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings.disconnect(this._settingsSignal);
        this._settings = null;
        this._cancellable.cancel();
        this._cancellable = null;
        if (this._source) {
            this._source.disconnect(this._sourceSignal);
            this._source.destroy();
            this._source = null;
        }
        this._notified = null;
        this._gicon = null;
    }

    async sweep() {
        if (this._busy)
            return;
        this._busy = true;
        this._indicator?.showBusy('Auto reaping…');
        try {
            const result = await reapTasks(this._cancellable, this.minAge);
            if (!this._indicator)
                return;
            if (result.cleanup?.killed)
                await this._indicator.reap();
            this._indicator.showSweep(result);
        } catch (e) {
            this._indicator?.showError(e.message);
        } finally {
            this._busy = false;
        }
    }

    async check(notify) {
        if (this._busy)
            return;
        this._busy = true;
        this._indicator.showBusy('Scanning…');
        try {
            const {result} = await scan(this._cancellable, this.minAge);
            this._indicator?.showResult(result);
            if (notify && this._indicator)
                this._notifyNew(result.candidates);
        } catch (e) {
            this._indicator?.showError(e.message);
        } finally {
            this._busy = false;
        }
    }

    async clean() {
        if (this._busy)
            return;
        this._busy = true;
        this._indicator.showBusy('Reaping…');
        try {
            const c = (await reapTasks(this._cancellable, this.minAge)).cleanup;
            if (!this._indicator)
                return;
            await this._indicator.reap();
            if (!this._auto) {
                this._notify(c ? `Reaped ${c.killed} of ${c.attempted} processes` : 'Nothing to reap',
                    c ? `Freed ${size(c.freed_rss + c.freed_swap)}. Log: ~/.local/state/agent-reaper.log` : '');
            }
        } catch (e) {
            this._indicator?.showError(e.message);
            return;
        } finally {
            this._busy = false;
        }
        this.check(false);
    }

    _notifyNew(rows) {
        const fresh = rows.filter(c => !this._notified.has(c.key));
        this._notified = new Set(rows.map(c => c.key));
        if (!fresh.length)
            return;
        this._notify(`${size(megabytes(rows))} held by leftover agent tasks`,
            `${fresh.length} new, ${rows.length} in total. Open Agent Reaper to review.`,
            {label: 'Reap now', callback: () => this.clean()});
    }

    _notify(title, body, action) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Agent Reaper', icon: this._gicon});
            this._sourceSignal = this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({source: this._source, title, body});
        if (action)
            notification.addAction(action.label, action.callback);
        this._source.addNotification(notification);
    }
}
