// Dev only (see dev/shot.sh): fills the Hermes popup with a fixed conversation and screenshots it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const OUT = GLib.getenv('HERMES_SHOT') ?? '/tmp/hermes-shot.png';
const log = m => console.log(`HSELF ${m}`);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => r() ?? GLib.SOURCE_REMOVE));
let shooter;

async function shot() {
    const out = Gio.File.new_for_path(OUT).replace(null, false, Gio.FileCreateFlags.NONE, null);
    shooter = new Shell.Screenshot();
    await new Promise((res, rej) => shooter.screenshot(false, out, (s, r) => {
        try {
            s.screenshot_finish(r);
            res();
        } catch (e) {
            rej(e);
        }
    }));
    out.close(null);
}

export default class {
    enable() {
        (async () => {
            await sleep(2500);
            const ind = Main.panel.statusArea['hermes@funinkina.com'];
            ind._newChat();
            if (GLib.getenv('HERMES_FIXTURE') === 'readme') {
                ind._userBubble('what\'s on my calendar today?');
                const r = ind._assistantBubble();
                r.chip('calendar', 'list events · today').finish(true);
                r.set('Two things today:\n- **10:00** Design review with the platform team\n- **16:30** Dentist (leave by 16:00)\n\nNothing else until Friday.');
                ind._userBubble('check disk usage on the pi');
                const d = ind._assistantBubble();
                d.chip('terminal', 'df -h /').finish(true);
                d.set('Root is at **41%** (12G of 29G). Plenty of room.\n```bash\ndf -h /\n```');
                ind._syncPanel();
                ind.menu.open();
                await sleep(1500);
                await shot();
                log(`shot ${OUT}`);
                return;
            }
            ind._error('Couldn\'t load history: Error resolving "example.ts.net": Name or service not known', true);
            ind._error('This error is not transient and must stay.');
            ind._userBubble('hi');
            // lengths straddling the 340px cap vs full-width measurement that used to overflow
            for (const n of [38, 44, 50, 56, 62])
                ind._userBubble('Use your terminal tool to run date, then reply in one short line.'.slice(0, n));
            const a = ind._assistantBubble();
            a.chip('terminal', 'date').finish(true);
            a.chip('web_search', 'gnome shell 51 release notes');
            a.chip('read_file', '~/.hermes/config.yaml').finish(false);
            a.set('## Done\nIt\'s **Wed 25 Nov**, 2:01 am IST. Here is a longer paragraph so that the text has to wrap across several lines inside the bubble.\n- one `inline`\n- two\n```bash\ndate -u\n```');
            const t = ind._assistantBubble();
            t.typing(true);
            ind._syncPanel();
            ind.menu.open();
            await sleep(1200);
            if (GLib.getenv('HERMES_SCROLL') === 'end')
                ind._scrollToEnd(true);
            await sleep(400);
            await shot();
            log(`transient before=${ind._transient.size}`);
            ind._loaded = true; // keep the fixture; we only want the error-clearing path
            await ind._checkConnection();
            log(`transient after reconnect=${ind._transient.size} online=${ind._online}`);
            log(`shot ${OUT}`);
        })().catch(e => log(`ERR ${e}\n${e.stack}`));
    }

    disable() {}
}
