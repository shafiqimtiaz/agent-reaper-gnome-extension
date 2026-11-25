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

const CHECK_SECONDS = 3600;
const FIRST_CHECK_SECONDS = 60;
const ICON = 'edit-clear-all-symbolic';

function runReaper(script, args) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(['python3', script, '--json', ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (!p.get_successful())
                    throw new Error(stderr.trim() || `agent-reaper exited with ${p.get_exit_status()}`);
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(e);
            }
        });
    });
}

const megabytes = rows => rows.reduce((sum, c) => sum + c.rss + c.swap, 0);

function label(c) {
    const [first, ...rest] = c.cmd.split(' ');
    const name = [first.split('/').pop(), ...rest].join(' ');
    const short = name.length > 45 ? `${name.slice(0, 44)}…` : name;
    return `${short}  ·  ${c.age_h}h  ·  ${c.rss + c.swap} MB\n${c.reason}`;
}

function infoItem(text) {
    return new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Agent Reaper');
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({icon_name: ICON, style_class: 'system-status-icon'});
        this._count = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'agent-reaper-count'});
        this._box.add_child(this._icon);
        this._box.add_child(this._count);
        this.add_child(this._box);

        this._list = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._list);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._clean = this.menu.addAction('Clean now', () => ext.clean());
        this._clean.setSensitive(false);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                ext.check(false);
        });
    }

    _setState(state, count) {
        this._box.remove_style_class_name('agent-reaper-due');
        this._box.remove_style_class_name('agent-reaper-error');
        if (state)
            this._box.add_style_class_name(`agent-reaper-${state}`);
        this._icon.icon_name = state === 'error' ? 'dialog-warning-symbolic' : ICON;
        this._count.text = count ? String(count) : '';
    }

    showBusy(text) {
        this._list.removeAll();
        this._list.addMenuItem(infoItem(text));
        this._clean.setSensitive(false);
    }

    showResult(result) {
        const rows = result.candidates;
        this._list.removeAll();
        this._list.addMenuItem(infoItem(rows.length
            ? `${rows.length} stale processes  ·  ${megabytes(rows)} MB`
            : 'Nothing to clean'));
        for (const c of rows)
            this._list.addMenuItem(infoItem(label(c)));
        this._clean.setSensitive(rows.length > 0);
        this._setState(rows.length ? 'due' : null, rows.length);
    }

    showError(message) {
        this._list.removeAll();
        this._list.addMenuItem(infoItem(`Error: ${message}`));
        this._clean.setSensitive(false);
        this._setState('error', 0);
    }
});

export default class AgentReaperExtension extends Extension {
    enable() {
        this._script = GLib.build_filenamev([this.path, 'agent-reaper.py']);
        this._notified = new Set();
        this._busy = false;
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
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
        GLib.source_remove(this._timer);
        this._first = this._timer = 0;
        this._indicator?.destroy();
        this._indicator = null;
        this._source?.destroy();
        this._source = null;
        this._notified = null;
    }

    async check(notify) {
        if (this._busy)
            return;
        this._busy = true;
        this._indicator.showBusy('Checking…');
        try {
            const result = await runReaper(this._script, []);
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
        this._indicator.showBusy('Cleaning…');
        try {
            const c = (await runReaper(this._script, ['--apply'])).cleanup;
            if (!this._indicator)
                return;
            this._notify('Agent Reaper', c
                ? `Killed ${c.killed} of ${c.attempted} processes, freed ${c.freed_rss + c.freed_swap} MB`
                : 'Nothing to clean');
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
        this._notify('Agent Reaper: cleanup due',
            `${fresh.length} new stale processes (${megabytes(fresh)} MB). ${rows.length} stale in total.`,
            {label: 'Clean', callback: () => this.clean()});
    }

    _notify(title, body, action) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Agent Reaper', iconName: ICON});
            this._source.connect('destroy', () => {
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
