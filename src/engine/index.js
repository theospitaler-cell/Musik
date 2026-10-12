// NoteCode Orchestrierungs-Engine – Einstieg.
//
//   orchestrate(input, { voices: 1..15, instruments?, title?, style? })
//     input: Material | Song (src/model/song.js) | Stems { vocals, bass, other, drums }
//     -> { arr, xml, report, validation, material }
//
// Ablauf: Stems -> Raster/Tempo/Tonart -> Material (Ticks) -> Besetzung N -> Linien & Sätze ->
// Satzregeln (Sprünge, Parallelen, Reibungen) -> Phrasierung (Übernahme, Atem, Verzahnung) ->
// Artikulation, Dynamik, Schreibweise -> MusicXML 4.0.
import { routeStems, analyzeStemAudio } from './stems.js';
import { parseWav } from '../input/stems.js';
import { compose, applySatzRegeln } from './compose.js';
import { applyHandoff, applyBreaths, interlock, markPhraseEnds } from './phrasing.js';
import { articulate, spellVoices, buildArrangement, exportScore, ensembleName, detectSections } from './engrave.js';
import { behaviorFor, applySustainCounters, applyMiniSolos, MODES, ACTIVITY_NAMES } from './behavior.js';
import { validateArrangement, summarize } from './validate.js';
import { sourceLinesOf } from '../arrange/original.js';
import { songMeasureTicks, transposeChordList } from '../model/song.js';
import { transposeKey } from '../theory/keys.js';
import { keyCenter } from '../theory/pitch.js';
import { chooseTransposition } from '../arrange/planner.js';
import { drumsFromNotes } from '../arrange/gen/drums.js';
import { newReport } from '../arrange/post.js';
import { ensembleFor } from './profiles.js';

export { routeStems, calibrateGrid, bandpass, filterBassNotes, suppressOvertones, decodeComping, detectDrumOnsets, analyzeStemAudio } from './stems.js';
export { estimateKey, keyTrack, spellPc, scaleSpelling, spellingIssues } from './tonality.js';
export { estimateTempo, plausibleTempo } from './tempo.js';
export { PROFILES, ENSEMBLES, ensembleFor, getProfile, fitPitch } from './profiles.js';
export { ENSEMBLE_PRESETS, defaultVoices, applyPreset, resizeEnsemble, matchPreset, presetForCount, slotInfo, describeInstrument, instrumentOptions, ensembleLabel } from './ensembles.js';
export { validateArrangement, summarize, ensembleName, exportScore, behaviorFor, MODES, ACTIVITY_NAMES };

// Basic Pitch (lokal, TensorFlow.js): Noten in Sekunden aus Mono-Audio
export async function basicPitchNotes(samples, sampleRate) {
  const { resampleMono } = await import('../input/audio.js');
  const { runBasicPitch, aiNotes } = await import('../input/ai-pitch.js');
  return aiNotes(await runBasicPitch(resampleMono([samples], sampleRate)));
}

// Demucs-Ausgabe (vocals/bass/other/drums.wav als Bytes) -> Stem-Satz für orchestrate()
//   files: { vocals, bass, other, drums } – Uint8Array je WAV; pitch ersetzt Basic Pitch (Tests)
export async function stemsFromWavs(files, { pitch = basicPitchNotes } = {}) {
  const { resampleMono } = await import('../input/audio.js');
  const stems = {};
  for (const name of ['vocals', 'bass', 'other', 'drums']) {
    if (!files[name]) continue;
    const wav = parseWav(files[name]);
    stems[name] = { samples: resampleMono(wav.channels, wav.sampleRate), sampleRate: 22050 };
  }
  if (!stems.drums) throw new Error('drums.wav fehlt – das Raster (Takt 1–4) kommt aus dem Schlagzeug-Stem');
  if (!stems.vocals && !stems.other) throw new Error('Weder vocals.wav noch other.wav vorhanden');
  return analyzeStemAudio(stems, { pitch });
}

const KICK = new Set([35, 36]);
const SNARE = new Set([38, 40, 37]);

// Song (aus loadSong) -> Material
export function materialFromSong(song, opts = {}) {
  const mt = songMeasureTicks(song);
  const lead = song.pickup ? mt : 0; // ein Auftakt-Takt wird vorangestellt
  const semis = Number(opts.shift) || 0; // Transposition in Halbtönen (bläserfreundliche Tonart)
  const shift = (n) => ({ start: n.start + lead, dur: n.dur, midi: n.midi + semis, vel: n.vel ?? null });
  const key = semis && song.key ? transposeKey(song.key, semis) : song.key;
  const src = sourceLinesOf(song);
  const tracks = (song.tracks || []).filter((t) => !t.mel && t.notes);
  const bassTrack = src.bass || [];
  const bassKey = new Set(bassTrack.map((n) => `${n.start}:${n.midi}`));
  const comp = tracks.flatMap((t) => t.notes).filter((n) => !bassKey.has(`${n.start}:${n.midi}`) && n.start + lead >= 0 && n.start < song.measureCount * mt);
  const drums = (song.drumNotes || []).map((d) => ({ start: d.start + lead, kind: KICK.has(d.midi) ? 'kick' : SNARE.has(d.midi) ? 'snare' : 'hat' }));
  return {
    title: opts.title || song.title,
    composer: song.composer || '',
    tempo: Number(opts.tempo) || song.tempo || 100,
    meter: song.meter,
    measureCount: song.measureCount + (lead ? 1 : 0),
    pickupBars: lead ? 1 : 0,
    lead: song.melody.filter((n) => n.start + lead >= 0).map(shift),
    bass: bassTrack.map(shift),
    comp: comp.map(shift),
    drums,
    chords: song.chords && !song.chordsDetected ? transposeChordList(song.chords, semis, key ? keyCenter(key) : null).map((c) => ({ ...c, start: c.start + lead })) : null,
    sections: song.sections && !song.sectionsDetected ? song.sections.map((s) => ({ ...s, start: s.start + (lead ? 1 : 0) })) : null,
    key: song.keyDetected ? null : key,
    transposeShift: semis,
    drumNotes: opts.drums ? (song.drumNotes || []).map((d) => ({ ...d, start: d.start + lead })) : null,
    report: { notes: [] },
  };
}

function toMaterial(input, opts) {
  if (input && input.lead && input.meter && input.measureCount) return input; // Material
  if (input && input.melody && input.meter) return materialFromSong(input, opts); // Song
  if (input && (input.vocals || input.other || input.bass)) {
    const m = routeStems(input, { title: opts.title, bpm: opts.bpm, beatsPerBar: opts.beatsPerBar });
    return m;
  }
  throw new Error('orchestrate: Eingabe ist weder Material, Song noch Stem-Satz');
}

// Oberflächen-Optionen (opts.voices = Instrument-IDs, transpose, tempo, drums, title) -> orchestrate().
// Das ist der Weg der Oberfläche: Analyse (Demucs-Spuren -> Basic Pitch -> Melodie, Bass, Begleitung,
// Groove im Song) -> Besetzung -> Satz -> Notensatz (MusicXML aus r.arr).
export function orchestrateFromOptions(song, o) {
  return orchestrate(song, {
    voices: o.voices.length,
    instruments: o.voices,
    title: o.title || undefined,
    transpose: o.transpose ?? 'auto',
    tempo: o.tempo || undefined,
    drums: !!o.drums,
    // Führung & Stimmendynamik: 'dynamic' (Standard) | 'classic', Aktivität der Nebenstimmen 1–5
    mode: o.orchMode || 'dynamic',
    activity: o.orchActivity ?? 3,
  });
}

// Eine Besetzung ohne Angaben: die Standardbesetzung der Engine für n Stimmen
export function defaultInstruments(n) {
  return ensembleFor(n).map((v) => v.profile);
}

export function orchestrate(input, opts = {}) {
  const N = opts.voices ?? (opts.instruments ? opts.instruments.length : 4);
  // Tonart: 'auto' = bläserfreundlich (wie im klassischen Arrangement), Zahl = Halbtöne
  let shift = 0;
  if (input && input.melody && input.meter && opts.transpose !== undefined && opts.transpose !== 0) {
    shift = chooseTransposition(input, opts.instruments || defaultInstruments(N), { transpose: opts.transpose });
  }
  const material = toMaterial(input, { ...opts, shift });
  const behavior = behaviorFor({ mode: opts.mode, activity: opts.activity });
  const score = compose(material, N, { ...opts, behavior });
  // Atem zuerst: die Lücken der Melodie stehen erst dann fest, wenn ihre Atempausen gesetzt sind
  applyBreaths(score);
  if (N >= 2 && behavior.dynamic) {
    // Lücken -> Einwürfe/Läufe/Gegenmelodien (Call-and-Response), Haltetöne -> Bewegung darunter,
    // dazu Mini-Solos. Im klassischen Modus bleibt die Melodie ganz bei der Lead-Stimme.
    applyHandoff(score, { minBeats: behavior.gapBeats, maxBars: behavior.answerBars });
    applySustainCounters(score, behavior);
    applyMiniSolos(score, behavior, detectSections(score.ctx));
  }
  // Satzregeln, Atem und Verzahnung greifen ineinander (ein gekürzter Ton macht Nachbarn zu neuen
  // Sprüngen, ein haltender Ton bildet einen neuen langen Lauf) – wiederholen bis nichts mehr dazukommt
  for (let round = 0; round < 4; round++) {
    applySatzRegeln(score);
    applyBreaths(score);
    if (!interlock(score)) break;
  }
  applySatzRegeln(score);
  markPhraseEnds(score);
  articulate(score);
  spellVoices(score);
  const arr = buildArrangement(score, { title: opts.title, composer: material.composer, N });
  arr.transposeShift = shift;
  // Schlagzeug (optional): die erkannten Schläge der Vorlage 1:1 auf das Raster
  if (opts.drums && material.drumNotes && material.drumNotes.length) {
    const total = arr.totalBars * arr.mt;
    const events = drumsFromNotes(material.drumNotes, { offset: 0, totalTicks: total, beat: arr.beat });
    if (events.length) arr.drums = { name: 'Schlagzeug', events, dirs: [] };
  } else if (opts.drums) arr.report.notes = [...arr.report.notes, 'Die Vorlage enthält kein erkanntes Schlagzeug – es gibt keine Drum-Stimme.'];
  // Prüfbericht im Format der Arrangement-Schicht (Regieplan/Prüfbericht der Oberfläche)
  const rep = newReport();
  rep.parallelsFound = rep.parallelsFixed = score.report.repairs.perfects;
  rep.rangeFixes = score.report.repairs.leaps;
  rep.breaths = score.report.breaths.length;
  rep.notes = arr.report.notes;
  arr.report = rep;
  const validation = validateArrangement(arr);
  arr.engine.validation = validation;
  const report = {
    voices: N,
    ensemble: ensembleName(N),
    repairs: score.report.repairs,
    fills: score.report.fills.length,
    mode: behavior.mode,
    activity: behavior.activity,
    solos: score.report.fills.filter((f) => f.kind === 'solo').length,
    sustains: score.report.fills.filter((f) => f.kind === 'sustain').length,
    breaths: score.report.breaths.length,
    notes: arr.report.notes,
    violations: summarize(validation),
  };
  return { arr, material, report, validation, xml: (o = {}) => exportScore(arr, o) };
}
