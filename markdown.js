// Markdown -> blocks of Pango markup. Pure JS (no gi imports) so it runs under plain gjs/node for tests.
// Returns [{type: 'text', markup}, {type: 'code', lang, text}]. Only paired delimiters are converted,
// so half-streamed input never produces unbalanced markup.

export const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function inline(src) {
    const slots = [];
    const stash = m => `\u0000${slots.push(m) - 1}\u0000`;
    let s = escape(src)
        .replace(/`([^`]+)`/g, (_, c) => stash(`<tt>${c}</tt>`))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t) => stash(`<span underline="single" foreground="#78aeed">${t}</span>`))
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<b>${a ?? b}</b>`)
        .replace(/(^|[^*\w])\*(?!\s)([^*<>]+?)\*(?!\w)/g, '$1<i>$2</i>')
        .replace(/(^|\W)_(?!\s)([^_<>]+?)_(?!\w)/g, '$1<i>$2</i>')
        .replace(/~~([^<>]+?)~~/g, '<s>$1</s>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
}

const HEADING = ['xx-large', 'x-large', 'large', 'medium', 'medium', 'medium'];

function line(l) {
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/)))
        return `<span size="${HEADING[m[1].length - 1]}" weight="bold">${inline(m[2])}</span>`;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l))
        return '<span alpha="50%">────────────────────</span>';
    if ((m = l.match(/^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/))) {
        const box = m[2] === undefined ? '•' : m[2] === ' ' ? '☐' : '☑';
        return `${'  '.repeat(Math.floor(m[1].length / 2) + 1)}${box} ${inline(m[3])}`;
    }
    if ((m = l.match(/^(\s*)(\d+[.)])\s+(.*)$/)))
        return `${'  '.repeat(Math.floor(m[1].length / 2) + 1)}${m[2]} ${inline(m[3])}`;
    if ((m = l.match(/^>\s?(.*)$/)))
        return `<span alpha="70%">▎ <i>${inline(m[1])}</i></span>`;
    if (/^\s*\|.*\|\s*$/.test(l))
        return /^[\s|:-]+$/.test(l) ? null : `<tt>${escape(l.trim())}</tt>`;
    return inline(l);
}

export function parse(md) {
    const blocks = [];
    let text = [], code = null;
    const flush = () => {
        while (text.length && text.at(-1) === '') text.pop();
        if (text.length) blocks.push({type: 'text', markup: text.join('\n')});
        text = [];
    };
    for (const l of md.replace(/\r\n?/g, '\n').split('\n')) {
        const fence = l.match(/^\s*(```|~~~)\s*([\w+#.-]*)/);
        if (code) {
            if (fence && fence[1] === code.fence) {
                blocks.push({type: 'code', lang: code.lang, text: code.lines.join('\n')});
                code = null;
            } else {
                code.lines.push(l);
            }
        } else if (fence) {
            flush();
            code = {fence: fence[1], lang: fence[2], lines: []};
        } else {
            const out = line(l);
            if (out !== null && (out !== '' || (text.length && text.at(-1) !== ''))) text.push(out);
        }
    }
    if (code) blocks.push({type: 'code', lang: code.lang, text: code.lines.join('\n')});
    flush();
    return blocks;
}
