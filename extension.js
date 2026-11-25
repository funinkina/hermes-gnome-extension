import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {HermesClient} from './api.js';
import {escape, parse} from './markdown.js';

const VERTICAL = Clutter.Orientation.VERTICAL;
const {START, CENTER, END} = Clutter.ActorAlign;
const POLL_SECONDS = 60;
const SHOT_MAX_PX = 1600;

const TOOL_ICONS = [
    [/terminal|shell|exec|bash|command|process/, 'utilities-terminal-symbolic'],
    [/browser|web|fetch|http|url|crawl/, 'web-browser-symbolic'],
    [/search|find|grep/, 'system-search-symbolic'],
    [/file|read|write|patch|edit|dir/, 'text-x-generic-symbolic'],
    [/image|vision|screenshot/, 'image-x-generic-symbolic'],
    [/memory|recall|remember/, 'document-open-recent-symbolic'],
    [/calendar|cron|schedule/, 'x-office-calendar-symbolic'],
    [/mail|gmail|message|telegram|send/, 'mail-unread-symbolic'],
];
const toolIcon = name => TOOL_ICONS.find(([re]) => re.test(name))?.[1] ?? 'emblem-system-symbolic';

function label(text, {markup = false, style_class = ''} = {}) {
    const l = new St.Label({style_class, x_expand: true, reactive: true});
    const ct = l.clutter_text;
    ct.line_wrap = true;
    ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    ct.ellipsize = Pango.EllipsizeMode.NONE;
    ct.selectable = true;
    if (markup) {
        try {
            Pango.parse_markup(text, -1, '');
            ct.set_markup(text);
            return l;
        } catch {
            text = text.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        }
    }
    ct.set_text(text);
    return l;
}

function iconButton(icon, name, onClick, style_class = 'hermes-icon-button') {
    const b = new St.Button({style_class, can_focus: true, accessible_name: name, child: new St.Icon({icon_name: icon})});
    b.connect('clicked', onClick);
    return b;
}

// Three dots that wave while animate(true).
function waveDots(style_class) {
    const box = new St.BoxLayout({style_class, y_align: CENTER});
    const dots = [0, 1, 2].map(() => new St.Widget({style_class: 'hermes-dot', y_align: CENTER}));
    dots.forEach(d => box.add_child(d));
    box.animate = on => dots.forEach((d, i) => {
        d.remove_all_transitions();
        d.translation_y = 0;
        if (on) {
            d.ease({
                translation_y: -3, duration: 320, delay: i * 140, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                autoReverse: true, repeatCount: -1,
            });
        }
    });
    return box;
}

function pulse(actor, on) {
    actor.remove_all_transitions();
    actor.opacity = 255;
    if (on)
        actor.ease({opacity: 70, duration: 750, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, autoReverse: true, repeatCount: -1});
}

const thumbnail = (bytes, size) => new St.Icon({gicon: Gio.BytesIcon.new(bytes), icon_size: size, style_class: 'hermes-thumb'});

function dataUrlBytes(url) {
    const m = /^data:image\/[\w+.-]+;base64,(.*)$/s.exec(typeof url === 'string' ? url : '');
    return m ? new GLib.Bytes(GLib.base64_decode(m[1])) : null;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Hermes');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._client = new HermesClient(this._settings);
        this._loaded = false;
        this._gen = 0; // bumped when the transcript changes under an in-flight history load
        this._sources = new Set();
        this._run = null; // {cancellable, runId}
        this._online = null;
        this._unread = false;
        this._attachment = null; // {bytes, url}
        this._transient = new Set(); // error bubbles that vanish once the connection recovers

        this._buildPanel(ext);
        this._buildPopup();

        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._unread = false;
            this._syncPanel();
            this._checkConnection();
            if (!this._loaded)
                this._loadHistory();
            this._later(0, () => {
                this._entry.grab_key_focus();
                this._scrollToEnd(true);
            });
        });

        this._checkConnection();
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._checkConnection();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildPanel(ext) {
        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        const iconWrap = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: CENTER});
        iconWrap.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/hermes-symbolic.svg`),
            style_class: 'system-status-icon',
        }));
        this._badge = new St.Widget({style_class: 'hermes-badge', x_expand: true, y_expand: true, x_align: END, y_align: END, visible: false});
        iconWrap.add_child(this._badge);
        this._panelDots = waveDots('hermes-panel-dots');
        this._panelDots.visible = false;
        box.add_child(iconWrap);
        box.add_child(this._panelDots);
        this.add_child(box);
    }

    _buildPopup() {
        // Added straight to the menu box: a non-reactive PopupBaseMenuItem renders :insensitive (dimmed).
        const root = new St.BoxLayout({orientation: VERTICAL, style_class: 'hermes-root', x_expand: true});
        this.menu.box.add_child(root);

        const header = new St.BoxLayout({style_class: 'hermes-header'});
        this._conn = new St.Label({style_class: 'hermes-conn', y_align: CENTER, x_expand: true});
        header.add_child(this._conn);
        header.add_child(iconButton('list-add-symbolic', 'New chat', () => this._newChat()));
        header.add_child(iconButton('emblem-system-symbolic', 'Settings', () => {
            this.menu.close();
            this._ext.openPreferences();
        }));
        root.add_child(header);

        this._list = new St.BoxLayout({orientation: VERTICAL, style_class: 'hermes-list', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'hermes-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._list,
        });
        root.add_child(this._scroll);

        this._attachRow = new St.BoxLayout({style_class: 'hermes-attach-row', visible: false});
        root.add_child(this._attachRow);

        const input = new St.BoxLayout({style_class: 'hermes-input'});
        input.add_child(iconButton('camera-photo-symbolic', 'Attach screenshot', () => this._attachScreenshot(), 'hermes-round-button hermes-shot'));
        this._entry = new St.Entry({hint_text: 'Message Hermes…', can_focus: true, x_expand: true, y_align: CENTER, style_class: 'hermes-entry'});
        this._entry.clutter_text.connect('activate', () => this._send());
        input.add_child(this._entry);
        this._sendBtn = iconButton('go-up-symbolic', 'Send', () => (this._run ? this._stop() : this._send()), 'hermes-round-button hermes-send');
        input.add_child(this._sendBtn);
        root.add_child(input);
        this._syncConn();
    }

    destroy() {
        this._destroyed = true;
        const run = this._run;
        this._run = null; // stops buffered SSE frames from reaching destroyed actors
        run?.cancellable.cancel();
        GLib.source_remove(this._pollId);
        if (this._renderId)
            GLib.source_remove(this._renderId);
        this._sources.forEach(id => GLib.source_remove(id));
        this._client.destroy();
        super.destroy();
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
    }

    // ---- status ----

    async _checkConnection() {
        try {
            await this._client.check();
            this._online = true;
            if (!this._destroyed && this._transient.size) {
                this._transient.forEach(b => b.destroy());
                this._transient.clear();
                if (!this._list.get_n_children())
                    this._empty();
            }
            if (!this._destroyed && !this._loaded)
                this._loadHistory();
        } catch (e) {
            this._online = false;
            this._connError = e.status === 401 ? 'Bad API key' : 'Offline';
        }
        if (!this._destroyed) {
            this._syncConn();
            this._syncPanel();
        }
    }

    _syncConn() {
        const [color, text] = {true: ['#57e389', 'Connected'], false: ['#f66151', this._connError]}[this._online] ?? ['#9a9996', 'Connecting…'];
        this._conn.clutter_text.set_markup(
            `<span foreground="${color}">●</span>  <b>Hermes</b>  <span foreground="#c0bfbc">${escape(text)}</span>`);
    }

    _syncPanel() {
        const busy = !!this._run;
        if (this._panelDots.visible !== busy) {
            this._panelDots.visible = busy;
            this._panelDots.animate(busy);
        }
        const state = this._unread ? 'unread' : busy ? null : {true: 'ok', false: 'err'}[this._online] ?? null;
        if (state === this._badgeState)
            return;
        this._badgeState = state;
        this._badge.visible = !!state;
        this._badge.style_class = state ? `hermes-badge hermes-badge-${state}` : 'hermes-badge';
        pulse(this._badge, state === 'unread');
    }

    // ---- history ----

    async _loadHistory() {
        this._loaded = true;
        const gen = this._gen;
        const id = this._settings.get_string('session-id');
        if (!id)
            return this._empty();
        try {
            const msgs = await this._client.history(id);
            if (this._destroyed || gen !== this._gen)
                return;
            let tools = [];
            for (const m of msgs) {
                if (m.role === 'user') {
                    tools = [];
                    const parts = Array.isArray(m.content) ? m.content : [{type: 'text', text: m.content ?? ''}];
                    const text = parts.filter(p => p?.type === 'text').map(p => p.text).join('\n');
                    const img = parts.map(p => dataUrlBytes(p?.image_url?.url ?? p?.image_url)).find(Boolean);
                    if (text.trim() || img)
                        this._userBubble(text, img);
                } else if (m.role === 'assistant') {
                    for (const tc of m.tool_calls ?? [])
                        tools.push(tc.function?.name ?? tc.name ?? 'tool');
                    if (typeof m.content === 'string' && m.content.trim()) {
                        const b = this._assistantBubble();
                        tools.forEach(t => b.chip(t).finish(true));
                        tools = [];
                        b.set(m.content);
                    }
                }
            }
            if (!this._list.get_n_children())
                this._empty();
            this._scrollToEnd(true);
        } catch (e) {
            if (this._destroyed || gen !== this._gen)
                return;
            if (e.status === 404)
                this._settings.set_string('session-id', '');
            else
                this._loaded = false; // retry next open
            this._error(`Couldn't load history: ${e.message}`, true);
        }
    }

    _empty() {
        this._list.add_child(label('Ask Hermes anything.', {style_class: 'hermes-empty'}));
        this._placeholder = true;
    }

    _newChat() {
        this._gen++;
        const run = this._run;
        if (run) {
            this._detach();
            run.cancellable.cancel(); // dropping the stream interrupts the agent server-side
        }
        this._settings.set_string('session-id', '');
        this._setAttachment(null);
        this._list.destroy_all_children();
        this._empty();
        this._entry.grab_key_focus();
    }

    // ---- bubbles ----

    _add(actor) {
        if (this._placeholder) {
            this._list.destroy_all_children();
            this._placeholder = false;
        }
        this._list.add_child(actor);
        return actor;
    }

    _userBubble(text, imageBytes = null) {
        // A horizontal row asks the bubble for its height at the width it actually gets; a bare
        // x_align:END child in the vertical list is measured at full list width and overflows when wrapped.
        const row = this._add(new St.BoxLayout({x_expand: true}));
        row.add_child(new St.Widget({x_expand: true}));
        const box = new St.BoxLayout({orientation: VERTICAL, style_class: 'hermes-msg hermes-user'});
        row.add_child(box);
        if (imageBytes)
            box.add_child(thumbnail(imageBytes, 120));
        if (text)
            box.add_child(label(text));
    }

    _assistantBubble() {
        const row = this._add(new St.BoxLayout({x_expand: true}));
        const box = new St.BoxLayout({orientation: VERTICAL, style_class: 'hermes-msg hermes-assistant'});
        row.add_child(box);
        row.add_child(new St.Widget({x_expand: true})); // same height-for-width trick as _userBubble
        const chips = new St.BoxLayout({orientation: VERTICAL, style_class: 'hermes-chips', x_expand: true, visible: false});
        const content = new St.BoxLayout({orientation: VERTICAL, style_class: 'hermes-content', x_expand: true});
        box.add_child(chips);
        box.add_child(content);
        let typing = null;
        const running = () => chips.get_children().filter(c => c.tool);
        return {
            box: row,
            empty: () => !chips.get_n_children() && !content.get_children().some(k => k._md),
            typing: on => {
                if (on && !typing) {
                    typing = waveDots('hermes-typing');
                    content.add_child(typing);
                    typing.animate(true);
                } else if (!on && typing) {
                    typing.animate(false);
                    typing.destroy();
                    typing = null;
                }
            },
            chip: (name, preview) => {
                const chip = new St.BoxLayout({style_class: 'hermes-chip hermes-chip-running', x_align: START});
                chip.add_child(new St.Icon({icon_name: toolIcon(name), style_class: 'hermes-chip-icon', y_align: CENTER}));
                const detail = preview ? ` · ${String(preview).replace(/\s+/g, ' ')}` : '';
                const text = `${name}${detail}`;
                chip.add_child(new St.Label({text: text.length > 48 ? `${text.slice(0, 47)}…` : text, y_align: CENTER}));
                chips.add_child(chip);
                chips.visible = true;
                pulse(chip, true);
                chip.tool = name;
                chip.finish = ok => {
                    pulse(chip, false);
                    chip.style_class = `hermes-chip ${ok ? 'hermes-chip-done' : 'hermes-chip-failed'}`;
                    chip.tool = null;
                };
                return chip;
            },
            finishTool: (name, ok) => (running().find(c => c.tool === name) ?? running()[0])?.finish(ok),
            finishAll: () => running().forEach(c => c.finish(true)),
            set: text => {
                if (typing && text.trim()) {
                    typing.animate(false);
                    typing.destroy();
                    typing = null;
                }
                const blocks = parse(text), kids = content.get_children().filter(k => k !== typing);
                blocks.forEach((b, i) => {
                    const k = kids[i];
                    if (k?._md && JSON.stringify(k._md) === JSON.stringify(b))
                        return;
                    const w = b.type === 'code' ? this._codeBlock(b) : label(b.markup, {markup: true});
                    w._md = b;
                    if (k) {
                        content.replace_child(k, w);
                        k.destroy();
                    } else {
                        content.add_child(w);
                    }
                });
                kids.slice(blocks.length).forEach(k => k.destroy());
            },
        };
    }

    _codeBlock({lang, text}) {
        const box = new St.BoxLayout({orientation: VERTICAL, style_class: 'hermes-code', x_expand: true});
        const bar = new St.BoxLayout();
        bar.add_child(new St.Label({text: lang || 'code', style_class: 'hermes-code-lang', x_expand: true, y_align: CENTER}));
        bar.add_child(iconButton('edit-copy-symbolic', 'Copy', () =>
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text), 'hermes-icon-button hermes-copy'));
        box.add_child(bar);
        box.add_child(label(text, {style_class: 'hermes-code-text'}));
        return box;
    }

    _error(text, transient = false) {
        const box = this._add(new St.BoxLayout({orientation: VERTICAL, style_class: 'hermes-msg hermes-error', x_expand: true}));
        box.add_child(label(text));
        if (transient) {
            this._transient.add(box);
            box.connect('destroy', () => this._transient.delete(box));
        }
        this._scrollToEnd(true);
    }

    _scrollToEnd(force = false) {
        const adj = this._scroll.vadjustment;
        if (!force && adj.value < adj.upper - adj.page_size - 40)
            return;
        this._later(0, () => (adj.value = adj.upper - adj.page_size));
    }

    // ---- screenshot ----

    async _attachScreenshot() {
        const gen = this._gen;
        this.menu.close();
        await new Promise(r => this._later(350, r)); // let the menu fade out of the frame
        try {
            const {x = 0, y = 0, width = global.stage.width, height = global.stage.height} = Main.layoutManager.primaryMonitor ?? {};
            if (width < 1 || height < 1)
                throw new Error('no monitor to capture');
            const out = Gio.MemoryOutputStream.new_resizable();
            const shooter = new Shell.Screenshot();
            await new Promise((resolve, reject) => shooter.screenshot_area(x, y, width, height, out, (s, res) => {
                try {
                    s.screenshot_area_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }));
            out.close(null);
            let pix = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(out.steal_as_bytes()), null);
            const scale = Math.min(1, SHOT_MAX_PX / Math.max(pix.width, pix.height));
            if (scale < 1)
                pix = pix.scale_simple(Math.round(pix.width * scale), Math.round(pix.height * scale), GdkPixbuf.InterpType.BILINEAR);
            const [, buf] = pix.save_to_bufferv('jpeg', ['quality'], ['85']);
            if (this._destroyed || gen !== this._gen)
                return;
            this._setAttachment({bytes: new GLib.Bytes(buf), url: `data:image/jpeg;base64,${GLib.base64_encode(buf)}`});
        } catch (e) {
            if (this._destroyed)
                return;
            this._error(`Screenshot failed: ${e.message}`);
        }
        this.menu.open();
    }

    _setAttachment(att) {
        this._attachment = att;
        this._attachRow.destroy_all_children();
        this._attachRow.visible = !!att;
        if (!att)
            return;
        this._attachRow.add_child(thumbnail(att.bytes, 44));
        this._attachRow.add_child(new St.Label({text: 'Screenshot attached', style_class: 'hermes-attach-label', y_align: CENTER, x_expand: true}));
        this._attachRow.add_child(iconButton('window-close-symbolic', 'Remove screenshot', () => this._setAttachment(null)));
    }

    // ---- chat ----

    async _send() {
        const text = this._entry.get_text().trim();
        const att = this._attachment;
        if ((!text && !att) || this._run)
            return;
        this._entry.set_text('');
        this._setAttachment(null);
        this._gen++;
        this._userBubble(text, att?.bytes);
        const message = att
            ? [{type: 'text', text: text || 'What do you see in this screenshot?'}, {type: 'image_url', image_url: {url: att.url}}]
            : text;

        const reply = this._assistantBubble();
        reply.typing(true);
        const run = this._run = {cancellable: new Gio.Cancellable(), runId: null};
        this._sendBtn.child.icon_name = 'media-playback-stop-symbolic';
        this._syncPanel();
        this._scrollToEnd(true);

        let acc = '';
        const render = () => {
            if (this._run !== run)
                return;
            reply.set(acc);
            this._scrollToEnd();
        };

        try {
            let id = this._settings.get_string('session-id');
            if (!id) {
                id = await this._client.createSession(run.cancellable);
                if (this._run !== run)
                    return;
                this._settings.set_string('session-id', id);
            }
            await this._client.chat(id, message, (ev, d) => {
                if (this._run !== run)
                    return;
                run.runId ??= d.run_id;
                switch (ev) {
                case 'assistant.delta':
                    acc += d.delta ?? '';
                    this._renderId ||= GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                        this._renderId = 0;
                        render();
                        return GLib.SOURCE_REMOVE;
                    });
                    break;
                case 'tool.started':
                    reply.chip(d.tool_name ?? 'tool', d.preview);
                    this._scrollToEnd();
                    break;
                case 'tool.completed':
                case 'tool.failed':
                    reply.finishTool(d.tool_name ?? 'tool', ev === 'tool.completed');
                    break;
                case 'approval.request':
                    this._approval(run, d);
                    break;
                case 'assistant.completed':
                    if (d.content)
                        acc = d.content;
                    if (d.session_id && d.session_id !== id)
                        this._settings.set_string('session-id', d.session_id);
                    break;
                case 'run.failed':
                case 'error':
                    this._error(d.message ?? d.error ?? 'Run failed');
                    break;
                }
            }, run.cancellable);
        } catch (e) {
            if (!this._destroyed && this._run === run && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._error(e.message);
        } finally {
            if (!this._destroyed && this._run === run) {
                if (acc)
                    render();
                reply.typing(false);
                reply.finishAll();
                if (reply.empty())
                    reply.box.destroy();
                this._unread = !this.menu.isOpen;
                this._detach();
            }
        }
    }

    _detach() {
        if (this._renderId) {
            GLib.source_remove(this._renderId);
            this._renderId = 0;
        }
        this._run = null;
        this._sendBtn.child.icon_name = 'go-up-symbolic';
        this._syncPanel();
    }

    async _stop() {
        const run = this._run;
        if (!run)
            return;
        try {
            if (run.runId)
                await this._client.stop(run.runId);
        } catch {}
        run.cancellable.cancel(); // also covers a stream that never closes; disconnect interrupts server-side
    }

    _approval(run, d) {
        const box = this._add(new St.BoxLayout({orientation: VERTICAL, style_class: 'hermes-msg hermes-approval', x_expand: true}));
        const what = d.description || d.command || 'Hermes wants to run a command.';
        box.add_child(label(`<b>Approval needed</b>\n${escape(what)}${d.command && d.description ? `\n<tt>${escape(d.command)}</tt>` : ''}`, {markup: true}));
        const row = new St.BoxLayout({style_class: 'hermes-approval-buttons'});
        for (const choice of d.choices?.length ? d.choices : ['once', 'deny']) {
            const b = new St.Button({label: {once: 'Allow once', session: 'Allow for session', always: 'Always', deny: 'Deny'}[choice] ?? choice, style_class: 'button hermes-approval-button', can_focus: true});
            b.connect('clicked', async () => {
                row.reactive = false;
                try {
                    await this._client.approve(d.run_id ?? run.runId, choice, d.request_id);
                    box.destroy();
                } catch (e) {
                    row.reactive = true;
                    this._error(`Approval failed: ${e.message}`);
                }
            });
            row.add_child(b);
        }
        box.add_child(row);
        this._scrollToEnd(true);
        if (!this.menu.isOpen) {
            this._unread = true;
            this._syncPanel();
        }
    }
});

export default class HermesExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
