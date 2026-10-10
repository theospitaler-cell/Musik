// Lead-Erkennung: welche Spur trägt die Hauptmelodie (Gesang / Lead)?
// Rein lokal & deterministisch. Merkmale je Spur:
//  - Einstimmigkeit (Melodien sind überwiegend einstimmig, Begleitungen greifen Akkorde)
//  - Lage (Melodie liegt meist zwischen g und c''', Bass deutlich tiefer)
//  - Melodiedichte (Töne pro aktivem Takt: Melodie moderat, Arpeggien/Hi-Hat-artige Spuren sehr dicht)
//  - Präsenz über das Stück (Melodie trägt große Teile des Songs)
//  - Name & Instrument (Vocal/Lead/Melodie, GM-Programm Gesang/Lead-Synth/Bläser)
//  - Partitur-Konvention (MusicXML: oberste Stimme = meist Melodie)

const NAME_LEAD = /(vocal|voice|vox|melod|lead|gesang|singstimme|sing|solo|tune|hauptstimme|topline|sopran)/i;
const NAME_ACC = /(bass|drum|perc|schlag|pad|chord|akkord|comp|rhythm|begleit|accomp|strings?\b|streicher|arp|harm)/i;

function programBonus(p) {
  if (p === null || p === undefined) return 0;
  if (p >= 52 && p <= 54) return 2.5; // Chor/Stimme
  if (p >= 80 && p <= 87) return 1.5; // Lead-Synth
  if (p === 56 || p === 59 || (p >= 64 && p <= 68) || (p >= 71 && p <= 79) || p === 40) return 1; // Trompete, Saxe, Oboe, Flöten, Violine
  if (p >= 32 && p <= 39) return -4; // Bass
  if (p >= 88 && p <= 103) return -2; // Pads/FX
  if (p >= 48 && p <= 51) return -1; // Streicher-Ensemble
  if (p <= 7 || (p >= 24 && p <= 31)) return -0.5; // Klavier/Gitarre (oft Begleitung)
  return 0;
}

// notes: [{start, dur, midi}] (Ticks); opts: {name, program, index, mt, totalTicks}
export function leadScore(notes, { name = '', program = null, index = 0, mt = 96, totalTicks = null } = {}) {
  if (!notes.length) return -Infinity;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  // Einstimmigkeit: Anteil der Anschläge ohne gleichzeitigen zweiten Ton
  const byStart = new Map(); // Anschlag -> {count, top}
  for (const n of sorted) {
    const x = byStart.get(n.start);
    if (x) {
      x.count++;
      x.top = Math.max(x.top, n.midi);
    } else byStart.set(n.start, { count: 1, top: n.midi });
  }
  const onsets = byStart.size;
  const monoOnsets = [...byStart.values()].filter((x) => x.count === 1).length;
  const mono = monoOnsets / onsets;
  // Lage: Median der Tonhöhen (höchster Ton je Anschlag)
  const tops = [...byStart.values()].map((x) => x.top).sort((a, b) => a - b);
  const med = tops[Math.floor(tops.length / 2)];
  let pitch = 0;
  if (med >= 60 && med <= 79) pitch = 2;
  else if (med >= 55 && med < 60) pitch = 1;
  else if (med > 79 && med <= 86) pitch = 0.5;
  else if (med < 50) pitch = -4;
  else if (med < 55) pitch = -1.5;
  else pitch = -1;
  // Dichte & Präsenz
  const bars = new Set(sorted.map((n) => Math.floor(n.start / mt)));
  const perBar = onsets / Math.max(1, bars.size);
  const totalBars = totalTicks ? Math.max(1, Math.ceil(totalTicks / mt)) : Math.max(...bars) + 1;
  const presence = bars.size / totalBars;
  let density = 0;
  if (perBar > 12) density = -2;
  else if (perBar > 9) density = -1;
  else if (perBar < 1.2) density = -1; // nur Liegetöne
  else density = 0.5;
  // gleichförmiger Rhythmus (z. B. durchgehende Achtel-Begleitung) ist eher Begleitung
  const iois = [];
  const starts = [...byStart.keys()];
  for (let i = 1; i < starts.length; i++) iois.push(starts[i] - starts[i - 1]);
  const variety = new Set(iois).size / Math.max(1, Math.min(iois.length, 8));
  let score = 4 * mono + pitch + density + 1.2 * Math.min(1, presence * 1.3) + 0.6 * Math.min(1, variety) + med * 0.015;
  if (NAME_LEAD.test(name || '')) score += 4;
  if (NAME_ACC.test(name || '')) score -= 3;
  score += programBonus(program);
  if (index === 0) score += 0.4; // Partitur/MIDI-Konvention: Melodie oft zuerst
  return score;
}

// parts: [{notes, name, program, index}] -> Index der besten Lead-Spur
export function pickLead(parts, { mt = 96, totalTicks = null, firstBonus = 0 } = {}) {
  let best = null;
  for (const p of parts) {
    if (!p.notes || !p.notes.length) continue;
    let s = leadScore(p.notes, { name: p.name, program: p.program, index: p.index, mt, totalTicks });
    if (p.index === 0) s += firstBonus;
    if (!best || s > best.score) best = { index: p.index, score: s };
  }
  return best ? best.index : parts[0]?.index ?? 0;
}
