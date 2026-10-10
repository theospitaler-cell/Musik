// Tempoangaben aus den Beat-Zeiten einer Aufnahme: neue Tempi (dauerhafte Wechsel),
// rit./accel. (stetige Änderung über mindestens zwei Takte) und „a tempo“.
// Notiert wird nur, was ein Musiker spürt – kleine Schwankungen bleiben unberücksichtigt.

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// timing: {beatSec, firstBeat}; meterBeats: Schläge je Takt (wie beim Beat-Tracking)
// -> {marks: [{bar, kind: 'tempo'|'rit'|'accel'|'atempo', bpm}], perBar: [bpm]}
export function tempoMarksFromTiming(timing, meterBeats, measureCount) {
  const bs = timing.beatSec;
  const f = timing.firstBeat;
  const perBar = [];
  for (let m = 0; m < measureCount; m++) {
    const a = f + m * meterBeats;
    const z = a + meterBeats;
    if (z >= bs.length) break;
    perBar.push((60 * meterBeats) / (bs[z] - bs[a]));
  }
  const n = perBar.length;
  if (n < 4) return { marks: n ? [{ bar: 0, kind: 'tempo', bpm: Math.round(perBar[0]) }] : [], perBar };
  // je Takt gemittelt (4 Schläge) ist das Tempo schon ruhig genug; ein Median würde kurze
  // rit. am Schluss und abrupte Wechsel verwischen
  const sm = perBar;
  const marks = [];
  let cur = median(sm.slice(0, Math.min(n, 4)));
  marks.push({ bar: 0, kind: 'tempo', bpm: Math.round(cur) });
  const rel = (x) => x / cur - 1;
  let k = 1;
  while (k < n) {
    // stetige Änderung: mindestens 2 Takte in dieselbe Richtung, zusammen ≥ 10 %
    let z = k;
    // (nur deutliche Schritte ≥ 2,5 % je Takt zählen – kleine Schwankungen nicht)
    const dir = Math.abs(sm[k] - sm[k - 1]) / cur >= 0.025 ? Math.sign(sm[k] - sm[k - 1]) : 0;
    if (dir !== 0) while (z + 1 < n && Math.sign(sm[z + 1] - sm[z]) === dir && Math.abs(sm[z + 1] - sm[z]) / cur >= 0.025) z++;
    const total = (sm[z] - sm[k - 1]) / cur;
    const steady = (from, len) => {
      const seg = sm.slice(from, Math.min(n, from + len));
      return seg.length >= Math.min(len, n - from) && seg.length > 0 && seg.every((x) => Math.abs(x / median(seg) - 1) < 0.05) ? median(seg) : null;
    };
    const after = z + 4 <= n ? steady(z + 1, 3) : null;
    // abrupter Wechsel (innerhalb von höchstens 2 Takten, danach gleichmäßig neues Tempo)
    if (z - k + 1 <= 2 && after !== null && Math.abs(after / cur - 1) >= 0.1 && Math.abs(total) >= 0.08) {
      cur = after;
      marks.push({ bar: k, kind: 'tempo', bpm: Math.round(cur) });
      k = z + 1;
      continue;
    }
    // stetige Änderung (rit./accel.): ≥ 3 Takte – oder 2 Takte am Schluss
    if ((z - k + 1 >= 3 || (z - k + 1 >= 2 && z >= n - 1)) && Math.abs(total) >= 0.1) {
      // Anfang der Änderung: erster Takt, ab dem es deutlich langsamer/schneller wird
      let start = k;
      while (start < z && Math.abs(sm[start] / sm[k - 1] - 1) < 0.03) start++;
      marks.push({ bar: start, kind: dir < 0 ? 'rit' : 'accel', bpm: Math.round(sm[z]) });
      // danach: zurück zum alten Tempo (a tempo) oder neues Tempo
      if (after !== null) {
        if (Math.abs(after / cur - 1) < 0.05) marks.push({ bar: z + 1, kind: 'atempo', bpm: Math.round(cur) });
        else {
          cur = after;
          marks.push({ bar: z + 1, kind: 'tempo', bpm: Math.round(cur) });
        }
      }
      k = z + 1;
      continue;
    }
    // dauerhafter Sprung: ab hier mindestens 4 Takte gleichmäßig in einem anderen Tempo
    const w = steady(k, 4);
    if (w !== null && Math.abs(rel(w)) >= 0.1 && Math.abs(rel(sm[k])) >= 0.06) {
      cur = w;
      marks.push({ bar: k, kind: 'tempo', bpm: Math.round(cur) });
    }
    k++;
  }
  return { marks, perBar };
}

// Ausdrückliche Tempoangaben einer Datei (MIDI-Tempo-Events, MusicXML <sound tempo>) und
// Vortragsworte (rit./accel./a tempo) -> Tempoangaben je Takt.
// events: [{t (Ticks ab Takt 1), bpm}] , words: [{t, text}], mt: Taktlänge in Ticks
export function marksFromEvents(events, words, mt) {
  const ev = [...events].filter((e) => e.bpm > 0).sort((a, b) => a.t - b.t);
  const marks = [];
  if (!ev.length) return { marks, map: [] };
  const map = [];
  for (const e of ev) if (!map.length || Math.round(e.bpm) !== Math.round(map[map.length - 1].bpm)) map.push({ t: Math.max(0, e.t), bpm: Math.round(e.bpm) });
  marks.push({ bar: 0, kind: 'tempo', bpm: map[0].bpm });
  // viele kleine, gleichgerichtete Schritte kurz hintereinander = rit./accel. (in MIDI üblich)
  let i = 1;
  while (i < map.length) {
    let j = i;
    const dir = Math.sign(map[i].bpm - map[i - 1].bpm);
    while (j + 1 < map.length && Math.sign(map[j + 1].bpm - map[j].bpm) === dir && map[j + 1].t - map[j].t <= mt) j++;
    if (j - i + 1 >= 3) {
      marks.push({ bar: Math.floor(map[i].t / mt), kind: dir < 0 ? 'rit' : 'accel', bpm: map[j].bpm });
      i = j + 1;
      continue;
    }
    marks.push({ bar: Math.floor(map[i].t / mt), kind: 'tempo', bpm: map[i].bpm });
    i++;
  }
  for (const w of words || []) {
    const kind = /a\s*tempo|tempo\s*(i|1|primo)\b/i.test(w.text) ? 'atempo' : /rit|rall|allarg/i.test(w.text) ? 'rit' : /accel|string/i.test(w.text) ? 'accel' : null;
    if (kind && !marks.some((m) => m.bar === Math.floor(w.t / mt) && m.kind === kind)) marks.push({ bar: Math.floor(Math.max(0, w.t) / mt), kind, bpm: null });
  }
  marks.sort((a, b) => a.bar - b.bar);
  return { marks, map };
}
