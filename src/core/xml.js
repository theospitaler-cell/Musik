// Minimaler, abhängigkeitsfreier XML-Parser und -Builder.
// Läuft identisch im Browser und in Node (für Tests).

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export class XNode {
  constructor(name, attrs = {}) {
    this.name = name;
    this.attrs = attrs;
    this.children = [];
    this.textParts = [];
  }
  get text() {
    return this.textParts.join('').trim();
  }
  child(name) {
    return this.children.find((c) => c.name === name) || null;
  }
  all(name) {
    return this.children.filter((c) => c.name === name);
  }
  // Pfad wie 'pitch/step'
  get(path) {
    let n = this;
    for (const p of path.split('/')) {
      n = n && n.child(p);
      if (!n) return null;
    }
    return n;
  }
  val(path, def = null) {
    const n = this.get(path);
    return n ? n.text : def;
  }
  num(path, def = null) {
    const v = this.val(path);
    if (v === null || v === '') return def;
    const x = Number(v);
    return Number.isFinite(x) ? x : def;
  }
  has(path) {
    return this.get(path) !== null;
  }
  // Alle Nachfahren mit Namen (Tiefensuche)
  find(name, out = []) {
    for (const c of this.children) {
      if (c.name === name) out.push(c);
      c.find(name, out);
    }
    return out;
  }
}

export function parseXML(src) {
  const root = new XNode('#document');
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].textParts.push(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) stack[stack.length - 1].textParts.push(decodeEntities(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      stack[stack.length - 1].textParts.push(src.slice(lt + 9, e < 0 ? n : e));
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE (ggf. mit internem Subset [...])
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e).trim();
      // tolerant schließen
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = e + 1;
      continue;
    }
    // Start-Tag
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    let inner = src.slice(lt + 1, j);
    let selfClose = false;
    if (inner.endsWith('/')) {
      selfClose = true;
      inner = inner.slice(0, -1);
    }
    const m = /^([^\s/>]+)/.exec(inner);
    const name = m ? m[1] : inner;
    const attrs = {};
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    const rest = inner.slice(name.length);
    while ((a = re.exec(rest))) attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
    const node = new XNode(name, attrs);
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  const docEl = root.children[0];
  if (!docEl) throw new Error('Leeres oder ungültiges XML');
  return docEl;
}

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Kleiner String-Builder mit Einrückung
export class XmlWriter {
  constructor() {
    this.out = [];
    this.depth = 0;
  }
  raw(s) {
    this.out.push('  '.repeat(this.depth) + s);
  }
  attrs(a) {
    if (!a) return '';
    let s = '';
    for (const [k, v] of Object.entries(a)) if (v !== undefined && v !== null) s += ` ${k}="${esc(v)}"`;
    return s;
  }
  open(name, a) {
    this.raw(`<${name}${this.attrs(a)}>`);
    this.depth++;
  }
  close(name) {
    this.depth--;
    this.raw(`</${name}>`);
  }
  el(name, text, a) {
    if (text === undefined || text === null) this.raw(`<${name}${this.attrs(a)}/>`);
    else this.raw(`<${name}${this.attrs(a)}>${esc(text)}</${name}>`);
  }
  toString() {
    return this.out.join('\n') + '\n';
  }
}
