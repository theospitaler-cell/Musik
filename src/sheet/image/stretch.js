// Eine von Verovio gesetzte Notenzeile horizontal auf die Breite der Vorlage dehnen – ohne Zeichen zu verzerren.
// Verovio setzt eine einzelne Zeile nur in natürlicher Breite; die Vorlage ist im Blocksatz breiter.
// Statt die Grafik zu strecken, werden nur die x-Positionen auseinandergezogen: Zeichen (<use>) behalten
// ihre Größe, Hilfslinien ihre Länge, Linien, Balken und Bögen reichen von Position zu Position.
const NUM = '-?\\d+(?:\\.\\d+)?';
const r = (n) => String(Math.round(n * 100) / 100);

function mapPath(d, fx, keepLength = false) {
  if (keepLength) {
    // „M x1 y L x2 y“: Mitte verschieben, Länge behalten
    const m = new RegExp(`^\\s*M\\s*(${NUM})[ ,]+(${NUM})\\s*L\\s*(${NUM})[ ,]+(${NUM})\\s*$`).exec(d);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[3]);
      const mid = fx((a + b) / 2);
      const half = Math.abs(b - a) / 2;
      return `M${r(mid - half)} ${m[2]} L${r(mid + half)} ${m[4]}`;
    }
  }
  const toks = d.match(/[MLCQSTHVZmlcqsthvz]|-?\d+(?:\.\d+)?/g) || [];
  let out = '';
  let cmd = '';
  let k = 0;
  for (const t of toks) {
    if (/[A-Za-z]/.test(t)) {
      cmd = t;
      k = 0;
      out += (out ? ' ' : '') + t;
      continue;
    }
    const v = Number(t);
    const up = cmd.toUpperCase();
    let isX = false;
    if (up === 'H') isX = true;
    else if (up === 'V') isX = false;
    else if (up !== 'Z') isX = k % 2 === 0;
    let nv = v;
    if (isX) nv = cmd === up ? fx(v) : v * fx.factor; // relative Strecken skalieren mit
    out += ' ' + r(nv);
    k++;
  }
  return out.trim();
}

// anchor: x, ab dem gedehnt wird (Schlüssel, Vorzeichen, Taktart davor bleiben); factor: Dehnung
export function stretchSvg(svg, { anchor, factor }) {
  const fx = (x) => (x <= anchor ? x : anchor + (x - anchor) * factor);
  fx.factor = factor;
  return warpSvg(svg, fx);
}

// Stückweise lineare Abbildung der x-Positionen: Paare [alt, neu] (aufsteigend); links davon unverändert,
// rechts davon mit der letzten Steigung fortgesetzt.
export function piecewise(pairs) {
  const p = [...pairs].sort((a, b) => a[0] - b[0]);
  const slope = (i) => {
    const [a0, b0] = p[i];
    const [a1, b1] = p[i + 1];
    return a1 === a0 ? 1 : (b1 - b0) / (a1 - a0);
  };
  const fx = (x) => {
    if (!p.length) return x;
    if (x <= p[0][0]) return x + (p[0][1] - p[0][0]);
    for (let i = 0; i + 1 < p.length; i++) if (x <= p[i + 1][0]) return p[i][1] + (x - p[i][0]) * slope(i);
    const last = p[p.length - 1];
    const k = p.length > 1 ? slope(p.length - 2) : 1;
    return last[1] + (x - last[0]) * k;
  };
  fx.factor = p.length > 1 ? slope(p.length - 2) : 1;
  return fx;
}

// Taktstrich-Positionen (x) im Verovio-SVG
export function svgBarlines(svg) {
  const xs = [];
  for (const m of svg.matchAll(/<g[^>]*class="barLine"[^>]*>([\s\S]*?)<\/g>/g)) {
    for (const p of m[1].matchAll(/<path d="M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)/g)) xs.push(Number(p[1]));
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (const x of xs) if (!out.length || x - out[out.length - 1] > 200) out.push(x);
  return out;
}

export function warpSvg(svg, fx) {
  const defsEnd = svg.indexOf('</defs>');
  const head = defsEnd >= 0 ? svg.slice(0, defsEnd + 7) : '';
  let body = defsEnd >= 0 ? svg.slice(defsEnd + 7) : svg;
  // Hilfslinien: Länge erhalten, Mitte mitnehmen
  const ledger = [];
  body = body.replace(/<g[^>]*class="ledgerLines"[^>]*>[\s\S]*?<\/g>/g, (m) => {
    const fixed = m.replace(/<path d="([^"]*)"/g, (mm, d) => `<path d="${mapPath(d, fx, true)}"`);
    ledger.push(fixed);
    return `@@LEDGER${ledger.length - 1}@@`;
  });
  body = body.replace(/<path d="([^"]*)"/g, (m, d) => `<path d="${mapPath(d, fx)}"`);
  body = body.replace(/<polygon points="([^"]*)"/g, (m, pts) => {
    const moved = pts
      .trim()
      .split(/\s+/)
      .map((p) => {
        const [x, y] = p.split(',');
        return `${r(fx(Number(x)))},${y}`;
      })
      .join(' ');
    return `<polygon points="${moved}"`;
  });
  body = body.replace(/(<use[^>]*?\sx=")(-?[\d.]+)(")/g, (m, a, x, z) => `${a}${r(fx(Number(x)))}${z}`);
  body = body.replace(/(<(?:text|tspan|rect)[^>]*?\sx=")(-?[\d.]+)(")/g, (m, a, x, z) => `${a}${r(fx(Number(x)))}${z}`);
  body = body.replace(/@@LEDGER(\d+)@@/g, (m, i) => ledger[Number(i)]);
  let out = head + body;
  out = out.replace(/(class="definition-scale"[^>]*viewBox="0 0 )(\d+)( \d+")/, (m, a, w, z) => `${a}${Math.round(fx(Number(w)))}${z}`);
  out = out.replace(/<svg width="([\d.]+)px"/, (m, w) => `<svg width="${r(fx(Number(w) * 10) / 10)}px"`);
  return out;
}

// Anker: Beginn der ersten Note/Pause im ersten Takt
export function contentStart(svg) {
  const defsEnd = svg.indexOf('</defs>');
  const body = defsEnd >= 0 ? svg.slice(defsEnd) : svg;
  const m = /<g[^>]*class="(?:note|rest|chord|mRest|beam)[^"]*"[^>]*>[\s\S]*?<use[^>]*?\sx="(-?[\d.]+)"/.exec(body);
  return m ? Number(m[1]) - 180 * 0.6 : 0;
}
