// NoteCode – App-Steuerung (Oberfläche).
import { DEMOS } from '../demos.js';
import { INSTRUMENTS, PRESETS, FAMILIES, writtenRangeChoices } from '../arrange/instruments.js';
import { DIFFICULTY_LEVELS } from '../arrange/difficulty.js';
import { STYLE_LIST } from '../arrange/styles.js';
import { loadSong, detectFormat } from '../input/index.js';
import { arrange } from '../arrange/engine.js';
import { exportMusicXML } from '../output/musicxml.js';
import { exportMidi } from '../output/midi.js';
import { buildPlan, planMarkdown } from '../output/report.js';
import { printedMeasures, timelineToPrinted } from '../output/form.js';
import { zip } from '../core/zip.js';
import { keyNameDe, transposeKey } from '../theory/keys.js';
import { Player } from './player.js';
import { renderPages, responsiveSvg, pagesToPngs, xmlsToPdf, loadVerovio } from './render.js';
import { LocalStore, Library } from './store.js';
import { loadSettings, saveSettings } from './settings.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const VOICE_COLORS = ['#1f3a5f', '#4f6d8f', '#8a6a2f', '#5b5f66', '#2f7d4f'];
const STYLE_TAG = { funk: 'Funk', secondline: 'New Orleans', swing: 'Jazz', ballad: 'Pop', classical: 'Klassik', polka: 'Blasmusik' };

const S = {
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
  follow: true,
};

// ---------------------------------------------------------------- Hilfen
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s, transform .3s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(16px)';
    setTimeout(() => t.remove(), 320);
  }, kind === 'error' ? 5200 : 2600);
}

function download(name, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
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
  if (typeof src.data === 'string') return { name: src.name, format: src.format, text: src.data, melodyPart: src.melodyPart ?? null };
  return { name: src.name, format: src.format, b64: bytesToB64(new Uint8Array(src.data)), melodyPart: src.melodyPart ?? null };
}
function deserializeSource(s) {
  if (!s) return null;
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
  for (const d of DIFFICULTY_LEVELS) add(String(d.value), `${d.value} · ${d.name}`);
  sel.value = value === null || value === undefined ? (inherit ? '' : 'auto') : String(value);
}

// Feineinstellung pro Stimme: Schwierigkeit, tiefster & höchster Ton (notiert)
function voiceExtras(slot, i, instId) {
  const ex = document.createElement('div');
  ex.className = 'slot-extra';
  const lvl = document.createElement('select');
  lvl.title = 'Schwierigkeit dieser Stimme';
  difficultyOptions(lvl, S.opts.voiceDifficulty?.[i] ?? null, { inherit: 'Stufe: global' });
  [...lvl.options].forEach((o) => o.value && (o.textContent = `Stufe ${o.value}`));
  lvl.addEventListener('change', () => {
    S.opts.voiceDifficulty = S.opts.voiceDifficulty || [null, null, null, null];
    S.opts.voiceDifficulty[i] = lvl.value ? Number(lvl.value) : null;
    lvl.classList.toggle('set', !!lvl.value);
  });
  lvl.classList.toggle('set', !!lvl.value);
  ex.appendChild(lvl);
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
  voiceExtras(slot, 0, S.opts.soloInstrument || 'trumpet');
  box.appendChild(slot);
}

function setEnsemble(ens) {
  S.opts.ensemble = ens;
  $$('#ensemble-tabs .seg').forEach((b) => b.classList.toggle('active', b.dataset.ens === ens));
  $$('.ens-panel').forEach((p) => p.classList.toggle('active', p.dataset.enspanel === ens));
  const solo = ens === 'solo';
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
    length: $('#opt-length').value,
    adapt: Number($('#opt-adapt').value),
    form: $('#opt-form').value,
    tempo,
    transpose: tr === 'auto' ? 'auto' : Number(tr),
    seed: Number($('#opt-seed').value) || 1,
    ensemble: S.opts.ensemble || 'quartet',
    soloInstrument: S.opts.soloInstrument || 'trumpet',
    difficulty: $('#opt-difficulty').value === 'auto' ? 'auto' : Number($('#opt-difficulty').value),
    voiceDifficulty: [...(S.opts.voiceDifficulty || [null, null, null, null])],
    ranges: [...(S.opts.ranges || [null, null, null, null])],
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
  fillSoloSelect($('#opt-solo'), S.opts.voices, o.solo ?? 0);
  $('#opt-drums').checked = !!o.drums;
  $('#opt-length').value = o.length || 'normal';
  $('#opt-adapt').value = String(o.adapt ?? 1);
  $('#opt-form').value = o.form || 'compact';
  $('#opt-tempo').value = o.tempo || '';
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
  for (const s of STYLE_LIST) {
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
function renderDemos() {
  const box = $('#demo-list');
  box.innerHTML = '';
  for (const d of DEMOS) {
    const b = document.createElement('button');
    b.className = 'demo';
    b.dataset.demo = d.id;
    b.innerHTML = `<strong>${d.title}</strong><span>${d.info}</span>`;
    b.addEventListener('click', () => setSource({ name: `${d.id}.abc`, format: 'abc', data: d.abc }, b));
    box.appendChild(b);
  }
}

async function setSource(src, demoBtn = null) {
  try {
    const song = await loadSong(src);
    S.source = src;
    S.song = song;
    $$('.demo').forEach((x) => x.classList.toggle('active', x === demoBtn));
    renderAnalysis();
    fillTransposeSelect();
    if (song.tempo) $('#opt-tempo').placeholder = `auto (${song.tempo})`;
  } catch (e) {
    console.error(e);
    toast('Vorlage konnte nicht gelesen werden: ' + e.message, 'error');
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
  box.innerHTML = `<div class="a-title">${s.title}</div>
    <div class="kv"><span>${keyNameDe(s.key)}${s.keyDetected ? ' (erkannt)' : ''}</span><span>${s.meter.beats}/${s.meter.beatType}</span><span>♩ ${s.tempo || '–'}</span><span>${s.measureCount} Takte${s.pickup ? ' + Auftakt' : ''}</span><span>Form ${form}</span><span>${chordInfo}</span></div>
    ${partsHtml}
    ${(s.warnings || []).map((w) => `<div class="warn">⚠ ${w}</div>`).join('')}`;
  const mp = $('#melody-part');
  if (mp) mp.addEventListener('change', () => setSource({ ...S.source, melodyPart: Number(mp.value) }));
}

async function handleFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(file.name, buf);
  const data = format === 'abc' ? new TextDecoder().decode(buf) : buf;
  await setSource({ name: file.name, format, data });
  toast(`„${S.song?.title || file.name}“ geladen`, 'ok');
}

// ---------------------------------------------------------------- Erzeugen
async function generate({ silent = false } = {}) {
  if (!S.song) {
    toast('Bitte zuerst eine Vorlage wählen.', 'error');
    return;
  }
  const btn = $('#generate');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Arrangiere …';
  await new Promise((r) => setTimeout(r, 30));
  try {
    const opts = readOpts();
    S.opts = { ...S.opts, ...opts };
    const t0 = performance.now();
    S.arr = arrange(S.song, opts);
    console.info(`Arrangement in ${Math.round(performance.now() - t0)} ms`);
    S.printed = printedMeasures(S.arr);
    S.t2p = timelineToPrinted(S.arr, S.printed);
    showResult();
    if (S.settings.autoSave && !silent) await saveCurrent(true);
  } catch (e) {
    console.error(e);
    toast('Fehler beim Arrangieren: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Arrangement erstellen';
  }
}

function showResult() {
  const a = S.arr;
  $('#empty-state').classList.add('hidden');
  $('#result').classList.remove('hidden');
  $('#res-title').textContent = a.meta.title;
  const chips = [
    [a.style.name, 'accent'],
    [keyNameDe(a.key) + (a.transposeShift ? ` (${a.transposeShift > 0 ? '+' : ''}${a.transposeShift})` : ''), ''],
    [`♩ = ${a.tempo}`, ''],
    [`${S.printed.length} Takte gedruckt`, ''],
    [a.soloMode ? `Solo · ${a.voices[0]?.inst.name || 'Schlagzeug'}` : a.voices.map((v) => v.inst.short).join(' · ') + (a.drums ? ' · Schlz.' : ''), ''],
  ];
  $('#res-meta').innerHTML = chips.map(([t, c]) => `<span class="${c}">${t}</span>`).join('');
  // Ansichten
  const vt = $('#view-tabs');
  vt.innerHTML = '';
  let views = [['score', 'Partitur'], ...a.voices.map((v, i) => [String(i), `${i + 1} · ${v.inst.short}`])];
  if (a.drums) views.push(['drums', 'Schlz.']);
  if (a.soloMode) views = a.voices.length ? [['0', `Solo · ${a.voices[0].inst.name}`]] : [['drums', 'Solo · Schlagzeug']];
  if (!views.some(([k]) => k === S.view)) S.view = 'score';
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
  renderNotes();
  renderPlan();
  setupPlayer();
}

function xmlFor(view) {
  const st = S.settings;
  const chords = S.arr.soloMode && st.chords !== 'none' ? 'all' : st.chords;
  const tenorClef = st.tenorClef;
  if (view === 'score') return exportMusicXML(S.arr, { mode: 'score', concert: st.concertScore, paper: st.paper, chords, tenorClef });
  if (view === 'drums') return exportMusicXML(S.arr, { mode: 'part', partIndex: 'drums', paper: st.paper });
  return exportMusicXML(S.arr, { mode: 'part', partIndex: Number(view), paper: st.paper, chords, tenorClef });
}

async function renderNotes() {
  const token = ++S.renderToken;
  const box = $('#pages');
  box.querySelectorAll('.page').forEach((p) => p.remove());
  const loader = $('#loader');
  loader.classList.add('on');
  try {
    const xml = xmlFor(S.view);
    const pages = await renderPages(xml, { paper: S.settings.paper, part: S.view !== 'score', zoom: S.zoom * S.settings.notesZoom, scale: 100 });
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
  } catch (e) {
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
  S.player = new Player(S.arr, {
    onPosition: (sec, bar) => updatePosition(sec, bar),
    onEnd: () => setPlayIcon(false),
  });
  if (prevMix)
    for (const m of prevMix) {
      const p = S.player.part(m.key);
      if (p && p.inst?.id === S.player.part(m.key)?.inst?.id) Object.assign(p, { volume: m.volume, mute: m.mute, solo: m.solo, pan: m.pan });
    }
  $('#player').classList.remove('hidden');
  $('#p-total').textContent = fmtTime(S.player.duration);
  $('#p-seek').value = 0;
  updatePosition(0, 0);
  setPlayIcon(false);
  renderMixer();
}

function setPlayIcon(playing) {
  $('#p-play-icon use').setAttribute('href', playing ? '#i-pause' : '#i-play');
}

let lastHighlight = -1;
function updatePosition(sec, bar) {
  const p = S.player;
  if (!p) return;
  $('#p-time').textContent = fmtTime(sec);
  if (!S.seeking) $('#p-seek').value = Math.round((sec / p.duration) * 1000);
  const idx = S.t2p(bar);
  $('#p-bar').textContent = idx !== null ? `Takt ${idx + 1}` : '';
  if (idx !== lastHighlight) {
    if (lastHighlight >= 0 && S.measureEls[lastHighlight]) S.measureEls[lastHighlight].classList.remove('playing');
    if (idx !== null && S.measureEls[idx] && p.playing) {
      S.measureEls[idx].classList.add('playing');
      if (S.follow) {
        const r = S.measureEls[idx].getBoundingClientRect();
        if (r.top < 90 || r.bottom > window.innerHeight - 120) S.measureEls[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    lastHighlight = p.playing ? idx : -1;
  }
}

function renderMixer() {
  const box = $('#strips');
  box.innerHTML = '';
  S.player.parts.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'strip';
    el.innerHTML = `<div class="s-name" style="color:${VOICE_COLORS[i]}">${p.key === 'drums' ? 'Schlagzeug' : `Stimme ${i + 1}`}<div class="s-sub">${p.inst ? p.inst.name : 'Drums'}</div></div>
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
  const partName = (i) => `Stimme_${i + 1}_${safeName(a.voices[i].inst.name)}`;
  try {
    toast('Export wird erstellt …');
    if (kind === 'mscz-zip') {
      const files = a.soloMode ? [] : [{ name: `${base}_Partitur.musicxml`, data: xmlFor('score') }];
      a.voices.forEach((_, i) => files.push({ name: `${base}_${a.soloMode ? 'Solo_' + safeName(a.voices[i].inst.name) : partName(i)}.musicxml`, data: xmlFor(String(i)) }));
      if (a.drums) files.push({ name: `${base}_Schlagzeug.musicxml`, data: exportMusicXML(a, { mode: 'part', partIndex: 'drums', paper: st.paper }) });
      files.push({ name: `${base}.mid`, data: exportMidi(a) });
      files.push({ name: `${base}_Regieplan.md`, data: planMarkdown(a) });
      download(`${base}_MuseScore.zip`, zip(files), 'application/zip');
    } else if (kind === 'xml-current') {
      download(`${base}_${viewLabel()}.musicxml`, xmlFor(S.view), 'application/vnd.recordare.musicxml+xml');
    } else if (kind === 'pdf-current') {
      const pdf = await xmlsToPdf([{ xml: xmlFor(S.view), part: S.view !== 'score' }], { paper: st.paper, zoom: st.notesZoom, title: a.meta.title });
      download(`${base}_${viewLabel()}.pdf`, pdf, 'application/pdf');
    } else if (kind === 'pdf-all') {
      const list = [...(a.soloMode ? [] : [{ xml: xmlFor('score'), part: false }]), ...a.voices.map((_, i) => ({ xml: xmlFor(String(i)), part: true }))];
      if (a.drums) list.push({ xml: xmlFor('drums'), part: true });
      const pdf = await xmlsToPdf(list, { paper: st.paper, zoom: st.notesZoom, title: a.meta.title });
      download(`${base}_komplett.pdf`, pdf, 'application/pdf');
    } else if (kind === 'png-current') {
      const pngs = await pagesToPngs(xmlFor(S.view), { paper: st.paper, part: S.view !== 'score', zoom: st.notesZoom });
      if (pngs.length === 1) download(`${base}_${viewLabel()}.png`, pngs[0], 'image/png');
      else download(`${base}_${viewLabel()}_Bilder.zip`, zip(pngs.map((d, i) => ({ name: `${base}_${viewLabel()}_Seite_${i + 1}.png`, data: d }))), 'application/zip');
    } else if (kind === 'midi') {
      download(`${base}.mid`, exportMidi(a), 'audio/midi');
    } else if (kind === 'plan') {
      download(`${base}_Regieplan.md`, planMarkdown(a), 'text/markdown');
    }
  } catch (e) {
    console.error(e);
    toast('Export fehlgeschlagen: ' + e.message, 'error');
  }
}

function viewLabel() {
  if (S.view === 'score') return 'Partitur';
  if (S.view === 'drums') return 'Schlagzeug';
  const i = Number(S.view);
  if (S.arr.soloMode) return `Solo_${safeName(S.arr.voices[i].inst.name)}`;
  return `Stimme_${i + 1}_${safeName(S.arr.voices[i].inst.name)}`;
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
    summary: { style: a.style.name, styleId: a.style.id, voices: a.soloMode ? [`Solo: ${a.voices[0]?.inst.name || 'Schlagzeug'}`] : a.voices.map((v) => v.inst.name), drums: !!a.drums && !a.soloMode, key: keyNameDe(a.key), bars: S.printed.length, tempo: a.tempo },
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
      <h3>${it.title}</h3>
      <div class="lib-meta">${(sm.voices || []).join(', ')}${sm.drums ? ', Schlagzeug' : ''}</div>
      <div class="lib-meta">${date}${it.dirty && S.library.cloud.user ? ' · wird synchronisiert' : ''}</div>
      <div class="lib-actions"><button class="btn primary small open">Öffnen</button><button class="btn ghost small danger del"><svg><use href="#i-trash"/></svg></button></div>`;
    $('.open', card).addEventListener('click', () => openItem(it.id));
    $('.del', card).addEventListener('click', async () => {
      if (!confirm(`„${it.title}“ wirklich löschen?`)) return;
      await S.library.remove(it.id);
      if (S.currentId === it.id) S.currentId = null;
      renderLibrary();
    });
    box.appendChild(card);
  }
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
  ss.innerHTML = STYLE_LIST.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  ss.value = st.defaultStyle;
  fillSoloSelect($('#set-solo'), st.defaultVoices, st.defaultSolo);
  $('#set-length').value = st.defaultLength;
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
  on('#set-length', (e) => update({ defaultLength: e.target.value }));
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
  };
  renderDemos();
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
  $('#abc-input').value = DEMOS[1].abc;
  $('#abc-load').addEventListener('click', () => setSource({ name: 'eingabe.abc', format: 'abc', data: $('#abc-input').value }));
  // Demo vorauswählen
  setSource({ name: `${DEMOS[0].id}.abc`, format: 'abc', data: DEMOS[0].abc }, $('.demo'));

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
    const idx = S.measureEls.indexOf(m);
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
    S.measureEls.forEach((m) => m.classList.remove('playing'));
  });
  const seek = $('#p-seek');
  seek.addEventListener('input', () => (S.seeking = true));
  seek.addEventListener('change', () => {
    S.seeking = false;
    S.player?.seekSec((seek.value / 1000) * S.player.duration);
  });
  $('#p-speed').addEventListener('input', (e) => {
    $('#p-speed-label').textContent = `${e.target.value} %`;
    S.player?.setSpeed(e.target.value / 100);
  });
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
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
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
