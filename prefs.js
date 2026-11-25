import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AgentReaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 420);

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const reaping = new Adw.PreferencesGroup({
            title: 'Reaping',
            description: 'The menu in the top bar keeps working and shows the same options.',
        });
        page.add(reaping);

        const auto = new Adw.SwitchRow({
            title: 'Auto reap',
            subtitle: 'Reap every 15 minutes without asking and report the result on the icon.',
        });
        settings.bind('auto-reap', auto, 'active', Gio.SettingsBindFlags.DEFAULT);
        reaping.add(auto);

        const leftovers = new Adw.PreferencesGroup({title: 'What counts as leftover'});
        page.add(leftovers);

        const minAge = new Adw.SpinRow({
            title: 'Minimum age',
            subtitle: 'Ignore tasks younger than this many hours.',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 24,
                step_increment: 1,
                page_increment: 4,
            }),
        });
        settings.bind('min-age-hours', minAge, 'value', Gio.SettingsBindFlags.DEFAULT);
        leftovers.add(minAge);
    }
}
