// Minimal client for the Hermes Agent API server (gateway/platforms/api_server.py).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

// Hermes tells the model "assume plain text" for api_server; this client renders markdown.
const SYSTEM = 'This client renders GitHub-flavored Markdown (headings, lists, emphasis, inline code, ' +
    'fenced code blocks). Use Markdown where it helps readability.';

const enc = new TextEncoder();
const dec = new TextDecoder();
const seg = encodeURIComponent;

export class HermesClient {
    constructor(settings) {
        this._settings = settings;
        this._http = new Soup.Session({timeout: 20});
        // ponytail: no read timeout — the server sends no SSE keepalives during long tool runs. Stop cancels.
        this._sse = new Soup.Session({timeout: 0});
    }

    destroy() {
        this._http.abort();
        this._sse.abort();
    }

    _message(method, path, body) {
        const base = this._settings.get_string('server-url').trim().replace(/\/+$/, '');
        let msg = null;
        try {
            msg = Soup.Message.new(method, base + path);
        } catch {}
        if (!msg)
            throw new Error(`Invalid server URL: "${base}"`);
        const key = this._settings.get_string('api-key').trim();
        if (key)
            msg.request_headers.append('Authorization', `Bearer ${key}`);
        if (body)
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(enc.encode(JSON.stringify(body))));
        return msg;
    }

    static _fail(msg, text) {
        let detail = null;
        try {
            const j = JSON.parse(text);
            detail = [j?.error?.message, j?.error, j?.message].find(v => typeof v === 'string');
        } catch {}
        const err = new Error(detail || `HTTP ${msg.status_code} ${msg.reason_phrase ?? ''}`.trim());
        err.status = msg.status_code;
        return err;
    }

    async request(method, path, body = null, cancellable = null) {
        const msg = this._message(method, path, body);
        const bytes = await this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        const text = dec.decode(bytes.get_data() ?? new Uint8Array());
        if (msg.status_code < 200 || msg.status_code >= 300)
            throw HermesClient._fail(msg, text);
        return text ? JSON.parse(text) : null;
    }

    // Resolves when the stream ends; onEvent(name, data) per SSE frame.
    async stream(path, body, onEvent, cancellable) {
        const msg = this._message('POST', path, body);
        const input = await this._sse.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        const lines = new Gio.DataInputStream({base_stream: input, close_base_stream: true});
        const next = async () => {
            const [line] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
            return line === null ? null : dec.decode(line).replace(/\r$/, '');
        };
        try {
            if (msg.status_code < 200 || msg.status_code >= 300) {
                const out = [];
                for (let l; (l = await next()) !== null;)
                    out.push(l);
                throw HermesClient._fail(msg, out.join('\n'));
            }
            let event = 'message', data = [];
            for (let l; (l = await next()) !== null;) {
                if (l === '') {
                    if (data.length) {
                        let parsed;
                        try {
                            parsed = JSON.parse(data.join('\n'));
                        } catch {
                            parsed = {text: data.join('\n')};
                        }
                        onEvent(event, parsed);
                    }
                    event = 'message';
                    data = [];
                } else if (l.startsWith('event:')) {
                    event = l.slice(6).trim();
                } else if (l.startsWith('data:')) {
                    data.push(l.slice(5).replace(/^ /, ''));
                }
            }
        } finally {
            lines.close(null);
        }
    }

    check(c) {
        return this.request('GET', '/v1/models', null, c);
    }

    async createSession(cancellable = null) {
        const r = await this.request('POST', '/api/sessions', {}, cancellable);
        return r.session?.id ?? r.id;
    }

    async history(id, c) {
        const r = await this.request('GET', `/api/sessions/${seg(id)}/messages?order=latest&limit=100`, null, c);
        return r.data ?? [];
    }

    chat(id, message, onEvent, c) {
        return this.stream(`/api/sessions/${seg(id)}/chat/stream`, {message, system_message: SYSTEM}, onEvent, c);
    }

    approve(runId, choice, requestId) {
        const body = {choice};
        if (requestId)
            body.request_id = requestId;
        return this.request('POST', `/v1/runs/${seg(runId)}/approval`, body);
    }

    stop(runId) {
        return this.request('POST', `/v1/runs/${seg(runId)}/stop`, {});
    }
}
