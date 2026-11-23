// Fast drop-in for makefun-site 1.0.0 — byte-identical output, less CPU.
// Strategy: bulk HTML escaping (never per-character), cached slugify,
// single-pass Markdown lexer with char-code checks instead of regexes,
// a flat-scope template interpreter that pushes into an array and joins,
// and fused build passes that avoid re-scanning / re-allocating.
// No network, no clock, no randomness, no cache across cases.

const ESC_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
function esc(t) {
  if (!ESC_TEST.test(t)) return t;
  return t.replace(ESC_RE, (c) => ESCAPES[c]);
}
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function longDate(date) { const p = date.split('-'); return `${Number(p[2])} ${MONTHS[Number(p[1]) - 1]} ${p[0]}`; }

// ---- slugify, cached (titles/tags/headings repeat a lot) ----
const slugCache = new Map();
function slugify(text) {
  let out = slugCache.get(text);
  if (out !== undefined) return out;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let s = '', gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = s.length > 0; continue; }
    if (gap) s += '-';
    gap = false; s += keep;
  }
  s = s.slice(0, 64).replace(/-+$/, '');
  out = s === '' ? 'untitled' : s;
  if (slugCache.size < 20000) slugCache.set(text, out);
  return out;
}
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out); return out;
}
function wordsOf(text) {
  let n = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
    if (!ws && !inWord) { n++; inWord = true; } else if (ws) inWord = false;
  }
  return n;
}

// ---- front matter (same grammar / errors as the reference) ----
const KEYS = ['title','date','tags','draft','layout','slug','summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n; i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}
function valueOf(key, raw) {
  switch (key) {
    case 'title': case 'summary': { const s = stringOf(raw); return 'error' in s ? { error: `key "${key}": ${s.error}` } : s; }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0, mo = m ? Number(m[2]) : 0, d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft': return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug': return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default: return { error: `unknown key "${key}"` };
  }
}
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---- Markdown: single-pass lexer, char-code checks, bulk inline ----
const ESCAPABLE = new Set(['\\','`','*','_','[',']','(',')','#','+','-','.','!','>']);
function isBlank(line) {
  if (line === '') return true;
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}
function fenceLang(line) { // returns lang or null; line starts with ```
  let i = 3, lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) { lang += line[i]; i++; }
    else break;
  }
  while (i < line.length) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; i++; }
  return lang;
}
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let n = 0; while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n); if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(n));
  return text === '' ? null : { depth: n, text };
}
function isHR(line) {
  if (line !== '---' && line !== '***') {
    if (!line.startsWith('---') && !line.startsWith('***')) return false;
    const body = line.slice(3);
    for (let i = 0; i < body.length; i++) { const c = body.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
    return true;
  }
  return true;
}
function endsParagraph(line) {
  return isBlank(line) || (line.startsWith('```') && fenceLang(line) !== null) || headingOf(line) !== null || isHR(line);
}
function isContinued(line) {
  let k = 0; while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  const c = line.charCodeAt(k);
  return c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 11 && c !== 12;
}
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    if (line.startsWith('```')) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = []; i++;
        while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++; tokens.push({ type: 'code', lang, lines: body }); continue;
      }
    }
    const heading = headingOf(line);
    if (heading !== null) { tokens.push({ type: 'heading', depth: heading.depth, text: heading.text }); i++; continue; }
    if (isHR(line)) { tokens.push({ type: 'hr' }); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') }); continue;
    }
    const c0 = line.charCodeAt(0), c1 = line.charCodeAt(1);
    if ((c0 === 45 || c0 === 42) && c1 === 32) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) { items.push([trimLine(l.slice(2))]); i++; }
        else if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; }
        else break;
      }
      tokens.push({ type: 'list', ordered: false, start: 1, items: items.map((p) => p.join('\n')) }); continue;
    }
    // ordered: digits + '. '
    if (c0 >= 48 && c0 <= 57) {
      let j = 0; while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (j > 0 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
        const start = Number(line.slice(0, j));
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          let k = 0; while (k < l.length && l.charCodeAt(k) >= 48 && l.charCodeAt(k) <= 57) k++;
          if (k > 0 && k <= 9 && l.charCodeAt(k) === 46 && l.charCodeAt(k + 1) === 32) { items.push([trimLine(l.slice(k + 2))]); i++; }
          else if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; }
          else break;
        }
        tokens.push({ type: 'list', ordered: true, start, items: items.map((p) => p.join('\n')) }); continue;
      }
    }
    const body = [trimLine(line)]; i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}
function findUnescaped(s, what, from) {
  if (s.indexOf('\\', from) === -1) return s.indexOf(what, from);
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}
const NEXT_RE = /[\\`*\[]/g;
function inline(s, env) {
  const parts = []; let i = 0; const n = s.length;
  while (i < n) {
    NEXT_RE.lastIndex = i;
    const mt = NEXT_RE.exec(s);
    const j = mt === null ? n : mt.index;
    const kind = mt === null ? 0 : (mt[0] === '\\' ? 1 : mt[0] === '`' ? 2 : mt[0] === '*' ? 3 : 4);
    if (j === n) { parts.push(esc(s.slice(i))); break; }
    if (j > i) parts.push(esc(s.slice(i, j)));
    i = j;
    if (kind === 1) {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) { parts.push(esc(s[i + 1])); i += 2; }
      else { parts.push('\\'); i++; }
      continue;
    }
    if (kind === 2) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) { parts.push('<code>', esc(s.slice(i + 1, k)), '</code>'); i = k + 1; }
      else { parts.push('`'); i++; }
      continue;
    }
    if (kind === 3) {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) { parts.push('<strong>', inline(s.slice(i + 2, k), env), '</strong>'); i = k + 2; }
        else { parts.push('**'); i += 2; }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) { parts.push('<em>', inline(s.slice(i + 1, k), env), '</em>'); i = k + 1; }
      else { parts.push('*'); i++; }
      continue;
    }
    // kind === 4, '['
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) { parts.push('<a href="', esc(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>'); i = m + 1; }
    else { parts.push('['); i++; }
  }
  return parts.join('');
}
function renderMarkdown(src, env) {
  const ids = new Set(); const blocks = []; const toc = []; let excerpt = null;
  for (const t of lex(src)) {
    if (t.type === 'heading') {
      const id = uniqueSlug(slugify(t.text), ids);
      const html = inline(t.text, env);
      blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
      if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
    } else if (t.type === 'code') {
      const cls = t.lang === '' ? '' : ` class="language-${esc(t.lang)}"`;
      const body = t.lines.length === 0 ? '' : esc(t.lines.join('\n')) + '\n';
      blocks.push(`<pre><code${cls}>${body}</code></pre>`);
    } else if (t.type === 'hr') blocks.push('<hr>');
    else if (t.type === 'blockquote') blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
    else if (t.type === 'list') {
      const tag = t.ordered ? 'ol' : 'ul';
      const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
      let inner = '';
      for (const item of t.items) inner += `<li>${inline(item, env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
    } else {
      const html = inline(t.text, env);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
    }
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---- Templates: parse once (same errors as reference), render flat ----
const INCLUDE_DEPTH = 8;
const TPATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TFOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TIF = /^if (not )?(\S+)$/;
const TINCLUDE = /^include "([a-z0-9-]+)"$/;
class TemplateError extends Error {}
function tpathOf(name, text) {
  if (!TPATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}
function tokenize(name, src) {
  const tokens = []; let text = '', i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text }); text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tpathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2); continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text }); text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] }; const stack = [root]; let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag; const top = stack[stack.length - 1]; let m;
      if ((m = TFOR.exec(tag)) !== null) { const node = { kind: 'for', name: m[1], path: tpathOf(name, m[2]), body: [] }; body.push(node); stack.push(node); body = node.body; }
      else if ((m = TIF.exec(tag)) !== null) { const node = { kind: 'if', not: m[1] !== undefined, path: tpathOf(name, m[2]), then: [], else: null }; body.push(node); stack.push(node); body = node.then; }
      else if (tag === 'else') { if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`); top.else = []; body = top.else; }
      else if (tag === 'endfor' || tag === 'endif') { if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`); stack.pop(); const parent = stack[stack.length - 1]; body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then; }
      else if ((m = TINCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}
function lookup(vars, path) {
  if (!Object.hasOwn(vars, path[0])) return undefined;
  let v = vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
function renderNodes(nodes, vars, templates, depth, parts) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') parts.push(n.text);
    else if (n.kind === 'var') parts.push(esc(textOf(lookup(vars, n.path))));
    else if (n.kind === 'raw') parts.push(textOf(lookup(vars, n.path)));
    else if (n.kind === 'if') {
      const v = truthy(lookup(vars, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, vars, templates, depth, parts);
    } else if (n.kind === 'for') {
      const xs = lookup(vars, n.path);
      if (!Array.isArray(xs)) continue;
      const hadName = Object.hasOwn(vars, n.name); const oldName = vars[n.name];
      const hadLoop = Object.hasOwn(vars, 'loop'); const oldLoop = vars.loop;
      const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
      vars.loop = loop;
      for (let k = 0; k < xs.length; k++) {
        vars[n.name] = xs[k];
        loop.index = k + 1; loop.first = k === 0; loop.last = k === xs.length - 1;
        renderNodes(n.body, vars, templates, depth, parts);
      }
      if (hadName) vars[n.name] = oldName; else delete vars[n.name];
      if (hadLoop) vars.loop = oldLoop; else delete vars.loop;
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, vars, templates, depth + 1, parts);
    }
  }
}

// ---- Build ----
const RESERVED = ['posts', 'tags', 'page'];
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export function run(input) {
  slugCache.clear(); // nothing is carried from one case to the next
  const templates = new Map(); const report = [];
  const tnames = Object.keys(input.templates).sort();
  for (const name of tnames) {
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) { if (!(err instanceof TemplateError)) throw err; report.push(err.message); }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  // sources, sorted by path
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const sources = []; const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }
  // front matter + checks, in order
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data; s.body = fm.body; s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags'; else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (!set) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug; s.outDir = dir === '' ? slug : `${dir}/${slug}`; s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = { link: (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    } };
    const md = renderMarkdown(s.body, env);
    s.html = md.html; s.toc = md.toc; s.excerpt = md.excerpt; s.words = wordsOf(s.body);
  }
  // collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0)));
  posts.forEach((p, k) => { p.newer = k === 0 ? null : posts[k - 1]; p.older = k === posts.length - 1 ? null : posts[k + 1]; });
  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set(); const out = [];
    for (const name of (s.data.tags ?? [])) { const sl = slugify(name); if (!seen.has(sl)) { seen.add(sl); out.push(name); } }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (!tag) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p); p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => (y.posts.length - x.posts.length) || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  // layouts
  const output = {};
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '', excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(); for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const parts = []; renderNodes(nodes, vars, templates, 0, parts); return parts.join('');
  };
  const pageOf = (s) => {
    const c = cardOf(s);
    return { title: c.title, url: c.url, date: c.date, date_long: c.date_long, summary: c.summary, excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
      slug: s.slug, content: s.html, toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post };
  };
  let pageCount = 0;
  for (const s of kept) {
    if (!s.post) pageCount++;
    output[`${s.outDir}/index.html`] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', { site, tags: allTags, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) } });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { site, tags: allTags, recent, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort();
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
