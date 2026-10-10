// Regieplan: Formübersicht, Rollen je Stimme, Effekte, Qualitätsbericht.
import { ROLE_NAMES } from '../arrange/planner.js';
import { keyNameDe } from '../theory/keys.js';
import { printedMeasures } from './form.js';

export function buildPlan(arr) {
  const rows = [];
  for (const b of arr.blocks) {
    for (const seg of b.segments) {
      if (seg.copyOfSeg !== undefined) continue;
      rows.push({
        rehearsal: seg.startBar === 0 ? b.rehearsal || '' : '',
        name: seg.startBar === 0 ? b.name : '',
        bars: `${b.startBar + seg.startBar + 1}–${b.startBar + seg.startBar + (seg.repeatTimes ? seg.bars * seg.repeatTimes : seg.bars)}`,
        length: seg.bars * (seg.repeatTimes || 1),
        key: keyNameDe(b.key),
        dyn: b.dyn,
        roles: seg.roles.map((r) => ROLE_NAMES[r] || r),
        rawRoles: seg.roles,
        note: (seg.note || '') + (seg.repeatTimes ? ` (${seg.repeatTimes}×)` : '') + (b.copyOf !== undefined ? ' – D.S.-Durchgang (wie oben)' : ''),
        copy: b.copyOf !== undefined,
      });
    }
  }
  const printed = printedMeasures(arr);
  const r = arr.report;
  const fxList = Object.entries(r.fx)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${FX_NAMES[k] || k}: ${n}`);
  return {
    title: arr.meta.title,
    style: arr.style.name,
    key: keyNameDe(arr.key),
    tempo: `${arr.meta.tempoText} (♩ = ${arr.tempo})`,
    meter: `${arr.meter.beats}/${arr.meter.beatType}`,
    instruments: arr.voices.map((v, i) => `Stimme ${i + 1}: ${v.inst.name}`).concat(arr.drums ? ['Schlagzeug'] : []),
    bars: arr.totalBars,
    printedBars: printed.length,
    transpose: arr.transposeShift,
    form: arr.form,
    rows,
    quality: [
      `Lange Melodietöne mit Bewegung in den Mittelstimmen: ${r.longNotesCovered}/${r.longNotes}${r.fillsInjected ? ` (davon ${r.fillsInjected} automatisch ergänzt)` : ''}`,
      `Quint-/Oktavparallelen: ${r.parallelsFound} gefunden, ${r.parallelsFixed} korrigiert`,
      `Atempausen für Bläser eingefügt: ${r.breaths}`,
      `Tonumfang-Korrekturen: ${r.rangeFixes}`,
      `Spezialeffekte: ${fxList.length ? fxList.join(', ') : '–'}`,
    ],
    warnings: arr.song.warnings || [],
  };
}

const FX_NAMES = {
  falloff: 'Fall-offs',
  doit: 'Doits',
  scoop: 'Scoops',
  gliss: 'Glissandi (Zugphysik geprüft)',
  shake: 'Shakes',
  rip: 'Horn-Rips',
  stopped: 'gestopfte Horntöne',
  pizz: 'Pizzicato-Passagen',
  doubleStops: 'Doppelgriffe',
  mutes: 'Dämpfer-Wechsel',
};

export function planMarkdown(arr) {
  const p = buildPlan(arr);
  const L = [];
  L.push(`# Regieplan – ${p.title}`, '');
  L.push(`- **Stil:** ${p.style}`, `- **Tonart:** ${p.key}${p.transpose ? ` (transponiert um ${p.transpose > 0 ? '+' : ''}${p.transpose} Halbtöne, bläserfreundlich)` : ''}`, `- **Tempo:** ${p.tempo}`, `- **Taktart:** ${p.meter}`, `- **Länge:** ${p.bars} Takte gespielt, ${p.printedBars} Takte gedruckt`, '');
  L.push('## Besetzung', ...p.instruments.map((x) => `- ${x}`), '');
  L.push('## Formverlauf', '', '| Buchst. | Teil | Takte | Tonart | Dyn. | St. 1 | St. 2 | St. 3 | St. 4 | Hinweis |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of p.rows) L.push(`| ${r.rehearsal} | ${r.name} | ${r.bars} | ${r.key} | ${r.dyn} | ${r.roles.join(' | ')} | ${r.note} |`);
  if (p.form && p.form.segnoBar !== null) L.push('', `**Sprünge:** Nach dem Solo *D.S. al Coda* – zurück zum Segno (Takt ${p.form.segnoBar + 1}), bei *To Coda* in die Coda springen.`);
  L.push('', '## Qualitätsbericht', ...p.quality.map((x) => `- ${x}`));
  if (p.warnings.length) L.push('', '## Hinweise zur Vorlage', ...p.warnings.map((x) => `- ${x}`));
  return L.join('\n') + '\n';
}
