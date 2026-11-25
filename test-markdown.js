// Run: gjs -m test-markdown.js
import Pango from 'gi://Pango';
import {parse, inline} from './markdown.js';

const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}\n got: ${JSON.stringify(a)}\nwant: ${JSON.stringify(b)}`); };
const valid = blocks => blocks.filter(b => b.type === 'text').forEach(b => Pango.parse_markup(b.markup, -1, ''));

eq(inline('**b** *i* `c<d>` ~~s~~'), '<b>b</b> <i>i</i> <tt>c&lt;d&gt;</tt> <s>s</s>', 'inline basics');
eq(inline('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4', 'no false italics');
eq(inline('`**not bold**`'), '<tt>**not bold**</tt>', 'code span is literal');
eq(inline('a & b < c'), 'a &amp; b &lt; c', 'escaping');
eq(inline('[x](http://a.b?q=1&r=2)'), '<span underline="single" foreground="#78aeed">x</span>', 'link');

const full = parse('## Hi\n- bullet\n\n\n\n```python\nprint(1)\n```\ntail');
eq(full.map(b => b.type), ['text', 'code', 'text'], 'block split');
eq(full[1], {type: 'code', lang: 'python', text: 'print(1)'}, 'code block');
eq(full[0].markup.split('\n').length, 2, 'trailing blanks trimmed');

eq(parse('```js\nlet a = 1')[0], {type: 'code', lang: 'js', text: 'let a = 1'}, 'unterminated fence while streaming');
eq(parse('| a | b |\n|---|---|\n| 1 | 2 |')[0].markup.split('\n').length, 2, 'table separator dropped');

// overlapping delimiters must never produce mis-nested tags
for (const s of ['*a **b* c**', '~~a **b~~ c**', '_a __b_ c__', '**a *b** c*'])
    valid(parse(s));

// every prefix of a streamed message must stay valid Pango markup
const doc = '# T\n**bold *nested* text** and `x`\n> quote _it_\n1. one\n  - [x] done\n---\n```sh\nls\n```\nend ~~gone~~';
for (let i = 0; i <= doc.length; i++) valid(parse(doc.slice(0, i)));
print('markdown: all checks passed');
