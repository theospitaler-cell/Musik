// Stimmen dazuschreiben: das Notenblatt ist die Hauptstimme (Töne 1:1), die Orchestrierung schreibt die
// weiteren Stimmen für die gewählten Instrumente (Besetzungs-Schema der Einstellungen).
import { INSTRUMENTS } from '../arrange/instruments.js';
import { songFromMusicXML } from '../input/musicxml.js';
import { orchestrate } from '../engine/index.js';
import { transposeXml, analyzeXml } from './transpose.js';
import { readScore, writeScore, partsOf, el, removeChildren } from './xml.js';

// Das Blatt in klingende Tonhöhen bringen (die Orchestrierung arbeitet mit klingenden Tönen). Hat die Stimme
// ein <transpose>, übernimmt der Import die Umrechnung; sonst gilt die Notierung für sourceId.
export function toConcertXml(xml, sourceId) {
  const info = analyzeXml(xml);
  const hasTranspose = info.parts.some((p) => p.transposeSemis !== 0);
  if (hasTranspose) return xml;
  const semis = sourceId && INSTRUMENTS[sourceId] ? INSTRUMENTS[sourceId].transpose.semis : 0;
  if (!semis) return xml;
  return transposeXml(xml, { chromatic: -semis }).xml;
}

// opts: { sourceId: Instrument, für das das Blatt notiert ist | 'concert', lead: Instrument der Hauptstimme,
//         voices: [Instrument-IDs der weiteren Stimmen], mode: 'dynamic'|'classic', activity: 1–5, title,
//         melody: 'auto' (wie bisher) | 'none' (nur Begleitung) | 'share' (Melodie anteilig mitspielen)
//                 | 'solo' (Solos anteilig an andere Stimmen übergeben, die Hauptstimme begleitet dann),
//         shares: [Prozent der Takte je Stimme in der Reihenfolge von voices] }
export function addVoices(xml, opts) {
  const { sourceId = 'concert', lead = null, voices = [], mode = 'dynamic', activity = 3, title = '', melody = 'auto', shares = [] } = opts;
  const leadId = lead && INSTRUMENTS[lead] ? lead : sourceId !== 'concert' && INSTRUMENTS[sourceId] ? sourceId : 'trumpet';
  const list = voices.filter((v) => INSTRUMENTS[v]);
  if (!list.length) throw new Error('Bitte mindestens eine weitere Stimme wählen');
  const concert = toConcertXml(xml, sourceId);
  const song = songFromMusicXML(concert);
  if (title) song.title = title;
  const instruments = [leadId, ...list];
  // Melodieanteil: 'none' = alle Nebenstimmen nur Begleitung, 'share' = je Stimme ein Prozentwert (die Auswahl
  // der Stimmen kann Plätze auslassen – die Prozente gehören zur Stimme, nicht zum Platz)
  let melodyShare;
  let soloShare;
  const picked = voices.map((v, i) => (INSTRUMENTS[v] ? Number(shares[i]) || 0 : null)).filter((x) => x !== null);
  if (melody === 'none') melodyShare = instruments.map(() => 0);
  else if (melody === 'share') melodyShare = [0, ...picked];
  else if (melody === 'solo') {
    // Soli: Doppler spielen Begleitung (kein Melodieanteil), die Übergabe passiert nur in den Solo-Takten
    melodyShare = instruments.map(() => 0);
    soloShare = [0, ...picked];
  }
  const r = orchestrate(song, { voices: instruments.length, instruments, transpose: 0, mode, activity, title: song.title, melodyShare, soloShare });
  return { xml: r.xml(), report: r.report, validation: r.validation, instruments, arr: r.arr, melodyShare, soloShare };
}

// Eine Stimme eines mehrstimmigen Blatts als eigenes Blatt herausziehen (für Bibliothek/Partitur)
export function extractPart(xml, partId) {
  const root = readScore(xml);
  const parts = partsOf(root);
  const part = parts.find((p) => p.attrs.id === partId) || parts[0];
  if (!part) throw new Error('Stimme nicht gefunden');
  const list = root.get('part-list');
  if (list) {
    list.children = list.children.filter((c) => c.name !== 'score-part' || c.attrs.id === part.attrs.id);
    removeChildren(list, 'part-group');
  }
  root.children = root.children.filter((c) => c.name !== 'part' || c === part);
  void el;
  return writeScore(root);
}

export function listParts(xml) {
  return analyzeXml(xml).parts.map((p) => ({ id: p.id, name: p.name, clef: p.clef, notes: p.notes, lowest: p.lowest, highest: p.highest }));
}
