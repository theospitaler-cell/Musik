// Gründliches Arrangieren (Aufwand-Stufen, siehe core/effort.js): viele Varianten erzeugen,
// bewerten, die beste behalten – in vier Schritten:
//   1. Parametersuche (ab Stufe 4): Kombinationen aus Harmonie-Vereinfachung, Bassführung und
//      Melodie-Vorrang werden mit wenigen Seeds verglichen; die beste Kombination gewinnt.
//   2. Seeds: viele Fassungen mit je „search“ Varianten pro Abschnitt, Zeitbudget statt fester Zahl.
//   3. Nachbessern: die schwächsten Abschnitte der besten Fassung werden mit vielfach mehr
//      Varianten neu geschrieben; was die Gesamtwertung verbessert, bleibt.
//   4. Bericht: gewählte Parameter, Wertungen und Zeit stehen im Arrangement (report.search).
import { arrange } from './engine.js';
import { scoreArrangement } from './quality.js';

const yieldNow = () =>
  new Promise((r) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(r, 0);
      return;
    }
    const c = new MessageChannel();
    c.port1.onmessage = () => {
      c.port1.close();
      r();
    };
    c.port2.postMessage(0);
  });

const seedOf = (base, k) => (k === 0 ? base : (base + k * 7919) >>> 0 || 1);

// Parameterkombinationen der Suche; ausdrückliche Wünsche (Rückmeldung) werden nie überschrieben
function sweepSets(opts) {
  const sets = [{ label: 'Standard', patch: {} }];
  if (!opts.cleanHarmony) sets.push({ label: 'ruhigere Harmonie', patch: { cleanHarmony: true } });
  if (!opts.bassMode) sets.push({ label: 'ruhigerer Bass', patch: { bassMode: 'calm' } });
  if (!opts.melodyFirst && Number(opts.adapt ?? 1) >= 1) sets.push({ label: 'Melodie zuerst', patch: { melodyFirst: true } });
  if (!opts.cleanHarmony && !opts.bassMode) sets.push({ label: 'ruhige Harmonie + Bass', patch: { cleanHarmony: true, bassMode: 'calm' } });
  return sets;
}

// cfg: { seeds, search, budgetMs, sweep, polish } (EFFORT[..].arrange); onProgress(frac, text)
export async function arrangeBest(song, opts = {}, cfg = {}, { onProgress = () => {}, now = () => Date.now() } = {}) {
  const c = { seeds: 8, search: 6, budgetMs: 20000, sweep: false, polish: 1, ...cfg };
  const base = Number(opts.seed) || 1;
  const t0 = now();
  const adapt = opts.adapt ?? 1;
  const score = (a) => scoreArrangement(a, { adapt });
  const budget = Math.max(1000, c.budgetMs);
  const frac = () => Math.min(0.98, (now() - t0) / budget);
  const log = [];
  let best = null;
  let usedOpts = { ...opts };
  let trials = 0;

  const consider = (a, o, label) => {
    const sc = score(a);
    trials++;
    if (!best || sc > best.sc) {
      best = { a, sc, o, label };
      return true;
    }
    return false;
  };

  // 1) Parametersuche
  if (c.sweep) {
    const sets = sweepSets(opts);
    let k = 0;
    for (const s of sets) {
      const o = { ...opts, ...s.patch, search: c.search, seed: seedOf(base, 0) };
      const a = arrange(song, o);
      const sc = score(a);
      log.push(`${s.label}: ${sc.toFixed(1)}`);
      trials++;
      if (!best || sc > best.sc) best = { a, sc, o, label: s.label };
      onProgress(Math.min(0.25, 0.25 * (++k / sets.length)), `Parameter: ${s.label}`);
      await yieldNow();
      if (now() - t0 > budget * 0.25) break;
    }
    usedOpts = { ...best.o };
  }

  // 2) Seeds
  const startFrac = c.sweep ? 0.25 : 0;
  let n = 0;
  const scores = [];
  for (let k = 0; k < c.seeds; k++) {
    const seed = seedOf(base, k);
    if (c.sweep && k === 0) {
      n++;
      scores.push(Math.round(best.sc * 10) / 10);
      continue;
    }
    const o = { ...usedOpts, seed, search: c.search };
    const a = arrange(song, o);
    n++;
    const sc = score(a);
    scores.push(Math.round(sc * 10) / 10);
    consider(a, o, 'Seed');
    onProgress(startFrac + (0.6 - startFrac) * Math.max(frac(), n / c.seeds), `Fassung ${n} von ${c.seeds} · beste Wertung ${best.sc.toFixed(1)}`);
    if (n >= 2 && now() - t0 >= budget * 0.6) break;
    await yieldNow();
  }

  // 3) Nachbessern der schwächsten Abschnitte
  let polished = 0;
  for (let round = 0; round < c.polish; round++) {
    const segs = (best.a.segmentScores || []).slice().sort((x, y) => x.score - y.score);
    if (!segs.length || now() - t0 > budget) break;
    const worst = segs.slice(0, Math.max(2, Math.ceil(segs.length / 5))).map((s) => s.key);
    const o = { ...best.o, deepSegments: [...new Set([...(best.o.deepSegments || []), ...worst])], search: Math.max(c.search, 4) };
    const a = arrange(song, o);
    const improved = consider(a, o, 'Nachbessern');
    if (improved) polished++;
    onProgress(0.6 + 0.38 * ((round + 1) / c.polish), `Nachbessern ${round + 1} von ${c.polish}`);
    await yieldNow();
    if (!improved && round >= 1) break;
  }

  const a = best.a;
  const info = { seeds: n, trials, perSegment: c.search, score: Math.round(best.sc * 10) / 10, scores, chosen: best.label, sweep: log, polished, ms: now() - t0 };
  a.report.search = info;
  a.report.notes = [
    ...(a.report.notes || []),
    `Gründlich: ${trials} Fassungen verglichen (je ${c.search} Varianten pro Abschnitt${c.sweep ? ', Parametersuche' : ''}${polished ? `, ${polished}× nachgebessert` : ''}) – beste Wertung ${info.score}.`,
  ];
  onProgress(1, 'Fertig');
  return a;
}
