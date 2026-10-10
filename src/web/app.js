// NoteCode – App-Steuerung (Oberfläche).
import { INSTRUMENTS, PRESETS, FAMILIES, writtenRangeChoices } from '../arrange/instruments.js';
import { DIFFICULTY_LEVELS } from '../arrange/difficulty.js';
import { STYLE_LIST } from '../arrange/styles.js';
import { loadSong, detectFormat } from '../input/index.js';
import { arrange } from '../arrange/engine.js';
import { playAlongSources, defaultPlayParts } from '../arrange/playalong.js';
import { decodeAudio, analyzeAudio } from './audio-import.js';
import { platform, localVersion, checkUpdate, applyUpdate } from './updater.js';
import { exportMusicXML } from '../output/musicxml.js';
import { exportMidi } from '../output/midi.js';
import { buildPlan, planMarkdown } from '../output/report.js';
import { printedMeasures, timelineToPrinted } from '../output/form.js';
import { zip } from '../core/zip.js';
import { keyNameDe, transposeKey } from '../theory/keys.js';
import { Player } from './player.js';
import { ScoreFollower } from './follow.js';
import { bindPractice, syncPractice } from './practice.js';
import { openAudioExport } from './audio-dialog.js';
import { renderPages, responsiveSvg, pagesToPngs, xmlsToPdf, loadVerovio } from './render.js';
import { LocalStore, Library } from './store.js';
import { loadSettings, saveSettings } from './settings.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const VOICE_COLORS = ['#1f3a5f', '#4f6d8f', '#8a6a2f', '#5b5f66', '#2f7d4f'];
const STYLE_TAG = { auto: 'Passend zum Song', funk: 'Funk', secondline: 'New Orleans', swing: 'Jazz', ballad: 'Pop', classical: 'Klassik', polka: 'Blasmusik' };

const S = {
  audioUrl: null,
  settings: null,
  library: null,
  local: null,
  source: null,
  song: null,
  opts: null,
  arr: null,
  view: 'score',
  zoom: 1,
  player: null,
  currentId: null,
  measureEls: [],
  printed: [],
  t2p: () => null,
  renderToken: 0,
  follower: null, // Mitlesen: Takt-Markierung, Cursor, automatisches Umblättern
};

// ---------------------------------------------------------------- Hilfen
// Hinweis unten/oben; optional mit Aktion (z. B. "Rückgängig")
function toast(msg, kind = '', action = null) {
  const t = document.createElement('div');
  t.className = `toast ${kind}${action ? ' has-action' : ''}`;
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  const close = () => {
    t.style.transition = 'opacity .3s, transform .3s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(16px)';
    setTimeout(() => t.remove(), 320);
  };
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      action.run();
      close();
    });
    t.appendChild(b);
  }
  $('#toasts').appendChild(t);
  setTimeout(close, action ? 6000 : kind === 'error' ? 5200 : 2600);
}

// ---------------------------------------------------------------- Fortschritt
// Eine Anzeige für alles, was dauert: Datei lesen, Audio analysieren, Arrangieren,
// Noten setzen, Exportieren. Ein neuer Vorgang übernimmt die Anzeige.
let progressJob = 0;
function progress(title) {
  const id = ++progressJob;
  const box = $('#progress');
  $('#pg-title').textContent = title;
  $('#pg-text').textContent = '';
  box.classList.remove('hidden');
  const api = {
    set(text, frac = null) {
      if (id !== progressJob) return api;
      if (text !== undefined && text !== null) $('#pg-text').textContent = text;
      const ind = frac === null || frac === undefined;
      box.classList.toggle('indeterminate', ind);
      $('#pg-fill').style.width = ind ? '' : `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
      $('#pg-pct').textContent = ind ? '' : `${Math.round(Math.max(0, Math.min(1, frac)) * 100)} %`;
      return api;
    },
    title(t) {
      if (id === progressJob) $('#pg-title').textContent = t;
      return api;
    },
    done() {
      if (id === progressJob) box.classList.add('hidden');
    },
  };
  return api.set('', 0);
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => reject(fr.error || new Error('Datei konnte nicht gelesen werden'));
    fr.readAsArrayBuffer(file);
  });
}

// Handy-App (Android): Datei über "Teilen" speichern – WebViews können keine Downloads
let capPlugins = null;
async function nativeSave(name, blob) {
  const cap = window.Capacitor;
  capPlugins = capPlugins || { fs: cap.registerPlugin('Filesystem'), share: cap.registerPlugin('Share') };
  const b64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
  const res = await capPlugins.fs.writeFile({ path: name, data: b64, directory: 'CACHE' });
  await capPlugins.share.share({ title: name, url: res.uri, dialogTitle: 'Speichern oder teilen' });
}

function download(name, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  if (window.Capacitor?.isNativePlatform?.()) {
    nativeSave(name, blob).catch((e) => !/cancel/i.test(e.message || '') && toast('Speichern fehlgeschlagen: ' + e.message, 'error'));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function safeName(s) {
  return (s || 'NoteCode').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 60);
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function serializeSource(src) {
  if (!src) return null;
  // Audio: die Analyse wird gespeichert (synchronisiert), die Aufnahme selbst nur lokal
  if (src.format === 'audio') return { name: src.name, format: 'audio', audioId: src.audioId, song: src.song };
  if (typeof src.data === 'string') return { name: src.name, format: src.format, text: src.data, melodyPart: src.melodyPart ?? null };
  return { name: src.name, format: src.format, b64: bytesToB64(new Uint8Array(src.data)), melodyPart: src.melodyPart ?? null };
}
function deserializeSource(s) {
  if (!s) return null;
  if (s.format === 'audio') return { ...s };
  return { name: s.name, format: s.format, data: s.text ?? b64ToBytes(s.b64), melodyPart: s.melodyPart ?? null };
}

// ---------------------------------------------------------------- Navigation
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'library') renderLibrary();
  if (name === 'settings') renderSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------- Instrumente
function instrumentSelect(value, onChange) {
  const sel = document.createElement('select');
  const groups = {};
  for (const inst of Object.values(INSTRUMENTS)) {
    if (!groups[inst.family]) {
      groups[inst.family] = document.createElement('optgroup');
      groups[inst.family].label = FAMILIES[inst.family] || inst.family;
      sel.appendChild(groups[inst.family]);
    }
    const o = document.createElement('option');
    o.value = inst.id;
    o.textContent = inst.name;
    groups[inst.family].appendChild(o);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

// Notenname (notiert), deutsch mit Helmholtz-Oktaven + international
const DE_NAMES = ['c', 'des', 'd', 'es', 'e', 'f', 'fis', 'g', 'as', 'a', 'b', 'h'];
const SCI_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
function noteLabel(m) {
  const pc = ((m % 12) + 12) % 12;
  const oct = Math.floor(m / 12) - 1;
  let de = DE_NAMES[pc];
  if (oct >= 3) de = de + "'".repeat(oct - 3);
  else de = de[0].toUpperCase() + de.slice(1) + ','.repeat(Math.max(0, 2 - oct));
  return `${de} (${SCI_NAMES[pc]}${oct})`;
}

function difficultyOptions(sel, value, { auto = 'Automatisch', inherit = null } = {}) {
  sel.innerHTML = '';
  const add = (v, t) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    sel.appendChild(o);
  };
  if (inherit) add('', inherit);
  else add('auto', auto);
  for (const d of DIFFICULTY_LEVELS) add(String(d.value), d.name);
  sel.value = value === null || value === undefined ? (inherit ? '' : 'auto') : String(value);
}

// Feineinstellung pro Stimme: Schwierigkeit, tiefster & höchster Ton (notiert)
function voiceExtras(slot, i, instId, { difficulty = true } = {}) {
  const ex = document.createElement('div');
  ex.className = 'slot-extra' + (difficulty ? '' : ' no-diff');
  if (difficulty) {
    const lvl = document.createElement('select');
    lvl.title = 'Schwierigkeit dieser Stimme';
    difficultyOptions(lvl, S.opts.voiceDifficulty?.[i] ?? null, { inherit: 'Schwierigkeit: wie oben' });
    lvl.addEventListener('change', () => {
      S.opts.voiceDifficulty = S.opts.voiceDifficulty || [null, null, null, null];
      S.opts.voiceDifficulty[i] = lvl.value ? Number(lvl.value) : null;
      lvl.classList.toggle('set', !!lvl.value);
    });
    lvl.classList.toggle('set', !!lvl.value);
    ex.appendChild(lvl);
  }
  if (instId !== 'drums') {
    const inst = INSTRUMENTS[instId];
    const ch = writtenRangeChoices(inst);
    const mk = (kind) => {
      const sel = document.createElement('select');
      sel.title = kind === 'lo' ? 'Tiefster Ton (notiert)' : 'Höchster Ton (notiert)';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = kind === 'lo' ? '↓ tief: Auto' : '↑ hoch: Auto';
      sel.appendChild(auto);
      const list = [];
      for (let m = ch.min; m <= ch.max; m++) list.push(m);
      if (kind === 'hi') list.reverse();
      for (const m of list) {
        const o = document.createElement('option');
        o.value = String(m);
        o.textContent = `${kind === 'lo' ? '↓' : '↑'} ${noteLabel(m)}`;
        sel.appendChild(o);
      }
      const cur = S.opts.ranges?.[i]?.[kind];
      sel.value = cur === null || cur === undefined ? '' : String(cur);
      sel.classList.toggle('set', !!sel.value);
      sel.addEventListener('change', () => {
        S.opts.ranges = S.opts.ranges || [null, null, null, null];
        const r = { ...(S.opts.ranges[i] || { lo: null, hi: null }) };
        r[kind] = sel.value ? Number(sel.value) : null;
        S.opts.ranges[i] = r.lo === null && r.hi === null ? null : r;
        sel.classList.toggle('set', !!sel.value);
      });
      return sel;
    };
    ex.appendChild(mk('lo'));
    ex.appendChild(mk('hi'));
  }
  slot.appendChild(ex);
}

function renderVoiceGrid(container, voices, onChange, { extras = false } = {}) {
  container.innerHTML = '';
  voices.forEach((id, i) => {
    const slot = document.createElement('div');
    slot.className = 'voice-slot';
    const lab = document.createElement('div');
    lab.className = 'vlabel';
    lab.innerHTML = `<i style="background:${VOICE_COLORS[i]}"></i>Stimme ${i + 1} · ${['Sopran', 'Alt', 'Tenor', 'Bass'][i]}`;
    slot.appendChild(lab);
    slot.appendChild(
      instrumentSelect(id, (v) => {
        voices[i] = v;
        // neues Instrument -> Tonumfang wieder automatisch
        if (extras && S.opts.ranges) S.opts.ranges[i] = null;
        onChange(voices);
        if (extras) renderVoiceGrid(container, voices, onChange, { extras });
      }),
    );
    if (extras) voiceExtras(slot, i, id);
    container.appendChild(slot);
  });
}

function renderSoloGrid() {
  const box = $('#solo-grid');
  box.innerHTML = '';
  const slot = document.createElement('div');
  slot.className = 'voice-slot';
  slot.innerHTML = '<div class="vlabel"><i style="background:' + VOICE_COLORS[0] + '"></i>Solo-Instrument</div>';
  const sel = instrumentSelect(S.opts.soloInstrument === 'drums' ? 'trumpet' : S.opts.soloInstrument, () => {});
  const drumOpt = document.createElement('optgroup');
  drumOpt.label = 'Rhythmus';
  drumOpt.innerHTML = '<option value="drums">Schlagzeug</option>';
  sel.appendChild(drumOpt);
  sel.value = S.opts.soloInstrument || 'trumpet';
  sel.addEventListener('change', () => {
    S.opts.soloInstrument = sel.value;
    if (S.opts.ranges) S.opts.ranges[0] = null;
    renderSoloGrid();
  });
  slot.appendChild(sel);
  voiceExtras(slot, 0, S.opts.soloInstrument || 'trumpet', { difficulty: false });
  box.appendChild(slot);
}

// ---------------------------------------------------------------- Schlagzeug
function setDrumMode(mode) {
  S.opts.drumMode = mode;
  $$('#drum-mode .seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#drum-mode-info').textContent =
    mode === 'own'
      ? 'Eigener Rhythmus im Charakter des Songs: gleicher Groove & gleiche Form – je nach Schwierigkeit einfacher oder mit mehr Noten, Ghost-Notes und schwierigeren Fills.'
      : 'Das Schlagzeug der Aufnahme bzw. Datei wird Takt für Takt übernommen – Grooves, Fills, Crashes.';
  $('#drum-fills-row').classList.toggle('hidden', mode === 'own');
}

// ---------------------------------------------------------------- Solo: Playback
function setPlayback(on) {
  S.opts.playback = !!on;
  updatePlaybackUi();
}
function updatePlaybackUi() {
  const on = !!S.opts.playback;
  $('#opt-playback').checked = on;
  const drums = S.opts.ensemble === 'drums';
  const solo = S.opts.ensemble === 'solo' && on;
  const pb = solo || drums;
  $('#solo-free').classList.toggle('hidden', on);
  $('#solo-playback').classList.toggle('hidden', !on);
  $$('.free-only').forEach((el) => el.classList.toggle('hidden', pb));
  $$('.playback-only').forEach((el) => el.classList.toggle('hidden', !pb));
  $('#generate span').textContent = drums ? 'Schlagzeug-Noten erstellen' : solo ? 'Playback-Noten erstellen' : 'Arrangement erstellen';
  if (solo) renderPlaybackList();
}

// gewählte Stimmen in der Reihenfolge der Quellen (Melodie, Spuren, Schlagzeug)
function currentPlayParts(sources) {
  const ids = new Set(sources.map((x) => x.id));
  let parts = (S.opts.playParts || []).filter((p) => ids.has(p.source));
  if (!parts.length) parts = defaultPlayParts(S.opts).filter((p) => ids.has(p.source));
  return sources.map((src) => parts.find((p) => p.source === src.id)).filter(Boolean);
}

function renderPlaybackList() {
  const box = $('#pb-list');
  box.innerHTML = '';
  if (!S.song) {
    box.innerHTML = '<div class="pb-empty">Lade zuerst einen Song – dann erscheinen hier seine Stimmen (Gesang, Bass, Gitarre, Schlagzeug …) zur Auswahl.</div>';
    $('#pb-fills-row').classList.add('hidden');
    return;
  }
  const sources = playAlongSources(S.song);
  const parts = currentPlayParts(sources);
  S.opts.playParts = parts;
  const setParts = (next) => {
    S.opts.playParts = sources.map((src) => next.find((p) => p.source === src.id)).filter(Boolean);
    // Stimmen-Reihenfolge ändert sich -> Feineinstellungen zurücksetzen
    S.opts.voiceDifficulty = [];
    S.opts.ranges = [];
    renderPlaybackList();
  };
  const melodic = parts.filter((p) => p.inst !== 'drums');
  for (const src of sources) {
    const part = parts.find((p) => p.source === src.id);
    const row = document.createElement('div');
    row.className = 'pb-item' + (part ? ' on' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!part;
    cb.title = 'Diese Stimme übernehmen';
    const name = document.createElement('div');
    name.className = 'pb-name';
    name.innerHTML = `${src.name}${src.count ? `<small>${src.count} ${src.kind === 'drums' ? 'Schläge' : 'Noten'}</small>` : ''}`;
    row.append(cb, name);
    const defInst = src.kind === 'drums' ? 'drums' : src.suggest || (S.opts.soloInstrument !== 'drums' ? S.opts.soloInstrument : null) || 'trumpet';
    cb.addEventListener('change', () => {
      const others = parts.filter((p) => p.source !== src.id);
      setParts(cb.checked ? [...others, { source: src.id, inst: defInst }] : others);
    });
    const target = document.createElement('div');
    target.className = 'pb-target';
    if (src.kind === 'drums') {
      target.innerHTML = '<span>→ Schlagzeug (Drum-Chart)</span>';
    } else {
      const lab = document.createElement('span');
      lab.textContent = '→';
      const sel = instrumentSelect(part ? part.inst : defInst, (v) => {
        const next = parts.filter((p) => p.source !== src.id);
        next.push({ source: src.id, inst: v });
        if (S.opts.ranges) S.opts.ranges[melodic.findIndex((p) => p.source === src.id)] = null;
        setParts(next);
      });
      sel.disabled = !part;
      target.append(lab, sel);
    }
    row.appendChild(target);
    if (part) {
      const idx = part.inst === 'drums' ? melodic.length : melodic.indexOf(part);
      voiceExtras(row, idx, part.inst);
    }
    box.appendChild(row);
  }
  $('#pb-fills-row').classList.toggle('hidden', !parts.some((p) => p.inst === 'drums'));
}

function setEnsemble(ens) {
  S.opts.ensemble = ens;
  $$('#ensemble-tabs .seg').forEach((b) => b.classList.toggle('active', b.dataset.ens === ens));
  $$('.ens-panel').forEach((p) => p.classList.toggle('active', p.dataset.enspanel === ens));
  const solo = ens === 'solo';
  const drums = ens === 'drums';
  updatePlaybackUi(); // Schlagzeug: immer Playback – Stil & Form spielen keine Rolle
  void drums;
  $('#solo-label').textContent = solo ? 'Solo-Teil' : 'Hauptsolo';
  const sel = $('#opt-solo');
  const prev = sel.value;
  if (solo) {
    sel.innerHTML = '<option value="0">Mit ausgeschriebenem Solo</option><option value="none">Ohne Solo-Teil</option>';
    sel.value = prev === 'none' ? 'none' : '0';
    renderSoloGrid();
  } else fillSoloSelect(sel, S.opts.voices, prev && prev !== 'none' ? prev : S.opts.solo ?? 0);
}

function fillSoloSelect(sel, voices, value) {
  sel.innerHTML = '';
  voices.forEach((id, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `Stimme ${i + 1} – ${INSTRUMENTS[id].name}`;
    sel.appendChild(o);
  });
  for (const [v, t] of [
    ['rotate', 'Rotierend (alle Stimmen)'],
    ['none', 'Kein Solo'],
  ]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    sel.appendChild(o);
  }
  sel.value = String(value);
}

function fillTransposeSelect() {
  const sel = $('#opt-transpose');
  const prev = sel.value || (S.settings.transposeAuto ? 'auto' : '0');
  sel.innerHTML = '';
  const add = (v, t) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    sel.appendChild(o);
  };
  add('auto', 'Automatisch (bläserfreundlich)');
  const k = S.song?.key;
  add('0', `Original${k ? ` (${keyNameDe(k)})` : ''}`);
  for (const d of [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6]) add(String(d), `${d > 0 ? '+' : ''}${d} Halbtöne${k ? ` → ${keyNameDe(transposeKey(k, d))}` : ''}`);
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'auto';
}

// ---------------------------------------------------------------- Optionen
function readOpts() {
  const solo = $('#opt-solo').value;
  const tempo = Number($('#opt-tempo').value) || null;
  const tr = $('#opt-transpose').value;
  return {
    voices: [...S.opts.voices],
    style: S.opts.style,
    drums: $('#opt-drums').checked,
    solo: solo === 'rotate' || solo === 'none' ? solo : Number(solo),
    length: 'normal', // immer ca. Originallänge
    adapt: Number($('#opt-adapt').value),
    form: $('#opt-form').value,
    tempo,
    transpose: tr === 'auto' ? 'auto' : Number(tr),
    seed: Number($('#opt-seed').value) || 1,
    ensemble: S.opts.ensemble || 'quartet',
    drumMode: S.opts.drumMode || 'original',
    soloInstrument: S.opts.soloInstrument || 'trumpet',
    difficulty: $('#opt-difficulty').value === 'auto' ? 'auto' : Number($('#opt-difficulty').value),
    voiceDifficulty: [...(S.opts.voiceDifficulty || [null, null, null, null])],
    ranges: [...(S.opts.ranges || [null, null, null, null])],
    playback: !!S.opts.playback,
    title: S.opts.title || null,
    playParts: S.opts.playParts ? S.opts.playParts.map((p) => ({ ...p })) : null,
    drumFills: S.opts.ensemble === 'drums' ? $('#opt-drum-fills').checked : $('#opt-fills').checked,
  };
}

function applyOptsToUi(o) {
  S.opts = { ...S.opts, ...o };
  S.opts.voiceDifficulty = S.opts.voiceDifficulty || [null, null, null, null];
  S.opts.ranges = S.opts.ranges || [null, null, null, null];
  renderVoiceGrid(
    $('#voice-grid'),
    S.opts.voices,
    (v) => {
      S.opts.voices = v;
      if (S.opts.ensemble !== 'solo') fillSoloSelect($('#opt-solo'), v, $('#opt-solo').value);
      markPreset();
    },
    { extras: true },
  );
  difficultyOptions($('#opt-difficulty'), S.opts.difficulty ?? 'auto');
  difficultyOptions($('#opt-solo-difficulty'), S.opts.difficulty ?? 'auto');
  difficultyOptions($('#opt-drum-difficulty'), S.opts.difficulty ?? 'auto');
  setDrumMode(S.opts.drumMode || 'original');
  fillSoloSelect($('#opt-solo'), S.opts.voices, o.solo ?? 0);
  $('#opt-drums').checked = !!o.drums;
  $('#opt-fills').checked = o.drumFills === true;
  $('#opt-adapt').value = String(o.adapt ?? 1);
  $('#opt-form').value = o.form || 'compact';
  $('#opt-tempo').value = o.tempo || '';
  $('#tempo-auto')?.classList.toggle('hidden', !o.tempo);
  $('#opt-seed').value = o.seed || 1;
  fillTransposeSelect();
  if (o.transpose !== undefined) $('#opt-transpose').value = String(o.transpose);
  renderStyles();
  markPreset();
  setEnsemble(S.opts.ensemble || 'quartet');
  if (S.opts.ensemble === 'solo') $('#opt-solo').value = o.solo === 'none' ? 'none' : '0';
}

function renderPresets() {
  const box = $('#preset-chips');
  box.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = p.name.replace(/\s*\(.*\)/, '');
    b.title = p.name;
    b.dataset.preset = p.id;
    b.addEventListener('click', () => {
      S.opts.voices = [...p.voices];
      S.opts.style = p.style;
      applyOptsToUi(readOptsKeepVoices());
      toast(`Besetzung: ${p.name}`);
    });
    box.appendChild(b);
  }
}
function readOptsKeepVoices() {
  const o = readOpts();
  o.voices = [...S.opts.voices];
  o.style = S.opts.style;
  return o;
}
function markPreset() {
  const key = S.opts.voices.join();
  $$('#preset-chips .chip').forEach((c) => c.classList.toggle('active', PRESETS.find((p) => p.id === c.dataset.preset)?.voices.join() === key));
}

function renderStyles() {
  const box = $('#style-grid');
  box.innerHTML = '';
  for (const s of [{ id: 'auto', name: 'Automatisch' }, ...STYLE_LIST]) {
    const b = document.createElement('button');
    b.className = 'style-card' + (S.opts.style === s.id ? ' active' : '');
    b.innerHTML = `<span class="tag">${STYLE_TAG[s.id] || ''}</span><strong>${s.name}</strong>`;
    b.addEventListener('click', () => {
      S.opts.style = s.id;
      $$('.style-card', box).forEach((x) => x.classList.toggle('active', x === b));
    });
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------- Vorlage
async function setSource(src) {
  try {
    const song = await loadSong(src);
    S.source = src;
    S.song = song;
    await attachAudio(src);
    renderAnalysis();
    fillTransposeSelect();
    if (song.tempo) $('#opt-tempo').placeholder = `Automatisch (♩ ${song.tempo})`;
    $('#generate').disabled = false;
    S.opts.playParts = null; // Stimmen gehören zum Song
    S.opts.title = null;
    if (S.opts.ensemble === 'solo' && S.opts.playback) renderPlaybackList();
    return true;
  } catch (e) {
    console.error(e);
    toast('Vorlage konnte nicht gelesen werden: ' + e.message, 'error');
    return false;
  }
}

// Original-Aufnahme (nur lokal gespeichert) für das Playback bereitstellen
async function attachAudio(src) {
  if (S.audioUrl && S.audioFor !== src.audioId) {
    URL.revokeObjectURL(S.audioUrl);
    S.audioUrl = null;
    S.audioFor = null;
  }
  if (src.format !== 'audio' || !src.audioId || S.audioUrl) return;
  try {
    const blob = await S.local.getKV(`audio:${src.audioId}`);
    if (blob instanceof Blob) {
      S.audioUrl = URL.createObjectURL(blob);
      S.audioFor = src.audioId;
    }
  } catch {
    /* Aufnahme nicht auf diesem Gerät */
  }
}

function renderAnalysis() {
  const s = S.song;
  const box = $('#analysis');
  box.classList.remove('hidden');
  const form = s.sections.map((x) => `${x.label}`).join(' ');
  const chordInfo = s.chordsDetected ? 'Akkorde erkannt' : 'Akkorde aus Vorlage';
  let partsHtml = '';
  if (s.parts && s.parts.filter((p) => !p.unpitched && p.noteCount).length > 1) {
    partsHtml = `<label class="field" style="margin-top:10px"><span>Melodie aus Stimme</span><select id="melody-part">${s.parts
      .filter((p) => !p.unpitched && p.noteCount)
      .map((p) => `<option value="${p.index}" ${p.index === s.melodyPart ? 'selected' : ''}>${p.name} (${p.noteCount} Noten)</option>`)
      .join('')}</select></label>`;
  }
  const extra = [];
  if (s.source === 'audio') extra.push(`Aufnahme ${fmtTime(s.duration || 0)}`);
  if (s.drumNotes && s.drumNotes.length) extra.push(s.source === 'audio' ? 'Schlagzeug erkannt' : 'mit Schlagzeug');
  if (s.tracks && s.tracks.length > 1) extra.push(`${s.tracks.length} Spuren`);
  box.innerHTML = `<div class="a-title">${s.title}</div>
    <div class="kv"><span>${keyNameDe(s.key)}${s.keyDetected ? ' (erkannt)' : ''}</span><span>${s.meter.beats}/${s.meter.beatType}</span><span>♩ ${s.tempo || '–'}</span><span>${s.measureCount} Takte${s.pickup ? ' + Auftakt' : ''}</span><span>Form ${form}</span><span>${chordInfo}</span>${extra.map((x) => `<span>${x}</span>`).join('')}</div>
    ${partsHtml}
    ${(s.warnings || []).map((w) => `<div class="warn">⚠ ${w}</div>`).join('')}`;
  const mp = $('#melody-part');
  if (mp) mp.addEventListener('change', () => setSource({ ...S.source, melodyPart: Number(mp.value) }));
}

async function handleFile(file) {
  const pg = progress(`„${file.name}“ wird geladen`);
  try {
    const buf = await readFileWithProgress(file, (f) => pg.set(`Datei wird gelesen (${(file.size / 1048576).toFixed(1)} MB)`, f * 0.1));
    const format = detectFormat(file.name, buf);
    let ok;
    if (format === 'audio') {
      pg.title('Song wird analysiert').set('Audio wird dekodiert', null);
      await nextFrame();
      const decoded = await decodeAudio(buf);
      const title = file.name.replace(/\.[^.]+$/, '');
      const song = await analyzeAudio(decoded, { title, onProgress: (t, f) => pg.set(t, 0.12 + 0.86 * f) });
      pg.set('Aufnahme wird gespeichert', 0.99);
      const audioId = uuid();
      const blob = new Blob([buf], { type: file.type || 'audio/mpeg' });
      try {
        await S.local.setKV(`audio:${audioId}`, blob);
      } catch {
        /* ohne IndexedDB: Aufnahme nur für diese Sitzung */
      }
      if (S.audioUrl) URL.revokeObjectURL(S.audioUrl);
      S.audioUrl = URL.createObjectURL(blob);
      S.audioFor = audioId;
      ok = await setSource({ name: file.name, format: 'audio', audioId, song });
    } else {
      pg.set('Noten werden gelesen', 0.5);
      await nextFrame();
      const data = format === 'abc' ? new TextDecoder().decode(buf) : buf;
      ok = await setSource({ name: file.name, format, data });
    }
    pg.set('Fertig', 1);
    if (ok) toast(`„${S.song?.title || file.name}“ geladen`, 'ok');
  } catch (e) {
    console.error(e);
    toast('Datei konnte nicht geladen werden: ' + e.message, 'error');
  } finally {
    setTimeout(() => pg.done(), 300);
  }
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------------------------------------------------------------- Erzeugen
async function generate({ silent = false } = {}) {
  if (!S.song) {
    toast('Bitte zuerst eine Vorlage wählen.', 'error');
    return;
  }
  const btn = $('#generate');
  const label = btn.querySelector('span').textContent;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Wird erstellt …';
  const opts = readOpts();
  const pb = opts.ensemble === 'solo' && opts.playback;
  const pg = progress(pb ? 'Playback-Noten werden erstellt' : 'Arrangement wird erstellt');
  pg.set(pb ? 'Stimmen werden 1:1 übernommen' : 'Form, Stimmen & Gegenstimmen werden geschrieben', 0.05);
  await nextFrame();
  try {
    S.opts = { ...S.opts, ...opts };
    const t0 = performance.now();
    S.arr = arrange(S.song, opts);
    console.info(`Arrangement in ${Math.round(performance.now() - t0)} ms`);
    pg.set('Notenbild wird vorbereitet', 0.3);
    await nextFrame();
    S.printed = printedMeasures(S.arr);
    S.t2p = timelineToPrinted(S.arr, S.printed);
    await showResult((t, f) => pg.set(t, 0.3 + 0.7 * f));
    pg.set('Fertig', 1);
    if (S.settings.autoSave && !silent) await saveCurrent(true);
  } catch (e) {
    console.error(e);
    toast('Fehler beim Arrangieren: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = label;
    setTimeout(() => pg.done(), 250);
  }
}

async function showResult(onProgress = null) {
  const a = S.arr;
  $('#empty-state').classList.add('hidden');
  $('#result').classList.remove('hidden');
  $('#res-title').textContent = a.meta.title;
  const chips = [
    [a.options?.drumMode === 'own' && a.drums ? 'Schlagzeug · eigener Rhythmus' : a.playAlong ? 'Playback 1:1' : a.options?.styleAuto ? `${a.style.name} (automatisch)` : a.style.name, 'accent'],
    [keyNameDe(a.key) + (a.transposeShift ? ` (${a.transposeShift > 0 ? '+' : ''}${a.transposeShift})` : ''), ''],
    [`♩ = ${a.tempo}`, ''],
    [`${S.printed.length} Takte gedruckt`, ''],
    [
      a.playAlong
        ? [...a.voices.map((v) => v.inst.short), ...(a.drums ? ['Schlagzeug'] : [])].join(' · ')
        : a.soloMode
          ? `Solo · ${a.voices[0]?.inst.name || 'Schlagzeug'}`
          : a.voices.map((v) => v.inst.short).join(' · ') + (a.drums ? ' · Schlagzeug' : ''),
      '',
    ],
  ];
  $('#res-meta').innerHTML = chips.map(([t, c]) => `<span class="${c}">${t}</span>`).join('');
  // Ansichten
  const vt = $('#view-tabs');
  vt.innerHTML = '';
  let views = [['score', 'Partitur'], ...a.voices.map((v, i) => [String(i), a.playAlong ? `${v.inst.short} · ${v.label}` : `${i + 1} · ${v.inst.short}`])];
  if (a.drums) views.push(['drums', 'Schlagzeug']);
  if (a.soloMode && a.voices.length + (a.drums ? 1 : 0) === 1) views = a.voices.length ? [['0', `Solo · ${a.voices[0].inst.name}`]] : [['drums', 'Solo · Schlagzeug']];
  if (!views.some(([k]) => k === S.view)) S.view = views[0][0];
  for (const [k, t] of views) {
    const b = document.createElement('button');
    b.className = 'seg' + (k === S.view ? ' active' : '');
    b.textContent = t;
    b.addEventListener('click', () => {
      S.view = k;
      $$('.seg', vt).forEach((x) => x.classList.toggle('active', x === b));
      renderNotes();
    });
    vt.appendChild(b);
  }
  renderPlan();
  setupPlayer();
  await renderNotes(onProgress);
}

function xmlFor(view) {
  const st = S.settings;
  const chords = S.arr.soloMode && !S.arr.playAlong && st.chords !== 'none' ? 'all' : st.chords;
  const tenorClef = st.tenorClef;
  if (view === 'score') return exportMusicXML(S.arr, { mode: 'score', concert: st.concertScore, paper: st.paper, chords, tenorClef });
  if (view === 'drums') return exportMusicXML(S.arr, { mode: 'part', partIndex: 'drums', paper: st.paper });
  return exportMusicXML(S.arr, { mode: 'part', partIndex: Number(view), paper: st.paper, chords, tenorClef });
}

async function renderNotes(onProgress = null) {
  const token = ++S.renderToken;
  const box = $('#pages');
  box.querySelectorAll('.page').forEach((p) => p.remove());
  const loader = $('#loader');
  loader.classList.add('on');
  // eigener Fortschritt, wenn nicht Teil eines größeren Vorgangs
  const own = onProgress ? null : progress('Noten werden gesetzt');
  const report = onProgress || ((t, f) => own.set(t, f));
  try {
    const xml = xmlFor(S.view);
    const pages = await renderPages(xml, { paper: S.settings.paper, part: S.view !== 'score', zoom: S.zoom * S.settings.notesZoom, scale: 100, onProgress: (t, f) => token === S.renderToken && report(t, f) });
    if (token !== S.renderToken) return;
    loader.classList.remove('on');
    box.style.setProperty('--zoom', S.view === 'score' ? 1.15 : 1);
    for (const svg of pages) {
      const div = document.createElement('div');
      div.className = 'page';
      div.appendChild(responsiveSvg(svg));
      box.appendChild(div);
    }
    S.measureEls = $$('g.measure', box);
    S.follower.attach(S.printed.length);
    if (S.player) updatePosition(S.player.displayPosition(), S.player.perf.secToBar(S.player.displayPosition()));
    own?.done();
  } catch (e) {
    own?.done();
    loader.classList.remove('on');
    console.error(e);
    const div = document.createElement('div');
    div.className = 'page';
    div.style.padding = '30px';
    div.innerHTML = `<strong>Notenvorschau nicht verfügbar.</strong><p class="muted">${e.message}. Für die Vorschau wird eine Internetverbindung benötigt (Notensatz-Bibliothek). Der Export als MuseScore-Datei funktioniert trotzdem.</p>`;
    box.appendChild(div);
  }
}

function renderPlan() {
  const p = buildPlan(S.arr);
  const roleClass = (r) => (['melody', 'solo', 'hook', 'subject', 'tutti'].includes(r) ? 'lead' : r === 'rest' ? 'rest' : '');
  const head = `<div class="plan-head">
    <div><b>Stil</b>${p.style}</div><div><b>Tonart</b>${p.key}${p.transpose ? ` (${p.transpose > 0 ? '+' : ''}${p.transpose} HT)` : ''}</div>
    <div><b>Tempo</b>${p.tempo}</div><div><b>Länge</b>${p.bars} Takte gespielt · ${p.printedBars} gedruckt</div></div>`;
  const rows = p.rows
    .map(
      (r) => `<tr class="${r.copy ? 'copy' : ''}"><td>${r.rehearsal ? `<span class="reh">${r.rehearsal}</span>` : ''}</td><td><strong>${r.name}</strong></td><td>${r.bars}</td><td>${r.dyn}</td>${r.rawRoles
        .map((x, i) => `<td><span class="role ${roleClass(x)}">${r.roles[i]}</span></td>`)
        .join('')}<td class="muted">${r.note}</td></tr>`,
    )
    .join('');
  const names = S.arr.voices.map((v, i) => `<th>St. ${i + 1}<br><span class="muted">${v.inst.short}</span></th>`).join('');
  const jumps = p.form && p.form.segnoBar !== null ? `<p class="muted small" style="margin-top:12px">𝄋 <strong>D.S. al Coda:</strong> nach dem Solo zurück zum Segno (Takt ${p.form.segnoBar + 1}), bei „To Coda“ in die Coda springen.</p>` : '';
  $('#plan').innerHTML = `${head}<div class="table-wrap"><table class="plan"><thead><tr><th></th><th>Teil</th><th>Takte</th><th>Dyn.</th>${names}<th>Hinweis</th></tr></thead><tbody>${rows}</tbody></table></div>${jumps}`;
  $('#quality').innerHTML = `<ul class="quality-list">${p.quality.map((q) => `<li>${q}</li>`).join('')}</ul>${p.warnings.map((w) => `<p class="muted">⚠ ${w}</p>`).join('')}`;
}

// ---------------------------------------------------------------- Player
function setupPlayer() {
  const prevMix = S.player ? S.player.parts.map((p) => ({ key: String(p.key), volume: p.volume, mute: p.mute, solo: p.solo, pan: p.pan })) : null;
  if (S.player) S.player.dispose();
  const wantsAudio = S.arr.backing?.kind === 'audio';
  S.player = new Player(S.arr, {
    onPosition: (sec, bar) => updatePosition(sec, bar),
    onEnd: () => setPlayIcon(false),
    audioUrl: wantsAudio ? S.audioUrl : null,
  });
  window.__player = S.player; // für Diagnose/Tests
  if (wantsAudio && S.audioUrl) S.player.preload();
  if (wantsAudio && !S.audioUrl) toast('Die Original-Aufnahme liegt nur auf dem Gerät, auf dem sie geladen wurde – zum Mitspielen die Datei hier erneut laden.', 'error');
  if (prevMix)
    for (const m of prevMix) {
      const p = S.player.part(m.key);
      if (p) Object.assign(p, { volume: m.volume, mute: m.mute, solo: m.solo, pan: m.pan });
    }
  $('#player').classList.remove('hidden');
  $('#p-total').textContent = fmtTime(S.player.duration);
  $('#p-seek').value = 0;
  syncPractice(S.player, S.arr, toast);
  updatePosition(0, 0);
  setPlayIcon(false);
  renderMixer();
}

function setPlayIcon(playing) {
  $('#p-play-icon use').setAttribute('href', playing ? '#i-pause' : '#i-play');
}

function updatePosition(sec, bar) {
  const p = S.player;
  if (!p) return;
  $('#p-time').textContent = fmtTime(sec);
  if (!S.seeking) $('#p-seek').value = Math.round((sec / p.duration) * 1000);
  const idx = S.t2p(bar);
  $('#p-bar').textContent = idx !== null ? `Takt ${idx + 1}` : '';
  // Mitlesen: Takt markieren, Cursor im Takt, Seiten automatisch weiterblättern
  const b0 = p.perf.barToSec(bar);
  const b1 = p.perf.barToSec(bar + 1);
  const frac = b1 > b0 ? (sec - b0) / (b1 - b0) : 0;
  const show = p.playing || sec > 0.01;
  S.follower.update(show ? idx : null, frac, { playing: p.playing, visible: $('#pages').offsetParent !== null });
}

function renderMixer() {
  const box = $('#strips');
  box.innerHTML = '';
  S.player.parts.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'strip';
    const color = p.orig ? 'var(--brass)' : VOICE_COLORS[i % VOICE_COLORS.length];
    el.innerHTML = `<div class="s-name" style="color:${color}" title="${p.name}">${p.title}<div class="s-sub">${p.sub}</div></div>
      <input class="vol" type="range" min="0" max="100" value="${Math.round(p.volume * 100)}" aria-label="Lautstärke">
      <div class="ms"><button class="m ${p.mute ? 'on' : ''}" title="Stumm">M</button><button class="s ${p.solo ? 'on' : ''}" title="Solo">S</button></div>
      <input class="pan" type="range" min="-100" max="100" value="${Math.round(p.pan * 100)}" title="Panorama" aria-label="Panorama">`;
    $('.vol', el).addEventListener('input', (e) => S.player.setVolume(p.key, e.target.value / 100));
    $('.pan', el).addEventListener('input', (e) => S.player.setPan(p.key, e.target.value / 100));
    $('.m', el).addEventListener('click', (e) => {
      S.player.setMute(p.key, !p.mute);
      e.currentTarget.classList.toggle('on', p.mute);
    });
    $('.s', el).addEventListener('click', (e) => {
      S.player.setSolo(p.key, !p.solo);
      e.currentTarget.classList.toggle('on', p.solo);
    });
    box.appendChild(el);
  });
}

function togglePlay() {
  const p = S.player;
  if (!p) return;
  if (p.playing) {
    p.pause();
    setPlayIcon(false);
  } else {
    S.follower.resume();
    p.play();
    setPlayIcon(true);
  }
}

// ---------------------------------------------------------------- Export
async function doExport(kind) {
  const a = S.arr;
  if (!a) return;
  const base = safeName(a.meta.title);
  const st = S.settings;
  const single = a.soloMode && a.voices.length + (a.drums ? 1 : 0) === 1;
  if (kind === 'mp3') return openAudioExport({ player: S.player, arr: a, baseName: base, safeName, progress, download, toast });
  const partName = (i) => (a.playAlong ? `${safeName(a.voices[i].label)}_${safeName(a.voices[i].inst.name)}` : single ? `Solo_${safeName(a.voices[i].inst.name)}` : `Stimme_${i + 1}_${safeName(a.voices[i].inst.name)}`);
  const pg = progress('Export wird erstellt');
  const onProgress = (t, f) => pg.set(t, f);
  try {
    await nextFrame();
    if (kind === 'mscz-zip') {
      pg.set('MusicXML-Dateien werden geschrieben', 0.2);
      await nextFrame();
      const files = single ? [] : [{ name: `${base}_Partitur.musicxml`, data: xmlFor('score') }];
      a.voices.forEach((_, i) => files.push({ name: `${base}_${partName(i)}.musicxml`, data: xmlFor(String(i)) }));
      if (a.drums) files.push({ name: `${base}_Schlagzeug.musicxml`, data: exportMusicXML(a, { mode: 'part', partIndex: 'drums', paper: st.paper }) });
      files.push({ name: `${base}.mid`, data: exportMidi(a) });
      files.push({ name: `${base}_Regieplan.md`, data: planMarkdown(a) });
      download(`${base}_MuseScore.zip`, zip(files), 'application/zip');
    } else if (kind === 'xml-current') {
      download(`${base}_${viewLabel()}.musicxml`, xmlFor(S.view), 'application/vnd.recordare.musicxml+xml');
    } else if (kind === 'pdf-current') {
      const pdf = await xmlsToPdf([{ xml: xmlFor(S.view), part: S.view !== 'score' }], { paper: st.paper, zoom: st.notesZoom, title: a.meta.title, onProgress });
      download(`${base}_${viewLabel()}.pdf`, pdf, 'application/pdf');
    } else if (kind === 'pdf-all') {
      const list = [...(single ? [] : [{ xml: xmlFor('score'), part: false, name: 'Partitur' }]), ...a.voices.map((v, i) => ({ xml: xmlFor(String(i)), part: true, name: v.inst.name }))];
      if (a.drums) list.push({ xml: xmlFor('drums'), part: true, name: 'Schlagzeug' });
      const pdf = await xmlsToPdf(list, { paper: st.paper, zoom: st.notesZoom, title: a.meta.title, onProgress });
      download(`${base}_komplett.pdf`, pdf, 'application/pdf');
    } else if (kind === 'png-current') {
      const pngs = await pagesToPngs(xmlFor(S.view), { paper: st.paper, part: S.view !== 'score', zoom: st.notesZoom, onProgress });
      if (pngs.length === 1) download(`${base}_${viewLabel()}.png`, pngs[0], 'image/png');
      else download(`${base}_${viewLabel()}_Bilder.zip`, zip(pngs.map((d, i) => ({ name: `${base}_${viewLabel()}_Seite_${i + 1}.png`, data: d }))), 'application/zip');
    } else if (kind === 'midi') {
      download(`${base}.mid`, exportMidi(a), 'audio/midi');
    } else if (kind === 'plan') {
      download(`${base}_Regieplan.md`, planMarkdown(a), 'text/markdown');
    }
    pg.set('Fertig', 1);
  } catch (e) {
    console.error(e);
    toast('Export fehlgeschlagen: ' + e.message, 'error');
  } finally {
    setTimeout(() => pg.done(), 400);
  }
}

function viewLabel() {
  if (S.view === 'score') return 'Partitur';
  if (S.view === 'drums') return 'Schlagzeug';
  const i = Number(S.view);
  const v = S.arr.voices[i];
  if (S.arr.playAlong) return `${safeName(v.label)}_${safeName(v.inst.name)}`;
  if (S.arr.soloMode) return `Solo_${safeName(v.inst.name)}`;
  return `Stimme_${i + 1}_${safeName(v.inst.name)}`;
}

// ---------------------------------------------------------------- Bibliothek
async function saveCurrent(auto = false) {
  if (!S.arr || !S.source) return;
  const a = S.arr;
  const item = {
    id: S.currentId || undefined,
    title: a.meta.title,
    source: serializeSource(S.source),
    options: S.opts,
    summary: {
      style: a.playAlong ? 'Playback 1:1' : a.style.name,
      styleId: a.style.id,
      voices: a.playAlong ? [...a.voices.map((v) => `${v.label} → ${v.inst.name}`), ...(a.drums ? ['Schlagzeug'] : [])] : a.soloMode ? [`Solo: ${a.voices[0]?.inst.name || 'Schlagzeug'}`] : a.voices.map((v) => v.inst.name),
      drums: !!a.drums && !a.soloMode,
      key: keyNameDe(a.key),
      bars: S.printed.length,
      tempo: a.tempo,
    },
  };
  const saved = await S.library.save(item);
  S.currentId = saved.id;
  if (!auto) toast('In der Bibliothek gespeichert', 'ok');
}

async function renderLibrary() {
  const box = $('#library-grid');
  const items = await S.library.list();
  $('#library-sub').textContent = S.library.cloud.user ? `${items.length} Arrangements · synchronisiert mit ${S.library.cloud.user.email}` : `${items.length} Arrangements · nur auf diesem Gerät (anmelden für Sync)`;
  if (!items.length) {
    box.innerHTML = `<div class="lib-empty card"><h3>Noch nichts gespeichert</h3><p>Erstelle ein Arrangement – es landet automatisch hier und, wenn du angemeldet bist, auf all deinen Geräten.</p></div>`;
    return;
  }
  box.innerHTML = '';
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'card lib-card';
    const date = new Date(it.updatedAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
    const sm = it.summary || {};
    card.innerHTML = `<div class="meta-chips"><span class="accent">${sm.style || ''}</span>${sm.key ? `<span>${sm.key}</span>` : ''}${sm.bars ? `<span>${sm.bars} Takte</span>` : ''}</div>
      <div class="lib-title"><h3></h3><button class="icon-btn small rename" title="Titel ändern" aria-label="Titel ändern"><svg><use href="#i-pen"/></svg></button></div>
      <div class="lib-meta">${(sm.voices || []).join(', ')}${sm.drums ? ', Schlagzeug' : ''}</div>
      <div class="lib-meta">${date}${it.dirty && S.library.cloud.user ? ' · wird synchronisiert' : ''}</div>
      <div class="lib-actions"><button class="btn primary small open">Öffnen</button><button class="btn ghost small danger del"><svg><use href="#i-trash"/></svg></button></div>`;
    $('h3', card).textContent = it.title;
    $('.open', card).addEventListener('click', () => openItem(it.id));
    $('.rename', card).addEventListener('click', () => renameItem(card, it));
    $('h3', card).addEventListener('dblclick', () => renameItem(card, it));
    // Löschen ohne Rückfrage – dafür mit "Rückgängig"
    $('.del', card).addEventListener('click', async () => {
      const backup = await S.library.get(it.id);
      await S.library.remove(it.id);
      if (S.currentId === it.id) S.currentId = null;
      card.classList.add('removing');
      setTimeout(renderLibrary, 180);
      toast(`„${it.title}“ gelöscht`, '', {
        label: 'Rückgängig',
        run: async () => {
          await S.library.save({ ...backup, deleted: false });
          renderLibrary();
        },
      });
    });
    box.appendChild(card);
  }
}

// Titel direkt auf der Karte bearbeiten (Enter = speichern, Esc = abbrechen)
function renameItem(card, it) {
  const box = $('.lib-title', card);
  if ($('input', box)) return;
  const h = $('h3', box);
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = it.title;
  input.setAttribute('aria-label', 'Titel');
  h.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (save && title && title !== it.title) {
      const cur = await S.library.get(it.id);
      await S.library.save({ ...cur, title, options: { ...(cur.options || {}), title } });
      if (S.currentId === it.id && S.arr) {
        S.arr.meta.title = title;
        S.opts.title = title;
        $('#res-title').textContent = title;
      }
      toast('Titel geändert', 'ok');
    }
    renderLibrary();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------------------------------------------------------------- Updates
async function renderUpdateCard() {
  const v = await localVersion();
  const p = platform();
  const where = p === 'desktop' ? 'Windows-App' : p === 'android' ? 'Android-App' : 'Web-App';
  $('#upd-version').textContent = `${where} · Version ${v.version}${v.date ? ` vom ${new Date(v.date).toLocaleDateString('de-DE')}` : ''}`;
  if (p === 'web') {
    $('#upd-status').textContent = 'Im Browser ist NoteCode automatisch immer aktuell.';
    $('#upd-check').classList.add('hidden');
  }
}

async function runUpdateCheck({ silent = false } = {}) {
  if (platform() === 'web') return;
  try {
    if (!silent) $('#upd-status').textContent = 'Suche nach Updates …';
    const r = await checkUpdate();
    if (!r.available) {
      if (!silent) {
        $('#upd-status').textContent = `Du hast die neueste Version (${r.current.version}).`;
        toast('NoteCode ist aktuell', 'ok');
      }
      return;
    }
    $('#upd-status').textContent = `Neue Version ${r.latest.version} verfügbar.`;
    toast(`Update ${r.latest.version} verfügbar`, '', { label: 'Jetzt aktualisieren', run: installUpdate });
  } catch (e) {
    if (!silent) {
      $('#upd-status').textContent = 'Update-Prüfung fehlgeschlagen: ' + e.message;
      toast('Update-Prüfung fehlgeschlagen: ' + e.message, 'error');
    }
  }
}

async function installUpdate() {
  const pg = progress('NoteCode wird aktualisiert');
  try {
    await applyUpdate((t, f) => pg.set(t, f));
  } catch (e) {
    pg.done();
    toast('Update fehlgeschlagen: ' + e.message, 'error');
  }
}

// Neues Arrangement: Vorlage & Ergebnis zurücksetzen
function startNew() {
  S.player?.dispose();
  S.player = null;
  S.arr = null;
  S.song = null;
  S.source = null;
  S.currentId = null;
  S.opts.playParts = null;
  S.opts.title = null;
  $('#player').classList.add('hidden');
  $('#result').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  $('#analysis').classList.add('hidden');
  $('#generate').disabled = true;
  $('#file-input').value = '';
  if (S.opts.ensemble === 'solo' && S.opts.playback) renderPlaybackList();
  showView('arrange');
}

async function openItem(id) {
  const it = await S.library.get(id);
  if (!it) return;
  showView('arrange');
  await setSource(deserializeSource(it.source));
  applyOptsToUi(it.options || {});
  S.currentId = it.id;
  await generate({ silent: true });
}

// ---------------------------------------------------------------- Einstellungen
function renderSettings() {
  const st = S.settings;
  renderVoiceGrid($('#set-voices'), [...st.defaultVoices], (v) => update({ defaultVoices: [...v] }));
  const ss = $('#set-style');
  ss.innerHTML = [{ id: 'auto', name: 'Automatisch (passend zum Song)' }, ...STYLE_LIST].map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  ss.value = st.defaultStyle;
  fillSoloSelect($('#set-solo'), st.defaultVoices, st.defaultSolo);
  difficultyOptions($('#set-difficulty'), st.defaultDifficulty ?? 'auto');
  $('#set-form').value = st.form;
  $('#set-drums').checked = st.defaultDrums;
  $('#set-transpose').checked = st.transposeAuto;
  $('#set-autosave').checked = st.autoSave;
  $('#set-paper').value = st.paper;
  $('#set-zoom').value = String(st.notesZoom);
  $('#set-concert').value = String(st.concertScore);
  $('#set-chords').value = st.chords;
  $('#set-tenor').checked = st.tenorClef;
  $('#set-theme').value = st.theme;
  $('#set-sb-url').value = st.supabaseUrl || '';
  $('#set-sb-key').value = st.supabaseKey || '';
  renderAccountStatus();
}

async function update(patch, { rerender = false } = {}) {
  Object.assign(S.settings, patch);
  await saveSettings(S.local, S.settings, S.library.cloud);
  applyTheme();
  if (rerender && S.arr) renderNotes();
}

function bindSettings() {
  const on = (id, fn, ev = 'change') => $(id).addEventListener(ev, fn);
  on('#set-style', (e) => update({ defaultStyle: e.target.value }));
  on('#set-solo', (e) => update({ defaultSolo: /\d/.test(e.target.value) ? Number(e.target.value) : e.target.value }));
  on('#set-difficulty', (e) => update({ defaultDifficulty: e.target.value === 'auto' ? 'auto' : Number(e.target.value) }));
  on('#set-form', (e) => update({ form: e.target.value }));
  on('#set-drums', (e) => update({ defaultDrums: e.target.checked }));
  on('#set-transpose', (e) => update({ transposeAuto: e.target.checked }));
  on('#set-autosave', (e) => update({ autoSave: e.target.checked }));
  on('#set-paper', (e) => update({ paper: e.target.value }, { rerender: true }));
  on('#set-zoom', (e) => update({ notesZoom: Number(e.target.value) }, { rerender: true }));
  on('#set-concert', (e) => update({ concertScore: e.target.value === 'true' }, { rerender: true }));
  on('#set-chords', (e) => update({ chords: e.target.value }, { rerender: true }));
  on('#set-theme', (e) => update({ theme: e.target.value }));
  on('#set-tenor', (e) => update({ tenorClef: e.target.checked }, { rerender: true }));
  on('#sb-save', async () => {
    await update({ supabaseUrl: $('#set-sb-url').value.trim(), supabaseKey: $('#set-sb-key').value.trim() });
    await S.library.configure(S.settings);
    renderAccountStatus();
    toast(S.library.cloud.configured ? 'Server-Verbindung gespeichert' : 'Verbindung entfernt', 'ok');
  }, 'click');
  on('#backup-export', async () => {
    const items = await S.library.list();
    download(`NoteCode_Sicherung_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'NoteCode', version: 1, items, settings: { ...S.settings, supabaseKey: undefined } }, null, 1), 'application/json');
  }, 'click');
  on('#backup-import', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      for (const it of data.items || []) await S.library.save(it);
      toast(`${(data.items || []).length} Arrangements importiert`, 'ok');
      renderLibrary();
    } catch (err) {
      toast('Sicherung ungültig: ' + err.message, 'error');
    }
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme === 'auto' ? 'auto' : 'light';
}

// ---------------------------------------------------------------- Konto
function renderAccountStatus() {
  const box = $('#account-status');
  const lib = S.library;
  const user = lib.cloud.user;
  if (!lib.cloud.configured) {
    box.innerHTML = `<span>☁️ Cloud-Sync ist noch nicht eingerichtet.</span><button class="btn ghost small" id="acc-setup">Einrichten</button>`;
    $('#acc-setup').addEventListener('click', () => ($('#sync-config').open = true));
    $('#sync-config').open = true;
  } else if (user) {
    box.innerHTML = `<span>Angemeldet als <strong>${user.email}</strong></span><button class="btn ghost small" id="acc-out">Abmelden</button>`;
    $('#acc-out').addEventListener('click', async () => {
      await lib.signOut();
      renderAccountStatus();
      updateAccountButton();
      toast('Abgemeldet');
    });
  } else {
    box.innerHTML = `<span>Nicht angemeldet</span><button class="btn primary small" id="acc-in">Anmelden / Registrieren</button>`;
    $('#acc-in').addEventListener('click', () => openAuth());
  }
}

function updateAccountButton() {
  const user = S.library.cloud.user;
  $('#account-label').textContent = user ? user.email.split('@')[0] : 'Anmelden';
  $('#avatar').innerHTML = user ? user.email[0].toUpperCase() : '<svg><use href="#i-user"/></svg>';
}

let authMode = 'login';
function openAuth() {
  if (!S.library.cloud.configured) {
    showView('settings');
    $('#sync-config').open = true;
    toast('Bitte zuerst die Server-Verbindung (Supabase) eintragen – Anleitung im README.', 'error');
    return;
  }
  setAuthMode('login');
  $('#auth-error').textContent = '';
  $('#auth-dialog').showModal();
}
function setAuthMode(m) {
  authMode = m;
  $('#auth-title').textContent = m === 'login' ? 'Anmelden' : 'Konto erstellen';
  $('#auth-submit').textContent = m === 'login' ? 'Anmelden' : 'Registrieren';
  $('#auth-switch').textContent = m === 'login' ? 'Noch kein Konto? Registrieren' : 'Schon registriert? Anmelden';
  $('#auth-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
}
function bindAuth() {
  $('#auth-switch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
  $('#auth-cancel').addEventListener('click', () => $('#auth-dialog').close());
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const pw = $('#auth-pass').value;
    $('#auth-error').textContent = '';
    $('#auth-submit').disabled = true;
    try {
      if (authMode === 'login') {
        await S.library.signIn(email, pw);
        toast('Angemeldet – deine Arrangements werden synchronisiert', 'ok');
        $('#auth-dialog').close();
      } else {
        const r = await S.library.signUp(email, pw);
        if (r.confirm) {
          $('#auth-error').textContent = 'Fast geschafft: Bitte bestätige die E-Mail und melde dich danach an.';
          setAuthMode('login');
        } else {
          toast('Konto erstellt', 'ok');
          $('#auth-dialog').close();
        }
      }
      await pullCloudSettings();
      updateAccountButton();
      renderAccountStatus();
      renderLibrary();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    } finally {
      $('#auth-submit').disabled = false;
    }
  });
  $('#account-btn').addEventListener('click', () => {
    if (S.library.cloud.user) showView('settings');
    else openAuth();
  });
}

async function pullCloudSettings() {
  if (!S.library.cloud.user) return;
  try {
    const row = await S.library.cloud.fetchSettings();
    if (row && row.data) {
      const { supabaseUrl, supabaseKey, ...rest } = row.data;
      void supabaseUrl;
      void supabaseKey;
      Object.assign(S.settings, rest);
      await saveSettings(S.local, S.settings);
      applyTheme();
    }
  } catch {
    /* noch keine Cloud-Einstellungen */
  }
}

function bindSyncStatus() {
  const pill = $('#sync-pill');
  const upd = () => {
    const st = S.library.status;
    $('#sync-text').textContent = S.library.cloud.user ? st : 'lokal';
    pill.classList.toggle('online', !!S.library.cloud.user && !/Fehler|synchronisiere/.test(st));
    pill.classList.toggle('busy', /synchronisiere/.test(st));
    pill.classList.toggle('error', /Fehler/.test(st));
  };
  S.library.addEventListener('status', upd);
  S.library.addEventListener('auth', () => {
    updateAccountButton();
    upd();
  });
  S.library.addEventListener('change', () => {
    if ($('#view-library').classList.contains('active')) renderLibrary();
  });
  $('#lib-new').addEventListener('click', startNew);
  $('#upd-check').addEventListener('click', () => runUpdateCheck());
  renderUpdateCard();
  // einmal beim Start still prüfen (nur installierte Apps)
  setTimeout(() => runUpdateCheck({ silent: true }), 4000);
  $('#sync-now').addEventListener('click', async () => {
    if (!S.library.cloud.user) return openAuth();
    try {
      await S.library.sync();
      toast('Synchronisiert', 'ok');
    } catch (e) {
      toast('Sync-Fehler: ' + e.message, 'error');
    }
  });
  upd();
}

// ---------------------------------------------------------------- Start
async function main() {
  S.local = await new LocalStore().open();
  S.settings = await loadSettings(S.local);
  applyTheme();
  S.library = new Library(S.local);
  S.follower = new ScoreFollower($('#pages'));
  await S.library.init(S.settings);
  S.opts = {
    voices: [...S.settings.defaultVoices],
    style: S.settings.defaultStyle,
    drums: S.settings.defaultDrums,
    solo: S.settings.defaultSolo,
    length: S.settings.defaultLength,
    adapt: S.settings.defaultAdapt,
    form: S.settings.form,
    transpose: S.settings.transposeAuto ? 'auto' : 0,
    seed: 1,
    ensemble: 'quartet',
    soloInstrument: S.settings.defaultVoices[0] || 'trumpet',
    difficulty: S.settings.defaultDifficulty ?? 'auto',
    voiceDifficulty: [null, null, null, null],
    ranges: [null, null, null, null],
    playback: false,
    playParts: null,
    drumFills: false,
  };
  renderPresets();
  applyOptsToUi(S.opts);
  bindSettings();
  bindAuth();
  bindSyncStatus();
  updateAccountButton();

  // Navigation
  $$('[data-nav]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      showView(b.dataset.nav);
    }),
  );
  const startView = (location.hash || '#arrange').slice(1);
  if (['arrange', 'library', 'settings'].includes(startView)) showView(startView);

  $$('#ensemble-tabs .seg').forEach((b) => b.addEventListener('click', () => setEnsemble(b.dataset.ens)));

  // Vorlage
  $$('#source-tabs .seg').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#source-tabs .seg').forEach((x) => x.classList.toggle('active', x === b));
      $$('.src-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === b.dataset.src));
    }),
  );
  $('#file-input').addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), dz.classList.add('over'))));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), dz.classList.remove('over'))));
  dz.addEventListener('drop', (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));
  $('#abc-load').addEventListener('click', async () => {
    const text = $('#abc-input').value.trim();
    if (!text) return toast('Bitte zuerst ABC-Noten eingeben.', 'error');
    if (await setSource({ name: 'eingabe.abc', format: 'abc', data: text })) toast(`„${S.song.title}“ übernommen`, 'ok');
  });
  // Schwierigkeit: die Felder bei Solo, Schlagzeug und in Schritt 3 sind dasselbe
  const diffSels = ['#opt-solo-difficulty', '#opt-difficulty', '#opt-drum-difficulty'].map((x) => $(x));
  for (const a of diffSels)
    a.addEventListener('change', () => {
      for (const b of diffSels) if (b !== a) b.value = a.value;
      S.opts.difficulty = a.value === 'auto' ? 'auto' : Number(a.value);
    });
  $$('#drum-mode .seg').forEach((b) => b.addEventListener('click', () => setDrumMode(b.dataset.mode)));
  // Tempo wieder automatisch
  const tempoBtn = () => $('#tempo-auto').classList.toggle('hidden', !$('#opt-tempo').value);
  $('#opt-tempo').addEventListener('input', tempoBtn);
  $('#tempo-auto').addEventListener('click', (e) => {
    e.preventDefault();
    $('#opt-tempo').value = '';
    tempoBtn();
    toast('Tempo: automatisch (wie die Vorlage bzw. der Stil)');
  });
  tempoBtn();
  // Solo: Playback
  $('#opt-playback').addEventListener('change', (e) => setPlayback(e.target.checked));
  $('#pb-all').addEventListener('click', () => {
    if (!S.song) return;
    const src = playAlongSources(S.song);
    S.opts.playParts = src.map((x) => ({ source: x.id, inst: x.kind === 'drums' ? 'drums' : x.suggest || (S.opts.soloInstrument !== 'drums' ? S.opts.soloInstrument : 'trumpet') }));
    S.opts.voiceDifficulty = [];
    S.opts.ranges = [];
    renderPlaybackList();
  });
  $('#pb-melody').addEventListener('click', () => {
    S.opts.playParts = [{ source: 'melody', inst: S.opts.soloInstrument !== 'drums' ? S.opts.soloInstrument : 'trumpet' }];
    S.opts.voiceDifficulty = [];
    S.opts.ranges = [];
    renderPlaybackList();
  });

  // Erzeugen
  $('#generate').addEventListener('click', () => {
    S.currentId = null;
    generate();
  });
  $('#dice').addEventListener('click', () => {
    $('#opt-seed').value = Math.floor(Math.random() * 9999) + 1;
    if (S.arr) generate();
  });

  // Ergebnis
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tabpanel === t.dataset.tab));
    }),
  );
  $('#zoom-in').addEventListener('click', () => setZoom(S.zoom + 0.1));
  $('#zoom-out').addEventListener('click', () => setZoom(S.zoom - 0.1));
  $('#save-btn').addEventListener('click', () => saveCurrent(false));
  const menu = $('#export-menu');
  $('#export-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'));
  $$('#export-menu [data-export]').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.export)));
  $('#pages').addEventListener('click', (e) => {
    const m = e.target.closest('g.measure');
    if (!m || !S.player) return;
    const idx = S.follower.indexOf(m);
    if (idx >= 0 && S.printed[idx]) {
      S.player.seekBar(S.printed[idx].src);
      if (!S.player.playing) toast(`Start ab Takt ${idx + 1}`);
    }
  });

  // Player
  $('#p-play').addEventListener('click', togglePlay);
  $('#p-stop').addEventListener('click', () => {
    S.player?.stop();
    setPlayIcon(false);
    S.follower.hide();
  });
  const seek = $('#p-seek');
  seek.addEventListener('input', () => (S.seeking = true));
  seek.addEventListener('change', () => {
    S.seeking = false;
    S.player?.seekSec((seek.value / 1000) * S.player.duration);
  });
  bindPractice({ getPlayer: () => S.player, follower: S.follower });
  $('#mixer-mp3').addEventListener('click', () => doExport('mp3'));
  $('#p-mixer').addEventListener('click', () => $('#mixer').classList.toggle('open'));
  $('#mixer-close').addEventListener('click', () => $('#mixer').classList.remove('open'));
  $('#master').addEventListener('input', (e) => S.player?.setMaster(e.target.value / 100));
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement?.tagName || '') && S.player) {
      e.preventDefault();
      togglePlay();
    }
  });

  // Notensatz-Bibliothek im Hintergrund vorladen
  loadVerovio().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.Capacitor) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function setZoom(z) {
  S.zoom = Math.max(0.6, Math.min(1.6, Math.round(z * 10) / 10));
  $('#zoom-label').textContent = `${Math.round(S.zoom * 100)} %`;
  renderNotes();
}

main().catch((e) => {
  console.error(e);
  toast('Start fehlgeschlagen: ' + e.message, 'error');
});
