import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {HermesClient} from './api.js';

export default class HermesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Connection',
            description: 'Hermes API server (gateway api_server platform). Local default is http://127.0.0.1:8642; ' +
                'for a remote machine use its tailnet address, e.g. https://my-pi.tailnet.ts.net.',
        });

        const url = new Adw.EntryRow({title: 'Server URL'});
        const key = new Adw.PasswordEntryRow({title: 'API key (API_SERVER_KEY)'});
        settings.bind('server-url', url, 'text', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('api-key', key, 'text', Gio.SettingsBindFlags.DEFAULT);

        const test = new Adw.ActionRow({title: 'Test connection'});
        const btn = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        const client = new HermesClient(settings);
        btn.connect('clicked', async () => {
            test.subtitle = 'Connecting…';
            try {
                await client.check();
                test.subtitle = '✓ Connected';
            } catch (e) {
                test.subtitle = `✗ ${e.message}`;
            }
        });
        window.connect('close-request', () => client.destroy());
        test.add_suffix(btn);

        group.add(url);
        group.add(key);
        group.add(test);
        page.add(group);
        window.add(page);
    }
}
