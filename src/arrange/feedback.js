// Rückmeldung zum Ergebnis („Überarbeiten“): freier Text -> konkrete Änderungen.
//
// Lokal und ohne Server: Der Text wird nach Anliegen durchsucht (Melodie fehlt, zu schwer, Stimme
// liegt zu hoch, Tempo, Takte …). Jedes erkannte Anliegen wird zu einer Einstellung des
// Arrangements bzw. zu einer Neu-Analyse; unbekannter Text wird nicht geraten, sondern gemeldet.
// Ohne Text: alles gründlich überarbeiten (mehr Varianten, tiefere Suche).
//
// Optional kann ein externer KI-Assistent denselben Text übersetzen (siehe app.js); sein Ergebnis
// läuft durch dieselbe Prüfung (sanitizeTweaks) – er kann nur setzen, was hier erlaubt ist.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Wörter für Stimmen -> Instrument-IDs (beginnend)
const VOICE_WORDS = [
  [/trompet/i, ['trumpet', 'cornet', 'flugelhorn']],
  [/posaun/i, ['trombone', 'bassTrombone']],
  [/tuba|sousaphon|bass(?!klar)/i, ['tuba', 'sousaphone', 'ebass', 'contrabass']],
  [/horn(?!ist)/i, ['horn']],
  [/saxophon|sax\b/i, ['altoSax', 'tenorSax', 'bariSax', 'sopranoSax']],
  [/klarinett/i, ['clarinet', 'bassClarinet']],
  [/fl[oö]te/i, ['flute']],
  [/violin|geige/i, ['violin']],
  [/cello/i, ['cello']],
];

const ORD = { erste: 1, zweite: 2, dritte: 3, vierte: 4, fünfte: 5, fuenfte: 5, sechste: 6, siebte: 7, achte: 8, '1.': 1, '2.': 2, '3.': 3, '4.': 4 };

// ctx: { voices: [instrumentId], bars: Anzahl gedruckter Takte, hasAudio, tempo }
export function interpretFeedback(textIn, ctx = {}) {
  const text = String(textIn || '').trim();
  const t = ` ${text.toLowerCase().replace(/[„“"']/g, ' ')} `;
  const tweaks = {};
  const notes = []; // was verstanden wurde (für die Anzeige)
  const matched = [];
  const has = (re) => re.test(t);
  const mark = (re) => {
    matched.push(re);
  };

  if (!text) {
    return { tweaks: { general: true }, notes: ['Alles wird gründlich überarbeitet: mehr Varianten, tiefere Suche, Neu-Analyse der Aufnahme.'], unknown: [], general: true };
  }

  // --- Takte
  const barRanges = [];
  const reBars = /takt(?:e|en)?\s*(\d{1,3})(?:\s*(?:-|–|bis|und)\s*(\d{1,3}))?/g;
  let m;
  while ((m = reBars.exec(t))) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    barRanges.push({ from: Math.min(a, b), to: Math.max(a, b) });
  }
  const fromBar = /ab\s+takt\s*(\d{1,3})/.exec(t);
  if (fromBar) barRanges.push({ from: Number(fromBar[1]), to: ctx.bars || 999 });
  if (barRanges.length) {
    tweaks.focus = barRanges.slice(0, 6);
    notes.push(`Schwerpunkt auf Takt ${barRanges.map((r) => (r.from === r.to ? r.from : `${r.from}–${r.to}`)).join(', ')} (dort werden mehr Varianten verglichen).`);
  }

  // --- Melodie
  const melodyWord = /melodie|hauptstimme|gesang|thema|lead/;
  const bad = /fehlt|fehlen|nicht da|nicht zu hören|kaum|bruch|lücke|luecke|unvollständig|unvollstaendig|abgehackt|zerstückelt|zerstueckelt|erkenn|nicht .*wieder|schlecht|falsch|stimmt nicht|zu leise|versteck|untergeh/;
  if (melodyWord.test(t) && bad.test(t)) {
    tweaks.melodyFirst = true;
    tweaks.adapt = 0;
    if (ctx.hasAudio) tweaks.reanalyze = true;
    notes.push('Die Melodie bekommt Vorrang: Stimme 1 spielt sie durchgehend, nah am Original' + (ctx.hasAudio ? '; die Aufnahme wird mit mehr Durchgängen neu gehört.' : '.'));
    mark(melodyWord);
  }

  // --- Zusammenklang
  if (/passen nicht zusammen|nicht zusammen|schief|unsauber|dissonan|reibt|reibung|klingt falsch|falsche töne|falsche toene|disharmon|harmonie|akkord(e)? (falsch|stimmen nicht)|durcheinander|chaotisch|wirr/.test(t)) {
    tweaks.cleanHarmony = true;
    tweaks.cleaner = true;
    notes.push('Zusammenklang: Harmonie wird je Takt vereinfacht, Reibungen und Parallelen werden strenger vermieden, mehr Varianten werden verglichen.');
  }

  // --- Schwierigkeit
  if (/zu schwer|zu schwierig|unspielbar|nicht spielbar|zu viele noten|zu schnell zu spielen|überfordert|ueberfordert|zu hektisch|zu unruhig/.test(t)) {
    tweaks.difficultyDelta = -1;
    notes.push('Einfacher: eine Schwierigkeitsstufe leichter (ruhigerer Rhythmus, kleinere Sprünge).');
  } else if (/zu leicht|zu einfach|langweilig|eintönig|eintoenig|zu wenig los|mehr los|mehr noten|zu simpel/.test(t)) {
    tweaks.difficultyDelta = 1;
    notes.push('Lebendiger: eine Schwierigkeitsstufe höher (mehr Bewegung, Verzierungen).');
  }

  // --- Stimmen zu hoch / zu tief
  const voices = ctx.voices || [];
  const rangeMentions = [];
  const reRange = /([^.;,\n]{0,40}?)(zu hoch|zu tief|liegt hoch|liegt tief|zu laut|zu leise)/g;
  while ((m = reRange.exec(t))) {
    const who = m[1];
    const what = m[2];
    if (/laut|leise/.test(what)) continue;
    let idx = -1;
    const sm = /stimme\s*(\d)/.exec(who);
    if (sm) idx = Number(sm[1]) - 1;
    if (idx < 0) {
      for (const [word, ids] of VOICE_WORDS) {
        if (!word.test(who)) continue;
        const ord = Object.entries(ORD).find(([w]) => who.includes(w));
        const cands = voices.map((v, i) => (ids.includes(v) ? i : -1)).filter((i) => i >= 0);
        if (cands.length) idx = ord ? cands[Math.min(cands.length - 1, ord[1] - 1)] ?? cands[0] : cands[0];
        break;
      }
    }
    if (idx >= 0 && idx < Math.max(voices.length, 8)) rangeMentions.push({ voice: idx, dir: /hoch/.test(what) ? 'lower' : 'higher' });
  }
  if (rangeMentions.length) {
    tweaks.voiceRanges = rangeMentions;
    notes.push(rangeMentions.map((r) => `Stimme ${r.voice + 1} wird ${r.dir === 'lower' ? 'tiefer' : 'höher'} gesetzt`).join('; ') + '.');
  }

  // --- Tempo
  if (/tempo|geschwindigkeit|zu schnell|zu langsam|schleppt|rast|hetzt/.test(t)) {
    if (/doppelt so schnell|doppeltes tempo|halbe noten|zu viele sechzehntel|sechzehntel/.test(t)) {
      tweaks.retime = 2;
      notes.push('Notenwerte: doppeltes Tempo mit Achteln statt Sechzehnteln.');
    } else if (/halb so schnell|halbes tempo|halbe geschwindigkeit/.test(t)) {
      tweaks.retime = 0.5;
      notes.push('Notenwerte: halbes Tempo.');
    } else if (/zu schnell|rast|hetzt/.test(t)) {
      tweaks.tempoFactor = 0.88;
      notes.push('Tempo: etwa 12 % langsamer.');
    } else if (/zu langsam|schleppt|zäh|zaeh/.test(t)) {
      tweaks.tempoFactor = 1.12;
      notes.push('Tempo: etwa 12 % schneller.');
    }
  }
  if (/taktstrich|taktanfang|eins .*falsch|betonung (falsch|verschoben)|verschoben|um einen schlag/.test(t) && ctx.hasAudio) {
    tweaks.shiftDownbeat = /früher|frueher|vorher/.test(t) ? -1 : 1;
    notes.push(`Taktanfang: um einen Schlag ${tweaks.shiftDownbeat < 0 ? 'früher' : 'später'}.`);
  }

  // --- Solo, Schlagzeug, Bass
  if (/solo/.test(t) && /(weg|nicht|kein|ohne|stört|stoert|raus)/.test(t)) {
    tweaks.solo = 'none';
    notes.push('Kein Solo.');
  } else if (/solo/.test(t) && /zu lang|kürzer|kuerzer|länger als|zu ausgedehnt/.test(t)) {
    tweaks.solo = 'short';
    notes.push('Kürzeres Arrangement mit kurzem Solo.');
  }
  if (/schlagzeug|drums|drum/.test(t)) {
    if (/weg|ohne|kein|stört|stoert|raus|nervt/.test(t)) {
      tweaks.drums = 'off';
      notes.push('Schlagzeug aus.');
    } else if (/zu viel|zu laut|zu unruhig|zu komplex|zu aufwendig|zu aufwändig/.test(t)) {
      tweaks.drums = 'simpler';
      notes.push('Schlagzeug einfacher.');
    }
  }
  if (/\bbass\b|tuba|sousaphon/.test(t)) {
    if (/zu unruhig|hektisch|zu viele noten|wuselt|nervös|nervoes|zu aktiv/.test(t)) {
      tweaks.bass = 'calm';
      notes.push('Bass ruhiger: längere Töne auf den Grundtönen.');
    } else if (/langweilig|monoton|eintönig|eintoenig|immer derselbe|zu wenig bewegung|statisch/.test(t)) {
      tweaks.bass = 'busy';
      notes.push('Bass lebendiger: Figuren des Stils statt der Vorlage.');
    }
  }

  // --- Nähe zum Original / Freiheit
  if (/näher am original|naeher am original|originalgetreu|wie das original|wie im original|mehr original|zu weit weg|erkenne.*nicht/.test(t) && tweaks.adapt === undefined) {
    tweaks.adapt = 0;
    notes.push('Näher am Original: Melodie und Rhythmus bleiben wie im Lied.');
  } else if (/freier|kreativer|mehr abwechslung|mehr variation|zu nah am original|zu ähnlich|zu aehnlich|verspielter/.test(t)) {
    tweaks.adapt = 2;
    notes.push('Freier: Stil und Verzierungen haben mehr Gewicht.');
  }

  // --- allgemeine Unzufriedenheit
  const specific = Object.keys(tweaks).filter((k) => k !== 'focus').length > 0;
  if (!specific && !barRanges.length) {
    tweaks.general = true;
    notes.push('Kein bestimmtes Anliegen erkannt – alles wird gründlich überarbeitet (mehr Varianten, tiefere Suche). Schreibe z. B. „Melodie fehlt in der Strophe“ oder „Stimme 2 liegt zu hoch“, damit ich gezielt eingreife.');
  }
  // gründlich immer: mehr Varianten
  tweaks.deep = true;
  return { tweaks, notes, unknown: [], general: !!tweaks.general };
}

// Prüfung fremder Vorschläge (z. B. eines externen Assistenten): nur Bekanntes, in Grenzen
export function sanitizeTweaks(raw, { voices = 4 } = {}) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const t = {};
  const bool = (k) => {
    if (o[k] === true) t[k] = true;
  };
  ['general', 'melodyFirst', 'cleanHarmony', 'cleaner', 'reanalyze', 'deep'].forEach(bool);
  if ([0, 1, 2].includes(o.adapt)) t.adapt = o.adapt;
  if ([-1, 1].includes(o.difficultyDelta)) t.difficultyDelta = o.difficultyDelta;
  if (Number.isFinite(o.tempoFactor)) t.tempoFactor = clamp(o.tempoFactor, 0.6, 1.5);
  if ([2, 0.5].includes(o.retime)) t.retime = o.retime;
  if ([-1, 1].includes(o.shiftDownbeat)) t.shiftDownbeat = o.shiftDownbeat;
  if (['none', 'short'].includes(o.solo)) t.solo = o.solo;
  if (['off', 'simpler'].includes(o.drums)) t.drums = o.drums;
  if (['calm', 'busy'].includes(o.bass)) t.bass = o.bass;
  if (Array.isArray(o.voiceRanges)) {
    t.voiceRanges = o.voiceRanges
      .filter((r) => r && Number.isInteger(r.voice) && r.voice >= 0 && r.voice < Math.max(voices, 8) && ['lower', 'higher'].includes(r.dir))
      .slice(0, 8)
      .map((r) => ({ voice: r.voice, dir: r.dir }));
    if (!t.voiceRanges.length) delete t.voiceRanges;
  }
  if (Array.isArray(o.focus)) {
    t.focus = o.focus
      .filter((r) => r && Number.isFinite(r.from) && Number.isFinite(r.to))
      .slice(0, 6)
      .map((r) => ({ from: Math.max(1, Math.round(Math.min(r.from, r.to))), to: Math.round(Math.max(r.from, r.to)) }));
    if (!t.focus.length) delete t.focus;
  }
  if (!Object.keys(t).length) t.general = true;
  t.deep = true;
  return t;
}

export function mergeTweaks(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'focus' || k === 'voiceRanges') out[k] = [...(out[k] || []), ...v];
    else if (k === 'difficultyDelta') out[k] = clamp((out[k] || 0) + v, -2, 2);
    else if (k === 'tempoFactor') out[k] = clamp((out[k] || 1) * v, 0.6, 1.5);
    else out[k] = v;
  }
  return out;
}

// Änderungen auf die Einstellungen eines Arrangements anwenden (rein: gibt neue Einstellungen zurück).
// info: { tempo (Vorlage), instruments: { id: Instrument } , writtenShift: (id) => halbtöne }
export function applyTweaks(optsIn, tweaks, info = {}) {
  const o = { ...optsIn };
  const keep = { ...(o.tweaks || {}) };
  const t = mergeTweaks(keep, tweaks);
  o.tweaks = t;
  if (t.melodyFirst) o.melodyFirst = true;
  if (t.adapt !== undefined) o.adapt = t.adapt;
  if (t.cleanHarmony) o.cleanHarmony = true;
  if (t.cleaner) o.cleaner = true;
  if (t.solo === 'none') o.solo = 'none';
  if (t.solo === 'short') o.length = 'short';
  if (t.drums === 'off') o.drums = false;
  if (t.drums === 'simpler') o.drumDifficulty = 2;
  if (t.bass) o.bassMode = t.bass;
  if (t.focus) o.focus = t.focus;
  if (t.difficultyDelta) {
    const cur = o.difficulty === 'auto' || o.difficulty === undefined || o.difficulty === null ? 3 : Number(o.difficulty);
    o.difficulty = clamp(cur + t.difficultyDelta, 1, 5);
    if (Array.isArray(o.voiceDifficulty)) o.voiceDifficulty = o.voiceDifficulty.map(() => null);
  }
  if (t.tempoFactor && info.tempo) o.tempo = Math.round((optsIn.tempo || info.tempo) * t.tempoFactor);
  if (t.voiceRanges && info.instruments) {
    const ranges = Array.isArray(o.ranges) ? [...o.ranges] : [];
    for (const r of t.voiceRanges) {
      const id = (o.voices || [])[r.voice];
      const inst = id ? info.instruments[id] : null;
      if (!inst) continue;
      const semis = inst.transpose?.semis || 0;
      const cur = ranges[r.voice] || {};
      if (r.dir === 'lower') ranges[r.voice] = { ...cur, hi: Math.round((cur.hi ?? inst.comfort[1] + semis) - 3) };
      else ranges[r.voice] = { ...cur, lo: Math.round((cur.lo ?? inst.comfort[0] + semis) + 3) };
    }
    o.ranges = ranges;
  }
  return o;
}
