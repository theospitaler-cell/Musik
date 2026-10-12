// NoteCode – App-Steuerung (Oberfläche).
import { INSTRUMENTS, PRESETS, FAMILIES, writtenRangeChoices } from '../arrange/instruments.js';
import { DIFFICULTY_LEVELS } from '../arrange/difficulty.js';
import { loadSong, detectFormat } from '../input/index.js';
import { arrange, usesFaithful } from '../arrange/engine.js';
import { playAlongSources, defaultPlayParts } from '../arrange/playalong.js';
import { decodeAudio, analyzeAudio } from './audio-import.js';
import { platform, localVersion, checkUpdate, applyUpdate } from './updater.js';
import { exportMusicXML } from '../output/musicxml.js';
import { exportMidi } from '../output/midi.js';
import { buildPlan, planMarkdown } from '../output/report.js';
import { printedMeasures, timelineToPrinted } from '../output/form.js';
import { zip } from '../core/zip.js';
import { keyNameDe, transposeKey } from '../theory/keys.js';
import { shiftDownbeat, scaleNoteValues } from '../model/retime.js';
import { ANALYSIS_VERSION } from '../input/audio.js';
import { Player } from './player.js';
import { TaskList, formatEta, learnSpeed } from './tasks.js';
import { EFFORT, effortOf } from '../core/effort.js';
import { arrangeBest } from '../arrange/best.js';
import { interpretFeedback, sanitizeTweaks, mergeTweaks, applyTweaks } from '../arrange/feedback.js';
import { ScoreFollower } from './follow.js';
import { bindPractice, syncPractice } from './practice.js';
import { openAudioExport } from './audio-dialog.js';
import { renderPages, responsiveSvg, pagesToPngs, xmlsToPdf, loadVerovio } from './render.js';
import { LocalStore, Library } from './store.js';
import { loadSettings, saveSettings } from './settings.js';
import { STEM_MODES, normalizeStemMode, describeHardware, resolveStemPlan } from '../input/stems.js';
import { MIN_VOICES, MAX_VOICES, voiceRole, ensembleName, resizeVoices, presetVoices, matchingPreset, carryPerVoice } from './voices.js';
import { groupLibrary, mergeFolders, sameFolders, songTitleOf, uniqueFolderName } from './folders.js';
import { orchestrateFromOptions } from '../engine/index.js';
import { MIN_VOICES as MIN_ENS, MAX_VOICES as MAX_ENS, ENSEMBLE_PRESETS, ensembleLabel, applyPreset, resizeEnsemble, matchPreset, slotInfo, instrumentOptions } from '../engine/ensembles.js';
import { hasMeterChanges } from '../model/song.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const VOICE_COLORS = ['#1f3a5f', '#4f6d8f', '#8a6a2f', '#5b5f66', '#2f7d4f', '#7a4a5c', '#3f6f73', '#6a5f8f'];

const S = {
  settings: null,
  library: null,
  local: null,
  player: null,
  renderToken: 0,
  follower: null, // Mitlesen: Takt-Markierung, Cursor, automatisches Umblättern
  follow: true,
  tabs: [], // geöffnete Lieder – jedes mit eigenem, vollständigem Zustand
  tab: null, // aktiver Tab
  busy: 0, // laufende Vorgänge (Laden, Arrangieren) – solange kein Tab-Wechsel
  libFolder: null, // geöffneter Ordner der Bibliothek: { type: 'user' | 'auto', id | key }
};

// Zustand, der zu einem Lied/Tab gehört: S.song usw. lesen und schreiben immer im aktiven Tab
const TAB_KEYS = ['source', 'song', 'opts', 'arr', 'view', 'zoom', 'currentId', 'measureEls', 'printed', 't2p', 'audioUrl', 'audioFor'];
for (const k of TAB_KEYS)
  Object.defineProperty(S, k, {
    get: () => S.tab[k],
    set: (v) => {
      S.tab[k] = v;
    },
    enumerable: true,
  });

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
// Eine Anzeige für alles, was dauert – mit einer Zeile je Aufgabe (eigener Balken, geschätzte
// Restzeit, Zusatztext). Die Balken laufen stetig weiter und springen nie zurück (siehe tasks.js).
// Ein neuer Vorgang übernimmt die Anzeige. Kommt zu lange keine Rückmeldung, erscheint eine
// Fehlermeldung statt eines eingefrorenen Balkens.
let progressJob = 0;
const PROGRESS_STALL_MS = 90000;
let progressTick = null;

// gelernte Geschwindigkeiten (ms je Sekunde Audio) – damit die Zeitschätzung mit der Zeit stimmt
const SPEED_KEY = 'notecode:speed';
const speedStore = (() => {
  try {
    return JSON.parse(localStorage.getItem(SPEED_KEY) || '{}') || {};
  } catch {
    return {};
  }
})();
const speedOf = (key, def) => (Number.isFinite(speedStore[key]) && speedStore[key] > 0 ? speedStore[key] : def);
function rememberSpeed(key, ms, units) {
  learnSpeed(speedStore, key, ms, units);
  try {
    localStorage.setItem(SPEED_KEY, JSON.stringify(speedStore));
  } catch {
    /* kein Speicher */
  }
}

// tasks: [{ id, label, expect (ms) }]; ohne Liste eine einzelne Aufgabe mit dem Titel
function progress(title, { tasks = null, cancellable = true } = {}) {
  const id = ++progressJob;
  const box = $('#progress');
  const list = new TaskList(tasks && tasks.length ? tasks : [{ id: 'main', label: title, expect: 8000 }]);
  const single = !(tasks && tasks.length);
  $('#pg-title').textContent = title;
  $('#pg-text').textContent = '';
  $('#pg-total').textContent = '';
  const cb = $('#pg-cancel');
  if (S.job) S.job.locked = false;
  cb.disabled = false;
  cb.classList.toggle('hidden', !(cancellable && S.job));
  cb.onclick = () => cancelJob();
  box.classList.remove('hidden', 'stalled');
  box.classList.toggle('single', single);
  const host = $('#pg-tasks');
  host.innerHTML = '';
  const rows = new Map();
  for (const t of list.tasks) {
    const el = document.createElement('div');
    el.className = 'pg-task wait';
    el.innerHTML = '<span class="pg-ico" aria-hidden="true"></span><span class="pg-label"></span><span class="pg-eta"></span><div class="pg-bar"><i></i></div><small class="pg-detail"></small>';
    el.querySelector('.pg-label').textContent = t.label;
    host.appendChild(el);
    rows.set(t.id, {
      el,
      bar: el.querySelector('.pg-bar i'),
      eta: el.querySelector('.pg-eta'),
      detail: el.querySelector('.pg-detail'),
      state: 'wait',
      etaText: '',
      detailText: '',
    });
  }
  let last = Date.now();
  const paint = () => {
    for (const v of list.view()) {
      const r = rows.get(v.id);
      if (!r) continue;
      if (r.state !== v.state) {
        r.el.className = `pg-task ${v.state}`;
        r.state = v.state;
      }
      r.bar.style.width = `${(v.shown * 100).toFixed(1)}%`;
      const et = v.state === 'done' ? 'fertig' : v.state === 'wait' ? formatEta(v.etaMs).replace('noch ', '') : formatEta(v.etaMs);
      if (et !== r.etaText) {
        r.etaText = et;
        r.eta.textContent = et;
      }
      if (v.detail !== r.detailText) {
        r.detailText = v.detail;
        r.detail.textContent = v.detail;
      }
    }
    const rest = list.totalEta();
    $('#pg-total').textContent = list.tasks.length > 1 ? formatEta(rest).replace('noch ca. ', 'Gesamt noch ca. ') : '';
  };
  clearInterval(progressTick);
  progressTick = setInterval(() => {
    if (id !== progressJob) return;
    const now = Date.now();
    const dt = Math.min(500, now - last);
    last = now;
    list.update(dt);
    if (list.idleMs() > PROGRESS_STALL_MS) {
      if (!box.classList.contains('stalled')) {
        box.classList.add('stalled');
        $('#pg-text').textContent = 'Keine Rückmeldung – der Vorgang hängt. Bitte App neu starten oder eine andere Datei versuchen.';
      }
    }
    paint();
  }, 100);
  const first = () => list.tasks[0].id;
  const api = {
    // set(id, frac, detail) für Aufgaben; set(text, frac) wie bisher (erste/aktive Aufgabe)
    set(a, frac = null, detail = null) {
      if (id !== progressJob) return api;
      box.classList.remove('stalled');
      if (list.get(a)) {
        list.set(a, frac, detail);
      } else {
        const t = list.tasks.find((x) => x.state === 'run') || list.get(first());
        list.set(t.id, frac, single ? null : null);
        if (a !== undefined && a !== null) {
          if (single) $('#pg-text').textContent = a;
          else t.detail = a;
        }
      }
      return api;
    },
    start(taskId, expect = null) {
      if (id === progressJob) list.start(taskId, expect);
      return api;
    },
    done(taskId = null) {
      if (id !== progressJob) return api;
      if (taskId) {
        list.done(taskId);
        return api;
      }
      list.finish();
      list.update(1000);
      paint();
      clearInterval(progressTick);
      box.classList.add('hidden');
      box.classList.remove('stalled');
      return api;
    },
    title(t) {
      if (id === progressJob) $('#pg-title').textContent = t;
      return api;
    },
    text(t) {
      if (id === progressJob) $('#pg-text').textContent = t;
      return api;
    },
    list,
  };
  list.start(first());
  paint();
  return api;
}
const nextFrame = () =>
  new Promise((r) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setTimeout(r, 0);
    };
    requestAnimationFrame(go);
    setTimeout(go, 120);
  });

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
  if (name === 'arrange' && S.tab?.pendingId && !S.song) loadPending(S.tab);
}

// ---------------------------------------------------------------- Tabs (geöffnete Lieder)
// Jeder Tab hat seinen eigenen Zustand: Vorlage, Optionen, Arrangement, Ansicht,
// gesetzte Notenseiten und Mischpult. Ein Wechsel rechnet nichts neu.
const TABS_KEY = 'notecode:tabs';
const BUSY_MSG = 'Ein Vorgang läuft noch.';

// ---- Laufender Vorgang: abbrechbar; Knöpfe sperren nie ohne Ausweg
// busyStart/busyEnd klammern jeden langen Vorgang (auch verschachtelt, z. B. Überarbeiten =
// Analyse + Arrangieren). Abbrechen setzt das AbortSignal; die Arbeit bricht an der nächsten
// Stelle ab (zwischen KI-Fenstern, Fassungen, Durchgängen) und verändert nichts am bisherigen Stand.
function busyStart() {
  if (!S.busy) S.job = { ctl: new AbortController(), locked: false };
  S.busy++;
}
function busyEnd() {
  S.busy = Math.max(0, S.busy - 1);
  if (!S.busy) S.job = null;
}
const jobSignal = () => S.job?.ctl.signal ?? null;
const isAbort = (e) => !!e && e.name === 'AbortError';
function cancelJob() {
  if (!S.job || S.job.locked) return;
  S.job.ctl.abort();
  $('#pg-text').textContent = 'Wird abgebrochen …';
  const btn = $('#pg-cancel');
  if (btn) btn.disabled = true;
}
// ab hier ist der Vorgang im Endspurt (Noten werden gesetzt) und nicht mehr abbrechbar
function lockJob() {
  if (S.job) S.job.locked = true;
  $('#pg-cancel')?.classList.add('hidden');
}
// abbrechen und warten, bis alles zur Ruhe gekommen ist (höchstens ~20 s)
function cancelAndWait() {
  if (!S.busy) return Promise.resolve();
  if (S.job && !S.job.locked) S.job.ctl.abort();
  toast('Vorgang wird abgebrochen …');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (!S.busy || Date.now() - t0 > 20000) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
  });
}
// statt „bitte warten“: der Nutzer kann den laufenden Vorgang abbrechen (und dann weitermachen)
function busyToast(then = null) {
  toast(BUSY_MSG, '', {
    label: then ? 'Abbrechen & weiter' : 'Abbrechen',
    run: async () => {
      if (!then) return cancelJob();
      await cancelAndWait();
      then();
    },
  });
}
let tabSeq = 0;

function defaultOpts() {
  const st = S.settings;
  return {
    voices: [...st.defaultVoices],
    engine: 'orchestra', // 'orchestra' = Orchestrierungs-Engine (1–15 Stimmen), 'classic' = Stile, Soli, Original übernehmen
    preset: null, // Ensemble-Vorlage (wird aus der Besetzung erkannt)
    style: 'auto', // der Stil wird immer automatisch passend zum Lied gewählt
    drums: st.defaultDrums,
    solo: st.defaultSolo,
    length: st.defaultLength,
    adapt: st.defaultAdapt,
    form: st.form,
    transpose: st.transposeAuto ? 'auto' : 0,
    seed: 1,
    ensemble: 'quartet',
    soloInstrument: st.defaultVoices[0] || 'trumpet',
    difficulty: st.defaultDifficulty ?? 'auto',
    voiceDifficulty: [],
    ranges: [],
    original: false,
    playback: false,
    playParts: null,
    drumFills: false,
  };
}

function makeTab(opts = defaultOpts()) {
  return {
    id: `t${++tabSeq}`,
    source: null,
    song: null,
    opts,
    arr: null,
    view: 'score',
    zoom: 1,
    currentId: null,
    measureEls: [],
    printed: [],
    t2p: () => null,
    audioUrl: null,
    audioFor: null,
    folder: null, // Ordner, in dem neue Arrangements dieses Tabs landen
    pendingId: null, // gespeichertes Arrangement, das beim ersten Öffnen geladen wird
    pendingTitle: null,
    pages: null, // gesetzte Notenseiten (DOM) für einen schnellen Wechsel
    pagesKey: null,
    mix: null,
    panel: 'notes',
    scrollY: 0,
    abcText: '',
    srcTab: 'file',
  };
}

// Einstellungen des aktiven Tabs für ein weiteres Lied übernehmen
function inheritOpts() {
  const o = { ...S.opts, ...readOpts(), tempo: null, title: null, playParts: null };
  for (const k of EXTRA_OPT_KEYS) delete o[k]; // Wünsche gehören zu diesem Lied
  return o;
}

const tabInUse = (t) => !!(t.song || t.arr || t.pendingId || t.currentId);

function tabTitle(t) {
  return t.arr?.meta?.title || t.song?.title || t.pendingTitle || 'Neues Projekt';
}

function tabSub(t) {
  const o = t.opts || {};
  const ens =
    o.ensemble === 'solo'
      ? `Solo · ${o.soloInstrument === 'drums' ? 'Schlagzeug' : INSTRUMENTS[o.soloInstrument]?.short || ''}`
      : o.ensemble === 'drums'
        ? 'Schlagzeug'
        : `${ensembleLabel(o.voices?.length || 4)}${o.original ? ' · Original' : ''}`;
  if (t.pendingId && !t.song) return `${ens} · gespeichert`;
  return t.song ? ens : `${ens} · noch kein Song`;
}

function renderTabBar() {
  const list = $('#song-tab-list');
  if (!list || !S.tab) return;
  list.innerHTML = '';
  for (const t of S.tabs) {
    const el = document.createElement('div');
    el.className = 'song-tab' + (t === S.tab ? ' active' : '') + (t.arr ? ' ready' : '');
    el.dataset.tab = t.id;
    const b = document.createElement('button');
    b.className = 'st-main';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t === S.tab));
    b.title = tabTitle(t);
    b.innerHTML = '<span class="st-title"></span><span class="st-sub"></span>';
    $('.st-title', b).textContent = tabTitle(t);
    $('.st-sub', b).textContent = tabSub(t);
    b.addEventListener('click', () => activateTab(t));
    const x = document.createElement('button');
    x.className = 'st-close';
    x.title = 'Tab schließen';
    x.setAttribute('aria-label', `„${tabTitle(t)}“ schließen`);
    x.innerHTML = '<svg><use href="#i-x"/></svg>';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t);
    });
    // mittlere Maustaste schließt wie im Browser
    el.addEventListener('auxclick', (e) => e.button === 1 && closeTab(t));
    el.append(b, x);
    list.appendChild(el);
  }
  $('#song-tabs').classList.toggle('busy', S.busy > 0);
  // aktiven Tab in den sichtbaren Bereich schieben (nur waagerecht)
  const act = $('.song-tab.active', list);
  if (act) {
    const l = act.offsetLeft;
    const r = l + act.offsetWidth;
    if (l < list.scrollLeft) list.scrollLeft = l - 12;
    else if (r > list.scrollLeft + list.clientWidth) list.scrollLeft = r - list.clientWidth + 12;
  }
}

function persistTabs() {
  try {
    const ids = [...new Set(S.tabs.map((t) => t.currentId || t.pendingId).filter(Boolean))];
    localStorage.setItem(TABS_KEY, JSON.stringify({ ids, active: S.tab?.currentId || S.tab?.pendingId || null }));
  } catch {
    /* kein Speicher (privater Modus) – Tabs gelten nur für diese Sitzung */
  }
}

function readSavedTabs() {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) || 'null');
    return v && Array.isArray(v.ids) ? v : null;
  } catch {
    return null;
  }
}

function selectPanel(name) {
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tabpanel === name));
}

function selectSourceTab(name) {
  $$('#source-tabs .seg').forEach((x) => x.classList.toggle('active', x.dataset.src === name));
  $$('.src-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}

// Wiedergabe beenden (beim Tab-Wechsel) – das Mischpult des Tabs bleibt gemerkt
function stopPlayer() {
  if (S.player) {
    S.tab.mix = S.player.parts.map((p) => ({ key: String(p.key), volume: p.volume, mute: p.mute, solo: p.solo, pan: p.pan }));
    S.player.dispose();
    S.player = null;
    window.__player = null;
  }
  setPlayIcon(false);
  S.follower?.clear();
  $('#player').classList.add('hidden');
  $('#mixer').classList.remove('open');
}

// Zustand aus der Oberfläche in den aktiven Tab übernehmen, bevor gewechselt wird
function stashTab() {
  const t = S.tab;
  if (!t) return;
  t.opts = { ...t.opts, ...readOpts() };
  t.abcText = $('#abc-input').value;
  t.srcTab = $('#source-tabs .seg.active')?.dataset.src || 'file';
  t.panel = $('.tab.active')?.dataset.tab || 'notes';
  t.scrollY = window.scrollY;
  S.renderToken++; // laufendes Notensetzen dieses Tabs verwerfen
  t.pages = $$('#pages .page');
  t.pages.forEach((p) => p.remove());
  S.measureEls.forEach((m) => m.classList.remove('playing'));
  stopPlayer();
}

// aktiven Tab anzeigen – ohne neu zu arrangieren
async function showTab() {
  const t = S.tab;
  applyOptsToUi(t.opts);
  $('#abc-input').value = t.abcText || '';
  selectSourceTab(t.srcTab || 'file');
  $('#file-input').value = '';
  if (S.song) renderAnalysis();
  else {
    $('#analysis').classList.add('hidden');
    $('#analysis').innerHTML = '';
  }
  $('#opt-tempo').placeholder = S.song?.tempo ? `Auto (♩ ${S.song.tempo})` : 'Automatisch';
  $('#generate').disabled = !S.song;
  $('#zoom-label').textContent = `${Math.round(S.zoom * 100)} %`;
  selectPanel(t.panel || 'notes');
  refreshEmptyState();
  renderTabBar();
  persistTabs();
  if (S.arr) await showResult(null, { restore: true });
  else {
    $('#result').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
  }
  if (S.tab === t) window.scrollTo({ top: Math.min(t.scrollY || 0, document.body.scrollHeight) });
  if (t.pendingId && !S.song && $('#view-arrange').classList.contains('active')) await loadPending(t);
}

async function activateTab(t) {
  if (!t || t === S.tab) return;
  if (S.busy) return busyToast(() => activateTab(t));
  stashTab();
  S.tab = t;
  await showTab();
}

async function openTab(t) {
  S.tabs.push(t);
  await activateTab(t);
}

async function closeTab(t) {
  let idx = S.tabs.indexOf(t);
  if (idx < 0) return;
  const active = t === S.tab;
  // läuft im aktiven Tab gerade ein Vorgang, wird er abgebrochen – Schließen geht immer
  if (active && S.busy) {
    await cancelAndWait();
    idx = S.tabs.indexOf(t);
    if (idx < 0) return;
  }
  if (active) stashTab();
  S.tabs.splice(idx, 1);
  let blank = null;
  if (!S.tabs.length) S.tabs.push((blank = makeTab()));
  if (active) {
    S.tab = S.tabs[Math.min(idx, S.tabs.length - 1)];
    showTab();
  } else {
    renderTabBar();
    persistTabs();
  }
  if (!tabInUse(t)) return;
  let undone = false;
  toast(`„${tabTitle(t)}“ geschlossen`, '', {
    label: 'Rückgängig',
    run: () => {
      undone = true;
      // der leere Ersatz-Tab wird nicht mehr gebraucht
      if (blank && S.tab === blank && S.tabs.length === 1 && !tabInUse(blank) && !S.busy) {
        stashTab();
        S.tabs = [t];
        S.tab = t;
        showTab();
        return;
      }
      S.tabs.splice(Math.min(idx, S.tabs.length), 0, t);
      if (S.busy) {
        renderTabBar();
        persistTabs();
      } else activateTab(t);
    },
  });
  // Aufnahme erst freigeben, wenn das Rückgängig-Fenster vorbei ist
  setTimeout(() => {
    if (!undone && t.audioUrl && !S.tabs.includes(t)) URL.revokeObjectURL(t.audioUrl);
  }, 7000);
}

// Neues Projekt: neuer, leerer Tab mit Auswahl der Besetzung
// force: der „+“-Knopf öffnet immer einen weiteren Tab (wie im Browser)
async function startNew({ folder = null, force = false } = {}) {
  showView('arrange');
  if (!tabInUse(S.tab) && !(force && S.tabs.length < 12)) {
    S.tab.folder = folder;
    refreshEmptyState();
    $('#count-chooser').classList.add('pulse');
    setTimeout(() => $('#count-chooser').classList.remove('pulse'), 900);
    return;
  }
  if (S.busy) return busyToast(() => startNew({ folder, force }));
  const t = makeTab();
  t.folder = folder;
  await openTab(t);
  window.scrollTo({ top: 0 });
}

// Start-Bildschirm eines Tabs ohne Arrangement
function refreshEmptyState() {
  const t = S.tab;
  if (!t) return;
  const has = !!S.song;
  const pending = !!t.pendingId && !has;
  $('#es-title').textContent = pending ? `„${t.pendingTitle || 'Arrangement'}“ wird geöffnet …` : has ? `„${S.song.title}“ ist geladen` : 'Neues Projekt';
  $('#es-text').textContent = has
    ? 'Stelle links Besetzung (1 bis 15 Stimmen), Tempo und Tonart ein – oder wähle hier nur die Anzahl der Instrumente – und erstelle dann die Noten.'
    : 'Wähle, wie viele Instrumente spielen, und lade einen Song – NoteCode schreibt die Noten: Arrangement mit Intro, Gegenstimmen, Solo und Schluss, Solo-Noten oder Playback 1:1 zum Mitspielen.';
  $('#es-file span').textContent = has ? 'Anderen Song wählen …' : 'Song wählen …';
  $('#es-file').classList.toggle('primary', !has);
  $('#es-file').classList.toggle('ghost', has);
  $('#es-generate').classList.toggle('hidden', !has);
  $('#es-hint').classList.toggle('hidden', has);
  $('#count-chooser').classList.toggle('hidden', pending);
  $('#empty-state').classList.toggle('pending', pending);
  $('#arrange-grid').classList.toggle('no-result', !S.arr);
  renderCountChooser();
}


// "Wie viele Instrumente?" – 1 = Lead Sheet, 2–8 Ensemble, Orchester, Solo (Übungsnoten), Schlagzeug
function renderCountChooser() {
  const box = $('#cc-grid');
  if (!box || !S.opts) return;
  const ens = S.opts.ensemble;
  const n0 = S.opts.voices.length;
  const cur = ens === 'solo' ? 'solo' : ens === 'drums' ? 'drums' : n0 > 8 ? 'orch' : n0;
  box.innerHTML = '';
  const items = [];
  for (let n = MIN_ENS; n <= 8; n++) items.push([n, ensembleLabel(n)]);
  items.push(['orch', 'Orchester']);
  items.push(['solo', 'Solo']);
  items.push(['drums', 'Schlagzeug']);
  for (const [k, name] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cc-tile' + (k === cur ? ' active' : '') + (k === 'drums' ? ' drums' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === cur));
    if (k === 'drums') b.innerHTML = `<svg><use href="#i-drum"/></svg><small>${name}</small>`;
    else if (k === 'solo') b.innerHTML = `<svg><use href="#i-music"/></svg><small>${name}</small>`;
    else if (k === 'orch') b.innerHTML = `<strong>${n0 > 8 ? n0 : '9+'}</strong><small>${name}</small>`;
    else b.innerHTML = `<strong>${k}</strong><small>${name}</small>`;
    b.addEventListener('click', () => pickCount(k));
    box.appendChild(b);
  }
}


// Großes Blasorchester: bleibt die Anzahl im Bereich 9–15, gilt sie weiter, sonst 13 Stimmen
function useOrchestra() {
  const r = applyPreset('orchestra', S.opts.voices.length);
  setVoices(r.voices, r.preset);
  toast(`Besetzung: Blasorchester · ${r.voices.length} Stimmen`);
}


function pickCount(k) {
  if (k === 'solo') setEnsemble('solo');
  else if (k === 'drums') setEnsemble('drums');
  else {
    if (S.opts.ensemble !== 'quartet') setEnsemble('quartet');
    if (k === 'orch') useOrchestra();
    else setVoiceCount(k);
  }
  renderCountChooser();
}

// gespeichertes Arrangement in seinen Tab laden (beim ersten Anzeigen)
async function loadPending(t) {
  if (t.loading) return;
  t.loading = true;
  busyStart();
  renderTabBar();
  try {
    const it = await S.library.get(t.pendingId);
    if (!it || it.deleted) {
      t.pendingId = null;
      toast('Dieses Arrangement gibt es nicht mehr in der Bibliothek.', 'error');
      return;
    }
    const ok = await setSource(deserializeSource(it.source));
    t.pendingId = null;
    t.folder = it.folder || null;
    if (!ok) return;
    applyOptsToUi(it.options || {});
    S.currentId = it.id;
    // ältere Analyse einer Aufnahme: einmalig mit der aktuellen Erkennung neu berechnen
    // (nur bei älterem Stand – lief die Analyse hier ohne KI, bleibt es beim Knopf „Neu analysieren“)
    const renewed = S.song?.source === 'audio' && (S.song.analysisVersion || 1) < ANALYSIS_VERSION && S.source?.audioId && !noAutoRenew(S.source.audioId) ? await reanalyze({ auto: true }) : false;
    if (renewed) {
      applyOptsToUi(it.options || {});
      S.currentId = it.id;
    }
    await generate({ silent: true });
    if (renewed && S.arr) await saveCurrent(true);
  } finally {
    t.loading = false;
    busyEnd();
    if (S.tab === t) refreshEmptyState();
    renderTabBar();
    persistTabs();
  }
}

// gespeicherte Tabs beim Start wiederherstellen (geladen wird erst beim Anzeigen)
async function restoreTabs() {
  const saved = readSavedTabs();
  const tabs = [];
  for (const id of (saved?.ids || []).slice(0, 12)) {
    const it = await S.library.get(id);
    if (!it || it.deleted) continue;
    const t = makeTab({ ...defaultOpts(), engine: 'classic', ...(it.options || {}) });
    t.pendingId = id;
    t.pendingTitle = it.title;
    t.folder = it.folder || null;
    tabs.push(t);
  }
  if (tabs.length && !tabInUse(S.tab) && !S.busy) {
    S.tabs = tabs;
    S.tab = tabs.find((t) => t.pendingId === saved.active) || tabs[0];
    await showTab();
  } else {
    renderTabBar();
    refreshEmptyState();
    persistTabs();
  }
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
      S.opts.voiceDifficulty = S.opts.voiceDifficulty || [];
      S.opts.voiceDifficulty[i] = lvl.value ? Number(lvl.value) : null;
      lvl.classList.toggle('set', !!lvl.value);
      updateFineSummary();
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
        S.opts.ranges = S.opts.ranges || [];
        const r = { ...(S.opts.ranges[i] || { lo: null, hi: null }) };
        r[kind] = sel.value ? Number(sel.value) : null;
        S.opts.ranges[i] = r.lo === null && r.hi === null ? null : r;
        sel.classList.toggle('set', !!sel.value);
        updateFineSummary();
      });
      return sel;
    };
    ex.appendChild(mk('lo'));
    ex.appendChild(mk('hi'));
  }
  slot.appendChild(ex);
  return ex;
}

// Instrumente der Besetzung (Feineinstellungen je Stimme stehen in Schritt 4)
function renderVoiceGrid(container, voices, onChange, { extras = false } = {}) {
  container.innerHTML = '';
  voices.forEach((id, i) => {
    const slot = document.createElement('div');
    slot.className = 'voice-slot';
    const lab = document.createElement('div');
    lab.className = 'vlabel';
    lab.innerHTML = `<i style="background:${VOICE_COLORS[i % VOICE_COLORS.length]}"></i><b>${i + 1}</b><span>${voiceRole(i, voices.length)}</span>`;
    slot.appendChild(lab);
    slot.appendChild(
      instrumentSelect(id, (v) => {
        voices[i] = v;
        // neues Instrument -> Tonumfang wieder automatisch
        if (extras && S.opts.ranges) S.opts.ranges[i] = null;
        onChange(voices);
        if (extras) renderFineList();
      }),
    );
    container.appendChild(slot);
  });
}

// Anzahl der Stimmen (2–8) als Segment-Leiste
function renderVoiceCount(box, n, onPick) {
  box.innerHTML = '';
  for (let k = MIN_VOICES; k <= MAX_VOICES; k++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg' + (k === n ? ' active' : '');
    b.textContent = String(k);
    b.title = `${k} Stimmen (${ensembleName(k)})`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === n));
    b.addEventListener('click', () => onPick(k));
    box.appendChild(b);
  }
}


// Anzahl ändern: folgt die Besetzung der Vorlage, folgt sie weiter; eigene Wahl bleibt erhalten
function setVoiceCount(n) {
  const r = resizeEnsemble(S.opts.voices, n, S.opts.preset);
  if (r.voices.join() === S.opts.voices.join() && r.preset === S.opts.preset) return;
  setVoices(r.voices, r.preset);
}

// Besetzung setzen: Feineinstellungen wandern mit ihrem Instrument, die Vorlage wird erkannt
function setVoices(next, preset = null) {
  const old = [...S.opts.voices];
  S.opts.voiceDifficulty = carryPerVoice(old, next, S.opts.voiceDifficulty);
  S.opts.ranges = carryPerVoice(old, next, S.opts.ranges);
  S.opts.voices = [...next];
  S.opts.preset = preset || matchPreset(next, S.opts.preset);
  // die klassischen Methoden brauchen mindestens zwei Stimmen
  if (next.length < 2 && S.opts.engine !== 'orchestra') setMethod('orchestra', { quiet: true });
  const solo = $('#opt-solo').value;
  if (S.opts.ensemble !== 'solo') fillSoloSelect($('#opt-solo'), next, /^\d+$/.test(solo) && Number(solo) >= next.length ? 0 : solo);
  renderBand();
  renderTabBar();
}

function pickPreset(id) {
  const r = applyPreset(id, S.opts.voices.length);
  setVoices(r.voices, r.preset);
  const p = ENSEMBLE_PRESETS.find((x) => x.id === id);
  toast(`Besetzung: ${p.name} · ${ensembleLabel(r.voices.length)}`);
}

const ROLE_CLASS = { lead: 'lead', double8: 'lead', doubleU: 'lead', counter: 'counter', inner: 'inner', bass: 'bass', bass8vb: 'bass' };

// Zeilen der Stimmen: Instrument (Auswahl aus den Profilen), erkannte Rolle, Schlüssel & Transposition
function renderSlots() {
  const box = $('#voice-grid');
  box.innerHTML = '';
  const voices = S.opts.voices;
  const groups = instrumentOptions();
  voices.forEach((id, i) => {
    const info = slotInfo(voices, i);
    const slot = document.createElement('div');
    slot.className = 'voice-slot';
    const lab = document.createElement('div');
    lab.className = 'vlabel';
    lab.title = info.roleDetail;
    lab.innerHTML = `<i style="background:${VOICE_COLORS[i % VOICE_COLORS.length]}"></i><b>${i + 1}</b><span class="role role-${ROLE_CLASS[info.role] || 'inner'}">${info.roleLabel}</span>`;
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Instrument für Stimme ${i + 1} (${info.roleLabel})`);
    for (const g of groups) {
      const og = document.createElement('optgroup');
      og.label = g.label;
      for (const it of g.items) {
        const o = document.createElement('option');
        o.value = it.key;
        o.textContent = it.name;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = id;
    sel.addEventListener('change', () => {
      S.opts.voices = [...S.opts.voices];
      S.opts.voices[i] = sel.value;
      if (S.opts.ranges) S.opts.ranges[i] = null; // neues Instrument: Tonumfang wieder automatisch
      S.opts.preset = matchPreset(S.opts.voices, S.opts.preset);
      if (S.opts.ensemble !== 'solo') fillSoloSelect($('#opt-solo'), S.opts.voices, $('#opt-solo').value);
      renderBand();
      renderTabBar();
    });
    const meta = document.createElement('div');
    meta.className = 'slot-meta';
    meta.textContent = `${info.title} · ${info.transposition}`;
    meta.title = info.roleDetail;
    slot.append(lab, sel, meta);
    box.appendChild(slot);
  });
  $('#slots-note').textContent = `${voices.length} ${voices.length === 1 ? 'Stimme' : 'Stimmen'}`;
}


// Schritt 2 (Mehrere): Anzahl, Vorlage, Stimmen
function renderBand() {
  const n = S.opts.voices.length;
  $('#vc-value').textContent = String(n);
  $('#vc-range').value = String(n);
  $('#vc-minus').disabled = n <= MIN_ENS;
  $('#vc-plus').disabled = n >= MAX_ENS;
  $('#voice-count-name').textContent = ensembleLabel(n);
  renderSlots();
  markPreset();
  renderFineList();
  renderCountChooser();
}


const METHOD_INFO = {
  orchestra:
    'Orchestrierung: Lead, Gegenmelodie, Harmonie und Bass für genau diese Instrumente – mit Drop-Voicings, versetzten Atempausen und spielbaren Stimmen, jede Regel geprüft. Von 1 bis 15 Stimmen.',
  free: 'Nah am Original (ca. 90 %): Melodie, Bass und Begleitung bleiben, dazu ein kurzer Vorspann, bei vielen gleichen Strophen fallen einzelne weg, am Ende ein kurzer Anhang. Unter „Erweitert“ → „Frei“ schreibt NoteCode den ganzen Satz im gewählten Stil neu.',
  original: 'Groove und Melodie werden 1:1 aus der Vorlage auf die Instrumente verteilt – gleiche Form, gleiche Länge.',
};

const methodOf = (o) => (o.engine === 'orchestra' ? 'orchestra' : o.original ? 'original' : 'free');

// Methode: 'orchestra' (neue Engine) | 'free' (neu arrangieren, klassisch) | 'original' (1:1 übernehmen)
function setMethod(m, { quiet = false } = {}) {
  if (m !== 'orchestra' && S.opts.voices.length < 2) {
    if (!quiet) toast('Die klassischen Methoden brauchen mindestens 2 Stimmen – beim Lead Sheet gilt die Orchestrierung.');
    m = 'orchestra';
  }
  S.opts.engine = m === 'orchestra' ? 'orchestra' : 'classic';
  S.opts.original = m === 'original';
  $$('#arr-mode .seg').forEach((b) => {
    const act = b.dataset.method === m;
    b.classList.toggle('active', act);
    b.setAttribute('aria-checked', String(act));
  });
  $('#arr-mode-info').textContent = METHOD_INFO[m];
  updateModeVisibility();
}


// nur zeigen, was für die gewählte Besetzung eine Rolle spielt
function updateModeVisibility() {
  const orch = S.opts.ensemble === 'quartet' && S.opts.engine === 'orchestra';
  const free = S.opts.ensemble === 'quartet' || (S.opts.ensemble === 'solo' && !S.opts.playback);
  const original = S.opts.ensemble === 'quartet' && !!S.opts.original && !orch;
  $$('.arr-only').forEach((el) => el.classList.toggle('hidden', original || (el.classList.contains('free-only') && !free)));
  // Orchestrierung: Stil, Soli, Schwierigkeit und Variante gibt es dort nicht (CSS: .orch-hide)
  $('#steps').dataset.orch = orch ? '1' : '';
}

// Schritt 4: Schwierigkeit & Tonumfang je Stimme
function fineRows() {
  const ens = S.opts.ensemble;
  if (ens === 'drums') return [];
  if (ens === 'quartet') return S.opts.voices.map((id, i) => ({ i, id, name: `${i + 1} · ${INSTRUMENTS[id].name}`, color: VOICE_COLORS[i % VOICE_COLORS.length] }));
  if (!S.opts.playback) {
    const id = S.opts.soloInstrument || 'trumpet';
    return id === 'drums' ? [] : [{ i: 0, id, name: `Solo · ${INSTRUMENTS[id].name}`, color: VOICE_COLORS[0], difficulty: false }];
  }
  if (!S.song) return [];
  const sources = playAlongSources(S.song);
  const parts = currentPlayParts(sources);
  const melodic = parts.filter((p) => p.inst !== 'drums');
  return parts.map((p) => {
    const src = sources.find((x) => x.id === p.source);
    const drums = p.inst === 'drums';
    const i = drums ? melodic.length : melodic.indexOf(p);
    return { i, id: p.inst, name: `${src?.name || 'Stimme'} → ${drums ? 'Schlagzeug' : INSTRUMENTS[p.inst].name}`, color: VOICE_COLORS[i % VOICE_COLORS.length] };
  });
}

function renderFineList() {
  const box = $('#fine-list');
  if (!box || !S.opts) return;
  box.innerHTML = '';
  const rows = fineRows();
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'fine-row';
    const name = document.createElement('div');
    name.className = 'fine-name';
    name.innerHTML = `<i style="background:${r.color}"></i>`;
    name.appendChild(document.createTextNode(r.name));
    row.appendChild(name);
    voiceExtras(row, r.i, r.id, { difficulty: r.difficulty !== false });
    box.appendChild(row);
  }
  $('#fine-box').classList.toggle('hidden', !rows.length);
  updateFineSummary();
}

function updateFineSummary() {
  const sub = $('#fine-sub');
  if (!sub) return;
  const n = $$('#fine-list select.set').length;
  sub.textContent = n ? `${n} ${n === 1 ? 'Anpassung' : 'Anpassungen'}` : 'Schwierigkeit & Tonumfang';
  sub.classList.toggle('on', n > 0);
}

function renderSoloGrid() {
  const box = $('#solo-grid');
  box.innerHTML = '';
  const slot = document.createElement('div');
  slot.className = 'voice-slot';
  slot.innerHTML = '<div class="vlabel"><i style="background:' + VOICE_COLORS[0] + '"></i><span>Solo-Instrument</span></div>';
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
    renderTabBar();
  });
  slot.appendChild(sel);
  box.appendChild(slot);
  renderFineList();
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
  const label = drums ? 'Schlagzeug-Noten erstellen' : solo ? 'Playback-Noten erstellen' : 'Noten erstellen';
  $('#generate span').textContent = label;
  $('#es-generate span').textContent = label;
  updateModeVisibility();
  if (solo) renderPlaybackList();
  else renderFineList();
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
    renderFineList();
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
    box.appendChild(row);
  }
  $('#pb-fills-row').classList.toggle('hidden', !parts.some((p) => p.inst === 'drums'));
  renderFineList();
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
  renderCountChooser();
  renderTabBar();
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
  if (sel.selectedIndex < 0) sel.value = '0'; // z. B. Solo-Stimme 6, aber nur noch 4 Stimmen
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
// Einstellungen, die nicht in der Oberfläche stehen (Rückmeldung/Überarbeiten) bleiben erhalten
const EXTRA_OPT_KEYS = ['tweaks', 'melodyFirst', 'cleanHarmony', 'cleaner', 'bassMode', 'focus', 'drumDifficulty', 'feedback'];
const extraOpts = () => Object.fromEntries(EXTRA_OPT_KEYS.filter((k) => S.opts[k] !== undefined).map((k) => [k, S.opts[k]]));


function readOpts() {
  const solo = $('#opt-solo').value;
  const tempo = Number($('#opt-tempo').value) || null;
  const tr = $('#opt-transpose').value;
  return {
    voices: [...S.opts.voices],
    engine: S.opts.engine || 'orchestra',
    preset: S.opts.preset || null,
    style: 'auto',
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
    voiceDifficulty: perVoice(S.opts.voiceDifficulty),
    ranges: perVoice(S.opts.ranges),
    original: !!S.opts.original, // Klassisch: true = Groove & Melodie 1:1, false = neu arrangieren
    playback: !!S.opts.playback,
    title: S.opts.title || null,
    playParts: S.opts.playParts ? S.opts.playParts.map((p) => ({ ...p })) : null,
    drumFills: S.opts.ensemble === 'drums' ? $('#opt-drum-fills').checked : $('#opt-fills').checked,
    ...extraOpts(),
  };
}

// Feineinstellungen je Stimme: mindestens so viele Einträge wie Stimmen (leer = automatisch)
function perVoice(arr) {
  const n = Math.max(S.opts.voices.length, arr?.length || 0);
  return Array.from({ length: n }, (_, i) => arr?.[i] ?? null);
}


function applyOptsToUi(o) {
  S.opts = { ...S.opts, ...o };
  // gespeicherte Arrangements ohne Angabe wurden mit der klassischen Methode erzeugt
  S.opts.engine = o.engine ?? 'classic';
  S.opts.voices = (S.opts.voices || []).slice(0, MAX_VOICES);
  if (S.opts.voices.length < MIN_ENS) S.opts.voices = resizeVoices(S.opts.voices.length ? S.opts.voices : [...S.settings.defaultVoices], 2);
  S.opts.preset = matchPreset(S.opts.voices, S.opts.preset);
  S.opts.voiceDifficulty = S.opts.voiceDifficulty || [];
  S.opts.ranges = S.opts.ranges || [];
  renderBand();
  setMethod(methodOf(S.opts), { quiet: true });
  difficultyOptions($('#opt-difficulty'), S.opts.difficulty ?? 'auto');
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
  markPreset();
  setEnsemble(S.opts.ensemble || 'quartet');
  if (S.opts.ensemble === 'solo') $('#opt-solo').value = o.solo === 'none' ? 'none' : '0';
}


// Ensemble-Vorlagen als Schnellwahl: setzen Anzahl und Standardbesetzung, bleiben manuell änderbar
function renderPresets() {
  const box = $('#preset-chips');
  box.innerHTML = '';
  for (const p of ENSEMBLE_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p.name;
    b.title = `${p.name} – ${p.info}`;
    b.dataset.preset = p.id;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => pickPreset(p.id));
    box.appendChild(b);
  }
}
function readOptsKeepVoices() {
  const o = readOpts();
  o.voices = [...S.opts.voices];
  o.style = 'auto';
  return o;
}

function markPreset() {
  const id = S.opts.preset || matchPreset(S.opts.voices, null);
  $$('#preset-chips .chip').forEach((c) => {
    const on = c.dataset.preset === id;
    c.classList.toggle('active', on);
    c.setAttribute('aria-checked', String(on));
  });
  const p = ENSEMBLE_PRESETS.find((x) => x.id === id);
  $('#preset-info').textContent = p ? p.info : 'Eigene Besetzung';
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
    $('#opt-tempo').placeholder = song.tempo ? `Auto (♩ ${song.tempo})` : 'Automatisch';
    $('#generate').disabled = false;
    S.opts.playParts = null; // Stimmen gehören zum Song
    S.opts.title = null;
    if (S.opts.ensemble === 'solo' && S.opts.playback) renderPlaybackList();
    refreshEmptyState();
    renderTabBar();
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
  // Aufnahme: Taktraster von Hand korrigieren & ältere Analysen neu berechnen
  const audio = s.source === 'audio';
  const old = analysisOutdated(s);
  const retime = audio
    ? `<div class="retime">
        <span class="rt-label" title="Liegt die „1“ in den Noten falsch? Hier rückt der Taktstrich um einen Schlag.">Taktanfang</span>
        <button type="button" class="btn ghost small" data-rt="shift:-1" title="Die „1“ einen Schlag früher">◀ früher</button>
        <button type="button" class="btn ghost small" data-rt="shift:1" title="Die „1“ einen Schlag später">später ▶</button>
        <span class="rt-label" title="Zu viele Sechzehntel? Doppeltes Tempo schreibt dieselbe Musik in Achteln.">Notenwerte</span>
        <button type="button" class="btn ghost small" data-rt="scale:2" title="Doppeltes Tempo, doppelte Notenwerte (Achtel statt Sechzehntel)">Tempo ×2</button>
        <button type="button" class="btn ghost small" data-rt="scale:0.5" title="Halbes Tempo, halbe Notenwerte">Tempo ÷2</button>
        ${S.source?.audioId ? `<button type="button" class="btn ${old ? 'primary' : 'ghost'} small" data-rt="again" title="Die Aufnahme mit der aktuellen Erkennung neu analysieren">Neu analysieren</button>` : ''}
      </div>`
    : '';
  const oldNote = old ? `<div class="warn">⚠ ${s.aiUsed === false ? 'Diese Analyse lief ohne die lokale KI' : 'Diese Analyse stammt aus einer älteren Version'} – „Neu analysieren“ liefert deutlich bessere Noten.</div>` : '';
  box.innerHTML = `<div class="a-title">${s.title}</div>
    <div class="kv"><span>${keyNameDe(s.key)}${s.keyDetected ? ' (erkannt)' : ''}</span><span>${s.meter.beats}/${s.meter.beatType}</span><span>♩ ${s.tempo || '–'}</span><span>${s.measureCount} Takte${s.pickup ? ' + Auftakt' : ''}</span><span>Form ${form}</span><span>${chordInfo}</span>${extra.map((x) => `<span>${x}</span>`).join('')}</div>
    ${partsHtml}
    ${retime}
    ${oldNote}
    ${(s.warnings || []).map((w) => `<div class="warn">⚠ ${w}</div>`).join('')}`;
  const mp = $('#melody-part');
  if (mp) mp.addEventListener('change', () => setSource({ ...S.source, melodyPart: Number(mp.value) }));
  $$('[data-rt]', box).forEach((b) => b.addEventListener('click', () => retimeSong(b.dataset.rt)));
}

// Aufnahme: Taktanfang verschieben, Notenwerte verdoppeln/halbieren oder neu analysieren –
// danach wird ein vorhandenes Arrangement sofort neu geschrieben
async function retimeSong(action) {
  if (S.busy) return busyToast();
  if (!S.song || S.source?.format !== 'audio') return;
  const [kind, val] = action.split(':');
  let song = null;
  if (kind === 'shift') song = shiftDownbeat(S.song, Number(val));
  else if (kind === 'scale') {
    const f = Number(val);
    if (f === 2 && S.song.tempo > 150) return toast('Schneller geht es nicht sinnvoll – das Tempo liegt schon über 150.');
    if (f === 0.5 && S.song.tempo < 80) return toast('Langsamer geht es nicht sinnvoll – das Tempo liegt schon unter 80.');
    song = scaleNoteValues(S.song, f);
  } else if (kind === 'again') return void (await reanalyze());
  if (!song) return;
  const had = !!S.arr;
  const id = S.currentId;
  if (!(await setSource({ ...S.source, song }))) return;
  toast(kind === 'shift' ? 'Taktanfang verschoben' : `Tempo jetzt ♩ = ${song.tempo}`, 'ok');
  if (had) {
    S.currentId = id;
    await generate();
  }
}

// Stammt die Analyse einer Aufnahme aus einer älteren Version (oder lief sie ohne KI)?
const analysisOutdated = (song) => !!song && song.source === 'audio' && ((song.analysisVersion || 1) < ANALYSIS_VERSION || song.aiUsed === false);

// ---- Aufwand-Regler (Schnell … Ultra): gilt für Analyse und Arrangement
const effortLevel = () => effortOf(S.settings.effort).level;

function mountEffort(el, { compact = false } = {}) {
  if (!el) return;
  const lv = effortLevel();
  const e = effortOf(lv);
  el.innerHTML = `<div class="effort-head"><strong>Aufwand</strong><span class="effort-name">${e.name}</span><span class="effort-time">${e.time}</span></div>
    <input type="range" class="effort-range" min="1" max="5" step="1" value="${lv}" aria-label="Aufwand: ${e.name}" />
    <div class="effort-ticks">${EFFORT.map((x) => `<span class="${x.level === lv ? 'on' : ''}" data-lv="${x.level}">${x.short}</span>`).join('')}</div>
    <p class="effort-text muted small">${e.text}</p>`;
  void compact;
  const set = (v) => {
    v = effortOf(v).level;
    if (v === effortLevel()) return;
    update({ effort: v, effortChosen: true });
    mountAllEffort();
  };
  el.querySelector('.effort-range').addEventListener('input', (ev) => {
    const v = Number(ev.target.value);
    const x = effortOf(v);
    el.querySelector('.effort-name').textContent = x.name;
    el.querySelector('.effort-time').textContent = x.time;
    el.querySelector('.effort-text').textContent = x.text;
    el.querySelectorAll('.effort-ticks span').forEach((t) => t.classList.toggle('on', Number(t.dataset.lv) === v));
  });
  el.querySelector('.effort-range').addEventListener('change', (ev) => set(Number(ev.target.value)));
  el.querySelectorAll('.effort-ticks span').forEach((t) => t.addEventListener('click', () => set(Number(t.dataset.lv))));
}
function mountAllEffort() {
  mountEffort($('#effort-set'));
}

// ---- Analyse einer Aufnahme: Aufgaben mit eigenem Balken und gelernter Zeitschätzung

// Grobe Länge der Aufnahme aus der Dateigröße (vor dem Dekodieren)
function estimateDuration(size, name = '') {
  const lossless = /\.(wav|wave|flac|aif|aiff)$/i.test(name);
  return Math.max(10, Math.min(1800, size / (lossless ? 150000 : 16000)));
}

// Wird die Aufnahme in Spuren getrennt (Demucs, nur Desktop-App)?
function stemsPlanned() {
  return resolveStemPlan(S.settings.stemsMode, S.stemsStatus).use;
}

function analysisTasks(dur, level, { read = false, stems = false } = {}) {
  const cfg = effortOf(level).analysis;
  const th = cfg.hpss && !stems;
  const t = [];
  if (read) t.push({ id: 'read', label: 'Datei lesen', expect: 300 + dur * 6 });
  t.push({ id: 'decode', label: 'Aufnahme dekodieren', expect: 700 + dur * speedOf('decode', 40) });
  if (stems) t.push({ id: 'stems', label: 'Spuren trennen (Demucs: Gesang, Begleitung, Bass)', expect: 4000 + dur * speedOf('stems', S.stemsStatus && S.stemsStatus.cuda ? 120 : 1500) });
  if (th) t.push({ id: 'prep', label: 'Gesang und Begleitung trennen', expect: 500 + dur * speedOf('prep', 70) });
  t.push({ id: 'ai', label: cfg.passes > 1 ? `Lokale KI hört die Noten (bis zu ${cfg.passes} Durchgänge)` : 'Lokale KI hört die Noten', expect: 1500 + dur * speedOf(`ai${level}`, 70 * cfg.passes) });
  // Nach den KI-Durchgängen folgen eigene Schritte – jeder mit eigenem Balken und eigener Zeit
  if (cfg.side && !stems) t.push({ id: 'side', label: 'Seitensignal hören (Begleitung erkennen)', expect: 800 + dur * speedOf('side', 30) });
  if (cfg.passes > 0) t.push({ id: 'conv', label: 'Noten aus den KI-Daten lesen', expect: 400 + dur * speedOf('conv2', cfg.side ? 8 : 5) });
  t.push({ id: 'spec', label: 'Klang, Tempo & Takt erkennen', expect: 1000 + dur * speedOf('spec', 110) });
  t.push({ id: 'melody', label: 'Melodie, Bass & Akkorde erkennen', expect: 800 + dur * speedOf('melody', 70) });
  t.push({ id: 'grid', label: 'Noten ins Raster setzen & Form bestimmen', expect: 500 + dur * speedOf('grid', 25) });
  t.push({ id: 'drums', label: 'Schlagzeug Takt für Takt', expect: 800 + dur * speedOf('drums', 55) });
  t.push({ id: 'save', label: 'Ergebnis speichern', expect: 600 });
  return t;
}

// Meldungen der Analyse (Stufe, Anteil, Text) -> Aufgaben; abgeschlossene Aufgaben lernen ihre Dauer
function stageRunner(pg, dur, level) {
  const order = ['read', 'decode', 'stems', 'prep', 'ai', 'side', 'conv', 'spec', 'melody', 'grid', 'drums', 'save'].filter((id) => pg.list.get(id));
  const t0 = {};
  const finish = (id) => {
    const t = pg.list.get(id);
    if (!t || t.state === 'done') return;
    pg.done(id);
    if (t0[id] && id !== 'read' && id !== 'save') rememberSpeed(id === 'ai' ? `ai${level}` : id === 'conv' ? 'conv2' : id, Date.now() - t0[id], dur);
  };
  const begin = (id) => {
    const t = pg.list.get(id);
    if (!t || t.state !== 'wait') return;
    t0[id] = Date.now();
    pg.start(id);
  };
  return {
    finish,
    begin,
    // vor dieser Aufgabe liegende abschließen, diese starten
    enter(id) {
      for (const x of order) {
        if (x === id) break;
        finish(x);
      }
      begin(id);
    },
    stage(stage, frac, text) {
      if (!pg.list.get(stage)) return;
      // 'prep' kann nach 'ai' gemeldet werden (Prozessor-Rückfall): nichts davor abschließen
      this.enter(stage);
      pg.set(stage, frac, text || '');
    },
    all() {
      for (const x of order) finish(x);
    },
  };
}

// Aufnahmen, deren automatische Neu-Analyse der Nutzer abgebrochen hat (bleibt der Knopf „Neu analysieren“)
const NOAUTO_KEY = 'notecode:noauto';
function noAutoRenew(id) {
  try {
    return (JSON.parse(localStorage.getItem(NOAUTO_KEY) || '[]') || []).includes(id);
  } catch {
    return false;
  }
}
function rememberNoAuto(id) {
  try {
    const l = JSON.parse(localStorage.getItem(NOAUTO_KEY) || '[]') || [];
    if (!l.includes(id)) localStorage.setItem(NOAUTO_KEY, JSON.stringify([...l, id].slice(-50)));
  } catch {
    /* kein Speicher */
  }
}

// Gespeicherte Aufnahme mit der aktuellen Erkennung neu analysieren.
// auto: beim Öffnen eines älteren Projekts – still überspringen, wenn die Aufnahme hier fehlt
async function reanalyze({ auto = false, effort = null, regenerate = true } = {}) {
  const src = S.source;
  let blob = null;
  try {
    blob = await S.local.getKV(`audio:${src.audioId}`);
  } catch {
    /* kein lokaler Speicher */
  }
  if (!(blob instanceof Blob)) {
    if (!auto) toast('Die Aufnahme liegt nicht auf diesem Gerät – bitte die Datei noch einmal laden.', 'error');
    return false;
  }
  let done = false;
  busyStart();
  renderTabBar();
  const level = effort ?? (auto ? Math.min(3, effortLevel()) : effortLevel());
  const dur = S.song?.duration || estimateDuration(blob.size, src.name);
  const pg = progress(auto ? 'Bessere Erkennung: Song wird neu analysiert' : 'Song wird neu analysiert', { tasks: analysisTasks(dur, level, { stems: stemsPlanned() }) });
  const run = stageRunner(pg, dur, level);
  try {
    run.enter('decode');
    await nextFrame();
    const decoded = await decodeAudio(new Uint8Array(await blob.arrayBuffer()));
    run.finish('decode');
    const song = await analyzeAudio(decoded, { title: S.song?.title || src.name.replace(/\.[^.]+$/, ''), effort: level, signal: jobSignal(), stemsMode: S.settings.stemsMode, stemsStatus: S.stemsStatus, onStage: (st, f, t) => run.stage(st, f, t) });
    lockJob();
    const had = !!S.arr;
    const id = S.currentId;
    run.enter('save');
    if (await setSource({ ...src, song })) {
      run.all();
      done = true;
      toast(auto ? 'Mit der verbesserten Erkennung neu analysiert' : 'Neu analysiert', 'ok');
      if (had && regenerate) {
        S.currentId = id;
        await generate();
      }
    }
  } catch (e) {
    if (isAbort(e)) {
      toast('Analyse abgebrochen – es bleibt bei der bisherigen.');
      // beim Öffnen eines älteren Projekts nicht bei jedem Öffnen neu anbieten
      if (auto && src.audioId) rememberNoAuto(src.audioId);
    } else {
      console.error(e);
      toast('Analyse fehlgeschlagen: ' + e.message, 'error');
    }
  } finally {
    busyEnd();
    renderTabBar();
    setTimeout(() => pg.done(), 300);
  }
  return done;
}

// ---------------------------------------------------------------- Überarbeiten
// Optionaler Assistent (eigener Anthropic-Schlüssel in den Einstellungen): übersetzt freien Text
// in dieselben Änderungen wie die eingebaute Auswertung – das Ergebnis wird geprüft (sanitizeTweaks).
async function askAssistant(text, info) {
  const key = (S.settings.assistantKey || '').trim();
  if (!key || !text) return null;
  const system =
    'Du hilfst in einer Noten-App, Rückmeldungen zu einem Quartett-Arrangement in Änderungen zu übersetzen. ' +
    'Antworte NUR mit einem JSON-Objekt. Erlaubte Felder (alle optional): ' +
    'general (bool), melodyFirst (bool), adapt (0 nah am Original, 1 Standard, 2 frei), cleanHarmony (bool), cleaner (bool), ' +
    'difficultyDelta (-1 oder 1), tempoFactor (0.6–1.5), retime (2 oder 0.5), shiftDownbeat (-1 oder 1), solo ("none" oder "short"), ' +
    'drums ("off" oder "simpler"), bass ("calm" oder "busy"), reanalyze (bool: Aufnahme neu hören), ' +
    'voiceRanges ([{voice: Index ab 0, dir: "lower"|"higher"}]), focus ([{from, to}] Taktnummern ab 1), notes (Liste kurzer deutscher Sätze, was du ändern wirst).';
  const user = JSON.stringify({ rueckmeldung: text, stueck: { titel: info.title, tonart: info.key, tempo: info.tempo, takte: info.bars, stimmen: info.voices, aufnahme: info.hasAudio } });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error('Assistent: ' + r.status);
    const data = await r.json();
    const out = (data.content || []).map((c) => c.text || '').join('');
    const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    const notes = Array.isArray(json.notes) ? json.notes.filter((x) => typeof x === 'string').slice(0, 8).map((x) => 'Assistent: ' + x.slice(0, 200)) : [];
    return { tweaks: sanitizeTweaks(json, { voices: info.voices?.length || 4 }), notes };
  } catch (e) {
    console.info('Assistent nicht verfügbar:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function renderReviseLog() {
  const log = S.opts?.feedback || [];
  const ol = $('#revise-log');
  if (!ol) return;
  ol.innerHTML = '';
  [...log].reverse().forEach((f, i) => {
    const li = document.createElement('li');
    const when = new Date(f.at).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' });
    const head = document.createElement('div');
    head.innerHTML = `<b></b> <span></span>`;
    head.querySelector('b').textContent = f.text ? `„${f.text}“` : 'Alles überarbeitet';
    head.querySelector('span').textContent = `· ${when}${i === 0 ? '' : ''}`;
    li.appendChild(head);
    if (f.notes?.length) {
      const ul = document.createElement('ul');
      for (const n of f.notes) {
        const x = document.createElement('li');
        x.textContent = n;
        ul.appendChild(x);
      }
      li.appendChild(ul);
    }
    ol.appendChild(li);
  });
}

async function revise() {
  if (S.busy) return busyToast();
  if (!S.arr || !S.song) return toast('Zuerst ein Arrangement erstellen.', 'error');
  const text = $('#revise-text').value.trim();
  const isAudio = S.song.source === 'audio' && !!S.source?.audioId;
  const info = {
    title: S.song.title,
    key: keyNameDe(S.song.key),
    tempo: S.song.tempo,
    bars: S.printed.length,
    voices: S.opts.voices,
    hasAudio: isAudio,
  };
  const res = interpretFeedback(text, info);
  let tweaks = res.tweaks;
  const notes = [...res.notes];
  $('#revise-note').textContent = 'Rückmeldung wird ausgewertet …';
  const ext = await askAssistant(text, info);
  if (ext) {
    const specific = Object.keys(ext.tweaks).some((k) => !['general', 'deep'].includes(k));
    tweaks = mergeTweaks(tweaks, ext.tweaks);
    // der Assistent hat etwas Konkretes verstanden: keine pauschale Überarbeitung mehr
    if (specific && !ext.tweaks.general) delete tweaks.general;
    notes.push(...ext.notes);
  }
  const level = Math.max(4, effortLevel());
  const tab = S.tab;
  tab.revBackup = { opts: JSON.parse(JSON.stringify(S.opts)), source: S.source };
  $('#revise-note').textContent = '';
  busyStart();
  try {
    // 1) die Aufnahme selbst korrigieren
    if (isAudio) {
      let song = S.song;
      let changed = false;
      if (tweaks.shiftDownbeat) {
        song = shiftDownbeat(song, tweaks.shiftDownbeat);
        changed = true;
      }
      if (tweaks.retime) {
        song = scaleNoteValues(song, tweaks.retime);
        changed = true;
      }
      if (changed) await setSource({ ...S.source, song });
      if (tweaks.reanalyze || tweaks.general) {
        const re = await reanalyze({ effort: level, regenerate: false });
        if (!re && jobSignal()?.aborted) {
          if (tab.revBackup.source !== S.source) await setSource(tab.revBackup.source);
          return;
        }
      }
    }
    // 2) Einstellungen anpassen und länger arrangieren
    const next = applyTweaks(S.opts, tweaks, { tempo: S.song.tempo, instruments: INSTRUMENTS });
    next.feedback = [...(S.opts.feedback || []), { text, at: Date.now(), notes }];
    next.seed = (Number(S.opts.seed) || 1) + 101;
    applyOptsToUi(next);
    const base = effortOf(level).arrange;
    const made = await generate({
      effort: level,
      cfgPatch: { sweep: true, seeds: Math.max(base.seeds, 32), search: Math.max(base.search, 12), polish: Math.max(base.polish, 8), budgetMs: Math.max(base.budgetMs, 4 * 60000) },
      label: 'Arrangement wird überarbeitet',
    });
    if (!made) {
      // abgebrochen oder fehlgeschlagen: Einstellungen wie vorher
      applyOptsToUi(tab.revBackup.opts);
      return;
    }
    renderReviseLog();
    $('#revise-text').value = '';
    $('#revise-note').textContent = notes.join(' ');
    toast('Überarbeitet', 'ok', {
      label: 'Rückgängig',
      run: async () => {
        const b = tab.revBackup;
        if (!b || S.tab !== tab) return;
        if (b.source !== S.source) await setSource(b.source);
        applyOptsToUi(b.opts);
        await generate({ effort: 1 });
        renderReviseLog();
      },
    });
  } catch (e) {
    console.error(e);
    toast('Überarbeiten fehlgeschlagen: ' + e.message, 'error');
  } finally {
    busyEnd();
    renderTabBar();
  }
}

// replace: im aktiven Tab ersetzen; sonst öffnet ein weiteres Lied einen neuen Tab
async function handleFile(file, { replace = false } = {}) {
  if (S.busy) return busyToast(() => handleFile(file, { replace }));
  if (!replace && tabInUse(S.tab)) await openTab(makeTab(inheritOpts()));
  busyStart();
  renderTabBar();
  const looksAudio = detectFormat(file.name) === 'audio';
  const level = effortLevel();
  const estDur = estimateDuration(file.size, file.name);
  const pg = looksAudio
    ? progress(`„${file.name}“ wird analysiert`, { tasks: analysisTasks(estDur, level, { read: true, stems: stemsPlanned() }) })
    : progress(`„${file.name}“ wird geladen`);
  const run = looksAudio ? stageRunner(pg, estDur, level) : null;
  try {
    run?.begin('read');
    const buf = await readFileWithProgress(file, (f) => (run ? pg.set('read', f, `${(file.size / 1048576).toFixed(1)} MB`) : pg.set(`Datei wird gelesen (${(file.size / 1048576).toFixed(1)} MB)`, f)));
    const format = detectFormat(file.name, buf);
    let ok;
    if (format === 'audio') {
      run.finish('read');
      run.enter('decode');
      await nextFrame();
      const decoded = await decodeAudio(buf);
      run.finish('decode');
      const dur = decoded.duration || estDur;
      const title = file.name.replace(/\.[^.]+$/, '');
      const song = await analyzeAudio(decoded, { title, effort: level, signal: jobSignal(), stemsMode: S.settings.stemsMode, stemsStatus: S.stemsStatus, onStage: (st, f, t) => run.stage(st, f, t) });
      lockJob();
      run.enter('save');
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
      run.all();
      void dur;
    } else {
      pg.set('Noten werden gelesen', 0.5);
      await nextFrame();
      const data = format === 'abc' ? new TextDecoder().decode(buf) : buf;
      ok = await setSource({ name: file.name, format, data });
    }
    if (ok) toast(`„${S.song?.title || file.name}“ geladen`, 'ok');
  } catch (e) {
    if (isAbort(e)) toast(`„${file.name}“ – Analyse abgebrochen`);
    else {
      console.error(e);
      toast('Datei konnte nicht geladen werden: ' + e.message, 'error');
    }
  } finally {
    busyEnd();
    renderTabBar();
    persistTabs();
    setTimeout(() => pg.done(), 300);
  }
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------------------------------------------------------------- Erzeugen
// effort: Stufe 1–5 (Standard: Regler); cfgPatch: Überarbeiten verlängert die Suche
async function generate({ silent = false, effort = null, cfgPatch = null, label = null } = {}) {
  if (!S.song) {
    toast('Bitte zuerst eine Vorlage wählen.', 'error');
    return;
  }
  const btn = $('#generate');
  const btnLabel = btn.querySelector('span').textContent;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Wird erstellt …';
  busyStart();
  renderTabBar();
  const opts = readOpts();
  const level = effort ?? effortLevel();
  const cfg = { ...effortOf(level).arrange, ...(cfgPatch || {}) };
  const pb = opts.ensemble === 'solo' && opts.playback;
  // Orchestrierung (neue Engine, 1–15 Stimmen). Bei Taktartwechseln im Stück schreibt die klassische
  // Methode Takt für Takt (die Orchestrierung arbeitet mit gleichbleibender Taktart).
  let orch = opts.ensemble === 'quartet' && opts.engine === 'orchestra';
  if (orch && hasMeterChanges(S.song)) {
    if (opts.voices.length < 2) {
      busyEnd();
      btn.disabled = false;
      btn.querySelector('span').textContent = btnLabel;
      renderTabBar();
      toast('Taktartwechsel im Stück: für ein Lead Sheet nicht möglich – bitte mindestens 2 Stimmen wählen.', 'error');
      return false;
    }
    orch = false;
    opts.engine = 'classic';
    toast('Taktartwechsel im Stück: die Orchestrierung arbeitet mit gleichbleibender Taktart – dieses Arrangement entsteht mit der klassischen Methode.');
  }
  // Variantensuche nur für frei geschriebene Mehrstimmen-Arrangements
  // (nah am Original gibt es nur eine Fassung – dort gibt es nichts zu vergleichen)
  const search = !orch && opts.ensemble === 'quartet' && !opts.original && cfg.seeds > 1 && !usesFaithful(S.song, opts);
  const bars = S.song.measureCount || 32;
  const tasks = [
    {
      id: 'arr',
      label: orch ? `Orchestrierung: ${opts.voices.length} ${opts.voices.length === 1 ? 'Stimme' : 'Stimmen'} aus Melodie, Bass, Begleitung und Groove` : pb ? 'Playback-Noten erstellen' : search ? 'Varianten schreiben und vergleichen' : 'Arrangement schreiben',
      expect: orch ? 500 + bars * 8 * opts.voices.length : search ? Math.min(cfg.budgetMs, 4000 + bars * 40 * cfg.seeds) : 600 + bars * 12,
    },
    { id: 'notes', label: 'Noten setzen (Seite für Seite)', expect: 1500 + bars * speedOf('notes', 90) },
  ];
  const pg = progress(label || (pb ? 'Playback-Noten werden erstellt' : orch ? 'Noten werden erstellt' : 'Arrangement wird erstellt'), { tasks });
  await nextFrame();
  let tNotes = 0;
  let ok = false;
  try {
    S.opts = { ...S.opts, ...opts };
    if (!orch && S.opts.engine === 'classic') setMethod(methodOf(S.opts), { quiet: true });
    const t0 = performance.now();
    if (orch) {
      // Spuren (Melodie, Bass, Begleitung, Groove) der Analyse -> Orchestrierung -> MusicXML-Modell
      S.arr = orchestrateFromOptions(S.song, opts).arr;
      S.arr.options = { ...opts };
    } else if (search) {
      S.arr = await arrangeBest(S.song, opts, cfg, { onProgress: (f, text) => pg.set('arr', f, text), signal: jobSignal() });
    } else {
      S.arr = arrange(S.song, opts);
    }
    pg.done('arr');
    lockJob();
    console.info(`Arrangement in ${Math.round(performance.now() - t0)} ms (Aufwand ${level})`);
    await nextFrame();
    S.printed = printedMeasures(S.arr);
    S.t2p = timelineToPrinted(S.arr, S.printed);
    pg.start('notes');
    tNotes = Date.now();
    await showResult((t, f) => pg.set('notes', f, t));
    pg.done('notes');
    rememberSpeed('notes', Date.now() - tNotes, bars);
    if (S.settings.autoSave && !silent) await saveCurrent(true);
    ok = true;
  } catch (e) {
    if (isAbort(e)) toast('Abgebrochen – das bisherige Arrangement bleibt.');
    else {
      console.error(e);
      toast('Fehler beim Arrangieren: ' + e.message, 'error');
    }
  } finally {
    busyEnd();
    btn.disabled = false;
    btn.querySelector('span').textContent = btnLabel;
    refreshEmptyState();
    renderTabBar();
    persistTabs();
    setTimeout(() => pg.done(), 250);
  }
  return ok;
}

// restore: Tab-Wechsel – Notenseiten und Mischpult des Tabs wiederverwenden
async function showResult(onProgress = null, { restore = false } = {}) {
  const a = S.arr;
  renderReviseLog();
  $('#empty-state').classList.add('hidden');
  $('#result').classList.remove('hidden');
  $('#arrange-grid').classList.remove('no-result');
  $('#res-title').textContent = a.meta.title;
  // Überarbeiten (Rückmeldung, Variantensuche) gehört zur klassischen Methode
  $('#revise').classList.toggle('hidden', !!a.engine);
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
  if (restore) {
    restoreMix();
    if (restorePages()) return;
  }
  await renderNotes(onProgress);
}

function restoreMix() {
  const mix = S.tab.mix;
  if (!S.player) return;
  for (const m of mix || []) {
    const p = S.player.part(m.key);
    if (p) Object.assign(p, { volume: m.volume, mute: m.mute, solo: m.solo, pan: m.pan });
  }
  const speed = Number($('#p-speed').value) / 100;
  if (speed && speed !== 1) S.player.setSpeed(speed);
  if (mix) renderMixer();
}

// Kennung der gesetzten Seiten: ändern sich Ansicht oder Notenbild, wird neu gesetzt
function pagesKey() {
  const st = S.settings;
  return [S.view, S.zoom, st.paper, st.notesZoom, st.concertScore, st.chords, st.tenorClef].join('|');
}

function restorePages() {
  const t = S.tab;
  if (!t.pages?.length || t.pagesKey !== pagesKey()) return false;
  const box = $('#pages');
  box.querySelectorAll('.page').forEach((p) => p.remove());
  $('#loader').classList.remove('on');
  box.style.setProperty('--zoom', S.view === 'score' ? 1.15 : 1);
  for (const p of t.pages) box.appendChild(p);
  t.pages = null;
  // Mitlaufen: Takte der wiederhergestellten Seiten neu verknüpfen
  S.measureEls = $$('g.measure', box);
  if (S.follower && S.printed) S.follower.attach(S.printed.length);
  return true;
}


function xmlFor(view) {
  const st = S.settings;
  const eng = !!S.arr.engine;
  // Lead Sheet: Akkordsymbole immer; Orchestrierung schreibt <transpose> zusammengefasst (diatonic/chromatic)
  const chords = eng && S.arr.voices.length === 1 ? (st.chords === 'none' ? 'none' : 'all') : S.arr.soloMode && !S.arr.playAlong && st.chords !== 'none' ? 'all' : st.chords;
  const tenorClef = st.tenorClef;
  const transposeForm = eng ? 'compound' : undefined;
  if (view === 'score') return exportMusicXML(S.arr, { mode: 'score', concert: st.concertScore, paper: st.paper, chords, tenorClef, transposeForm });
  if (view === 'drums') return exportMusicXML(S.arr, { mode: 'part', partIndex: 'drums', paper: st.paper });
  return exportMusicXML(S.arr, { mode: 'part', partIndex: Number(view), paper: st.paper, chords, tenorClef, transposeForm });
}

async function renderNotes(onProgress = null) {
  const token = ++S.renderToken;
  const tab = S.tab;
  const key = pagesKey();
  tab.pagesKey = null;
  tab.pages = null;
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
    if (token !== S.renderToken) return own?.done(); // inzwischen anderer Tab oder neue Ansicht
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
    tab.pagesKey = key;
    own?.done();
  } catch (e) {
    own?.done();
    if (token !== S.renderToken) return;
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
  const tab = S.tab;
  const a = S.arr;
  // Ordner und Anlagedatum eines bereits gespeicherten Arrangements behalten
  const prev = S.currentId ? await S.library.get(S.currentId) : null;
  const item = {
    id: S.currentId || undefined,
    title: a.meta.title,
    songTitle: S.song?.title || prev?.songTitle || null,
    folder: prev ? prev.folder || null : tab.folder || null,
    createdAt: prev?.createdAt,
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
  tab.currentId = saved.id;
  tab.folder = saved.folder || null;
  renderTabBar();
  persistTabs();
  if (!auto) toast('In der Bibliothek gespeichert', 'ok');
}

// ---- Ordner
const folderList = () => S.settings.folders || [];
const nowIso = () => new Date().toISOString();

// lokal speichern, dann mit der Cloud zusammenführen (ohne fremde Ordner zu überschreiben)
async function saveFolders(list) {
  S.settings.folders = list;
  await saveSettings(S.local, S.settings);
  syncFolders({ force: true });
}

async function createFolder(name) {
  const now = nowIso();
  const f = { id: uuid(), name: (name || '').trim() || uniqueFolderName(folderList()), createdAt: now, updatedAt: now };
  await saveFolders([...folderList(), f]);
  return f;
}

async function renameFolder(f, name) {
  const now = nowIso();
  const list = folderList();
  await saveFolders(list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? { ...x, name, updatedAt: now } : x)) : [...list, { id: f.id, name, createdAt: now, updatedAt: now }]);
}

// Ordner löschen: die Arrangements bleiben erhalten und liegen wieder in der Übersicht
async function deleteFolder(f) {
  const items = (await S.library.list()).filter((it) => it.folder === f.id);
  const now = nowIso();
  const list = folderList();
  await saveFolders(list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? { ...x, deleted: true, updatedAt: now } : x)) : [...list, { id: f.id, name: f.name, createdAt: now, updatedAt: now, deleted: true }]);
  for (const it of items) await S.library.save({ ...it, folder: null });
  for (const t of S.tabs) if (t.folder === f.id) t.folder = null;
  if (S.libFolder?.id === f.id) S.libFolder = null;
  renderLibrary();
  const n = items.length;
  toast(`Ordner „${f.name}“ gelöscht${n ? ` – ${n === 1 ? 'das Arrangement liegt' : `${n} Arrangements liegen`} wieder in der Übersicht` : ''}`, '', {
    label: 'Rückgängig',
    run: async () => {
      const t = nowIso();
      await saveFolders(folderList().map((x) => (x.id === f.id ? { ...x, deleted: false, updatedAt: t } : x)));
      for (const it of items) {
        const cur = await S.library.get(it.id);
        if (cur && !cur.deleted) await S.library.save({ ...cur, folder: f.id });
      }
      renderLibrary();
    },
  });
}

async function moveItem(id, folderId, { quiet = false } = {}) {
  const cur = await S.library.get(id);
  if (!cur) return;
  const prev = cur.folder || null;
  folderId = folderId || null;
  if (prev === folderId) return;
  await S.library.save({ ...cur, folder: folderId });
  for (const t of S.tabs) if (t.currentId === id) t.folder = folderId;
  renderLibrary();
  if (quiet) return;
  const name = folderList().find((f) => f.id === folderId)?.name || 'Ordner';
  toast(folderId ? `„${cur.title}“ liegt jetzt in „${name}“` : `„${cur.title}“ liegt wieder in der Übersicht`, '', { label: 'Rückgängig', run: () => moveItem(id, prev, { quiet: true }) });
}

let moveItemTarget = null;
function openMoveDialog(it) {
  moveItemTarget = it;
  $('#move-sub').textContent = `„${it.title}“`;
  const list = $('#move-list');
  list.innerHTML = '';
  const add = (id, name, icon) => {
    const b = document.createElement('button');
    b.type = 'button';
    const current = (it.folder || null) === id;
    b.className = 'move-opt' + (current ? ' current' : '');
    b.innerHTML = `<svg><use href="#${icon}"/></svg><span></span>${current ? '<small>hier gespeichert</small>' : ''}`;
    $('span', b).textContent = name;
    b.addEventListener('click', () => {
      $('#move-dialog').close();
      moveItem(it.id, id);
    });
    list.appendChild(b);
  };
  add(null, 'Kein Ordner (Übersicht)', 'i-library');
  for (const f of groupLibrary([], folderList()).folders) add(f.id, f.name, 'i-folder');
  $('#move-new-name').value = '';
  $('#move-dialog').showModal();
}

async function moveToNewFolder() {
  const it = moveItemTarget;
  if (!it) return;
  const f = await createFolder($('#move-new-name').value);
  $('#move-dialog').close();
  await moveItem(it.id, f.id);
}

// Drag & Drop (Maus): Arrangement auf einen Ordner ziehen
const DND_TYPE = 'text/x-notecode-item';
const canDrag = () => window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
function dropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-over');
    const id = e.dataTransfer.getData(DND_TYPE);
    if (!id) return;
    e.preventDefault();
    moveItem(id, folderId);
  });
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function itemCard(it) {
  const card = document.createElement('div');
  card.className = 'card lib-card';
  const sm = it.summary || {};
  card.innerHTML = `<div class="meta-chips"><span class="accent">${sm.style || ''}</span>${sm.key ? `<span>${sm.key}</span>` : ''}${sm.bars ? `<span>${sm.bars} Takte</span>` : ''}</div>
      <div class="lib-title"><h3></h3><button class="icon-btn small rename" title="Titel ändern" aria-label="Titel ändern"><svg><use href="#i-pen"/></svg></button></div>
      <div class="lib-meta">${(sm.voices || []).join(', ')}${sm.drums ? ', Schlagzeug' : ''}</div>
      <div class="lib-meta">${fmtDate(it.updatedAt)}${it.dirty && S.library.cloud.user ? ' · wird synchronisiert' : ''}</div>
      <div class="lib-actions"><button class="btn primary small open">Öffnen</button><button class="btn ghost small move" title="In Ordner verschieben" aria-label="In Ordner verschieben"><svg><use href="#i-folder-move"/></svg></button><button class="btn ghost small danger del" title="Löschen" aria-label="Löschen"><svg><use href="#i-trash"/></svg></button></div>`;
  $('h3', card).textContent = it.title;
  $('.open', card).addEventListener('click', () => openItem(it.id));
  $('.move', card).addEventListener('click', () => openMoveDialog(it));
  $('.rename', card).addEventListener('click', () => renameItem(card, it));
  $('h3', card).addEventListener('dblclick', () => renameItem(card, it));
  // Löschen ohne Rückfrage – dafür mit "Rückgängig"
  $('.del', card).addEventListener('click', async () => {
    const backup = await S.library.get(it.id);
    await S.library.remove(it.id);
    for (const t of S.tabs) if (t.currentId === it.id) t.currentId = null;
    persistTabs();
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
  if (canDrag()) {
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest?.('input')) return e.preventDefault();
      e.dataTransfer.setData(DND_TYPE, it.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
      document.body.classList.add('lib-dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.body.classList.remove('lib-dragging');
    });
  }
  return card;
}

function folderCard(f) {
  const card = document.createElement('div');
  card.className = 'card lib-card folder-card' + (f.auto ? ' auto' : '');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  const n = f.items.length;
  const latest = f.items.reduce((m, it) => ((it.updatedAt || '') > m ? it.updatedAt : m), '');
  const styles = [...new Set(f.items.map((it) => it.summary?.style).filter(Boolean))];
  card.innerHTML = `<div class="fc-top"><span class="fc-icon"><svg><use href="#${f.auto ? 'i-layers' : 'i-folder'}"/></svg></span><span class="fc-kind">${f.auto ? 'Gleiches Lied' : 'Ordner'}</span>
      ${f.auto ? '' : '<span class="fc-tools"><button class="icon-btn small rename" title="Ordner umbenennen" aria-label="Ordner umbenennen"><svg><use href="#i-pen"/></svg></button><button class="icon-btn small danger del" title="Ordner löschen" aria-label="Ordner löschen"><svg><use href="#i-trash"/></svg></button></span>'}</div>
      <div class="lib-title"><h3></h3></div>
      <div class="lib-meta">${n} ${n === 1 ? 'Arrangement' : 'Arrangements'}${latest ? ` · zuletzt ${fmtDate(latest)}` : ''}</div>
      <div class="fc-peek">${styles
        .slice(0, 3)
        .map((s) => `<span>${s}</span>`)
        .join('')}${styles.length > 3 ? `<span>+${styles.length - 3}</span>` : ''}${n ? '' : '<span class="empty">leer</span>'}</div>`;
  $('h3', card).textContent = f.name;
  const open = () => {
    S.libFolder = f.auto ? { type: 'auto', key: f.key } : { type: 'user', id: f.id };
    renderLibrary();
    window.scrollTo({ top: 0 });
  };
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, input')) return;
    open();
  });
  card.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
      e.preventDefault();
      open();
    }
  });
  if (!f.auto) {
    $('.rename', card).addEventListener('click', () => renameFolderInline(card, f));
    $('.del', card).addEventListener('click', () => deleteFolder(f));
    dropTarget(card, f.id);
  }
  return card;
}

function libSection(title, count) {
  const h = document.createElement('div');
  h.className = 'lib-section';
  h.innerHTML = `<span></span><small>${count}</small>`;
  $('span', h).textContent = title;
  return h;
}

async function renderLibrary() {
  const box = $('#library-grid');
  const items = await S.library.list();
  const g = groupLibrary(items, folderList());
  const user = S.library.cloud.user;
  let open = null;
  if (S.libFolder?.type === 'user') open = g.folders.find((f) => f.id === S.libFolder.id) || null;
  if (S.libFolder?.type === 'auto') open = g.auto.find((f) => f.key === S.libFolder.key) || null;
  if (!open) S.libFolder = null;
  $('#lib-crumbs').classList.toggle('hidden', !open);
  $('#library-title').textContent = open ? open.name : 'Bibliothek';
  $('#lib-actions').classList.toggle('hidden', !!open);
  $('#folder-actions').classList.toggle('hidden', !open);
  box.innerHTML = '';
  if (open) {
    const n = open.items.length;
    $('#library-sub').textContent = open.auto ? `${n} Arrangements desselben Lieds · automatisch zusammengefasst` : `${n} ${n === 1 ? 'Arrangement' : 'Arrangements'} in diesem Ordner`;
    $('#folder-new-arr').classList.toggle('hidden', !!open.auto);
    $('#folder-rename').classList.toggle('hidden', !!open.auto);
    $('#folder-delete').classList.toggle('hidden', !!open.auto);
    $('#folder-keep').classList.toggle('hidden', !open.auto);
    if (!n) box.innerHTML = '<div class="lib-empty card"><h3>Dieser Ordner ist leer</h3><p>Verschiebe Arrangements über „In Ordner verschieben“ hierher – am Computer auch per Drag &amp; Drop auf den Ordner.</p></div>';
    for (const it of open.items) box.appendChild(itemCard(it));
    return;
  }
  const nf = g.folders.length;
  $('#library-sub').textContent = `${items.length} ${items.length === 1 ? 'Arrangement' : 'Arrangements'}${nf ? ` · ${nf} ${nf === 1 ? 'eigener' : 'eigene'} Ordner` : ''} · ${user ? `synchronisiert mit ${user.email}` : 'nur auf diesem Gerät (anmelden für Sync)'}`;
  if (!items.length && !nf) {
    box.innerHTML = `<div class="lib-empty card"><h3>Noch nichts gespeichert</h3><p>Erstelle ein Arrangement – es landet automatisch hier und, wenn du angemeldet bist, auf all deinen Geräten.</p></div>`;
    return;
  }
  const groups = [...g.folders, ...g.auto];
  if (groups.length) {
    box.appendChild(libSection('Ordner', groups.length));
    for (const f of groups) box.appendChild(folderCard(f));
  }
  if (g.loose.length) {
    if (groups.length) box.appendChild(libSection('Arrangements', g.loose.length));
    for (const it of g.loose) box.appendChild(itemCard(it));
  }
}

// Titel direkt auf der Karte bearbeiten (Enter = speichern, Esc = abbrechen)
function inlineEdit(card, value, onSave) {
  const box = $('.lib-title', card);
  if ($('input', box)) return;
  const h = $('h3', box);
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = value;
  input.setAttribute('aria-label', 'Name');
  h.replaceWith(input);
  card.draggable = false;
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    if (save && text && text !== value) await onSave(text);
    renderLibrary();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function renameItem(card, it) {
  inlineEdit(card, it.title, async (title) => {
    const cur = await S.library.get(it.id);
    await S.library.save({ ...cur, title, songTitle: cur.songTitle || songTitleOf(cur), options: { ...(cur.options || {}), title } });
    for (const t of S.tabs) {
      if (t.currentId !== it.id && t.pendingId !== it.id) continue;
      if (t.arr) t.arr.meta.title = title;
      if (t.opts) t.opts.title = title;
      t.pendingTitle = title;
    }
    if (S.currentId === it.id && S.arr) $('#res-title').textContent = title;
    renderTabBar();
    toast('Titel geändert', 'ok');
  });
}

function renameFolderInline(card, f, { created = false } = {}) {
  inlineEdit(card, f.name, async (name) => {
    await renameFolder(f, name);
    toast(created ? `Ordner „${name}“ angelegt` : 'Ordner umbenannt', 'ok');
  });
}

// Kopfzeile eines geöffneten Ordners
function bindLibraryFolders() {
  $('#lib-back').addEventListener('click', () => {
    S.libFolder = null;
    renderLibrary();
  });
  dropTarget($('#lib-back'), null);
  $('#lib-folder-new').addEventListener('click', async () => {
    const f = await createFolder();
    await renderLibrary();
    const card = $$('#library-grid .folder-card').find((c) => $('h3', c)?.textContent === f.name);
    if (card) renameFolderInline(card, f, { created: true });
  });
  const openFolder = async () => {
    const g = groupLibrary(await S.library.list(), folderList());
    if (S.libFolder?.type === 'user') return g.folders.find((f) => f.id === S.libFolder.id);
    if (S.libFolder?.type === 'auto') return g.auto.find((f) => f.key === S.libFolder.key);
    return null;
  };
  $('#folder-rename').addEventListener('click', async () => {
    const f = await openFolder();
    if (!f) return;
    const box = $('.lib-head-text');
    if ($('input', box)) return;
    const h = $('#library-title');
    const input = document.createElement('input');
    input.className = 'title-input head';
    input.value = f.name;
    input.setAttribute('aria-label', 'Name des Ordners');
    h.classList.add('hidden');
    h.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.remove();
      h.classList.remove('hidden');
      if (save && name && name !== f.name) {
        await renameFolder(f, name);
        toast('Ordner umbenannt', 'ok');
      }
      renderLibrary();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });
  $('#folder-delete').addEventListener('click', async () => {
    const f = await openFolder();
    if (f) deleteFolder(f);
  });
  // neues Arrangement direkt in diesem Ordner
  $('#folder-new-arr').addEventListener('click', () => startNew({ folder: S.libFolder?.type === 'user' ? S.libFolder.id : null }));
  // automatischen Ordner als eigenen Ordner übernehmen
  $('#folder-keep').addEventListener('click', async () => {
    const g = await openFolder();
    if (!g) return;
    const f = await createFolder(g.name);
    for (const it of g.items) await moveItem(it.id, f.id, { quiet: true });
    S.libFolder = { type: 'user', id: f.id };
    renderLibrary();
    toast(`Eigener Ordner „${f.name}“ angelegt`, 'ok');
  });
  $('#move-new-btn').addEventListener('click', moveToNewFolder);
  $('#move-new-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      moveToNewFolder();
    }
  });
}

// Ordnerliste mit der Cloud abgleichen (je Ordner gewinnt der neueste Stand)
let folderSyncAt = 0;
async function syncFolders({ force = false } = {}) {
  const cloud = S.library.cloud;
  if (!cloud.user || (!force && Date.now() - folderSyncAt < 20000)) return;
  folderSyncAt = Date.now();
  try {
    const row = await cloud.fetchSettings();
    const remote = row?.data?.folders || [];
    const merged = mergeFolders(folderList(), remote);
    const localChanged = !sameFolders(merged, folderList());
    if (localChanged) {
      S.settings.folders = merged;
      await saveSettings(S.local, S.settings);
      if ($('#view-library').classList.contains('active')) renderLibrary();
    }
    // nur die Ordner hochladen, die anderen Einstellungen der Cloud bleiben
    if (!sameFolders(merged, remote)) {
      if (row?.data) await cloud.saveSettings({ ...row.data, folders: merged });
      else await saveSettings(S.local, S.settings, cloud);
    }
  } catch {
    /* offline oder noch keine Einstellungen in der Cloud */
  }
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
  const pg = progress('NoteCode wird aktualisiert', { cancellable: false });
  try {
    await applyUpdate((t, f) => pg.set(t, f));
  } catch (e) {
    pg.done();
    toast('Update fehlgeschlagen: ' + e.message, 'error');
  }
}

// Arrangement aus der Bibliothek öffnen: eigener Tab (oder der schon offene)
async function openItem(id) {
  const open = S.tabs.find((t) => t.currentId === id || t.pendingId === id);
  if (open) {
    if (open !== S.tab && S.busy) return busyToast();
    showView('arrange');
    return activateTab(open);
  }
  if (S.busy) return busyToast();
  const it = await S.library.get(id);
  if (!it) return;
  const fresh = !tabInUse(S.tab);
  const t = fresh ? S.tab : makeTab();
  t.opts = { ...defaultOpts(), ...(it.options || {}) };
  t.pendingId = id;
  t.pendingTitle = it.title;
  t.folder = it.folder || null;
  if (!fresh) {
    S.tabs.push(t);
    stashTab();
    S.tab = t;
  }
  await showTab();
  showView('arrange'); // lädt das Arrangement, sobald der Tab sichtbar ist
}

// ---------------------------------------------------------------- Einstellungen
function renderSettings() {
  const st = S.settings;
  const n = st.defaultVoices.length;
  renderVoiceCount($('#set-voice-count'), n, (k) => {
    update({ defaultVoices: resizeVoices(st.defaultVoices, k) });
    renderSettings();
  });
  $('#set-voice-count-name').textContent = ensembleName(n);
  renderVoiceGrid($('#set-voices'), [...st.defaultVoices], (v) => {
    update({ defaultVoices: [...v] });
    fillSoloSelect($('#set-solo'), v, $('#set-solo').value);
  });
  fillSoloSelect($('#set-solo'), st.defaultVoices, st.defaultSolo);
  difficultyOptions($('#set-difficulty'), st.defaultDifficulty ?? 'auto');
  $('#set-form').value = st.form;
  $('#set-drums').checked = st.defaultDrums;
  $('#set-transpose').checked = st.transposeAuto;
  $('#set-autosave').checked = st.autoSave;
  mountEffort($('#effort-set'));
  renderStemsSettings();
  $('#set-assistant').value = st.assistantKey || '';
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

// ---- Spurentrennung (Demucs): Modus wählen, erkannte Hardware anzeigen
async function refreshStemsStatus(refresh = false) {
  const d = typeof window !== 'undefined' ? window.notecodeDesktop : null;
  if (!d || !d.stemsStatus) {
    S.stemsStatus = { desktop: false };
    return S.stemsStatus;
  }
  try {
    S.stemsStatus = await d.stemsStatus(refresh);
  } catch (e) {
    S.stemsStatus = { desktop: true, gpu: null, python: null, demucs: null, cuda: false, error: String(e.message || e) };
  }
  return S.stemsStatus;
}

function renderStemsStatusText() {
  const el = $('#stems-status');
  if (!el) return;
  const h = describeHardware(S.stemsStatus);
  el.textContent = h.text;
  el.dataset.level = h.level;
  const plan = resolveStemPlan(S.settings.stemsMode, S.stemsStatus);
  if (S.stemsStatus && S.stemsStatus.desktop) {
    el.textContent += plan.use
      ? ` Aktuell: Demucs wird für neue Analysen genutzt (${plan.device === 'cuda' ? 'Grafikkarte' : 'Prozessor'}).`
      : plan.reason
        ? ` Aktuell: ${plan.reason}`
        : ' Aktuell: Spurentrennung ist deaktiviert – direkte Analyse ohne Spurentrennung.';
  }
}

function renderStemsSettings() {
  const sel = $('#set-stems');
  if (!sel) return;
  sel.innerHTML = STEM_MODES.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  sel.value = normalizeStemMode(S.settings.stemsMode);
  renderStemsStatusText();
  if (!S.stemsStatus) refreshStemsStatus().then(renderStemsStatusText);
}

async function update(patch, { rerender = false } = {}) {
  Object.assign(S.settings, patch);
  await saveSettings(S.local, S.settings, S.library.cloud);
  applyTheme();
  if (rerender && S.arr) renderNotes();
}

function bindSettings() {
  const on = (id, fn, ev = 'change') => $(id).addEventListener(ev, fn);
  on('#set-solo', (e) => update({ defaultSolo: /\d/.test(e.target.value) ? Number(e.target.value) : e.target.value }));
  on('#set-difficulty', (e) => update({ defaultDifficulty: e.target.value === 'auto' ? 'auto' : Number(e.target.value) }));
  on('#set-form', (e) => update({ form: e.target.value }));
  on('#set-drums', (e) => update({ defaultDrums: e.target.checked }));
  on('#set-transpose', (e) => update({ transposeAuto: e.target.checked }));
  on('#set-autosave', (e) => update({ autoSave: e.target.checked }));
  on('#set-assistant', (e) => update({ assistantKey: e.target.value.trim() }));
  on('#set-stems', (e) => {
    update({ stemsMode: normalizeStemMode(e.target.value) });
    renderStemsStatusText();
  });
  on('#stems-recheck', async () => {
    $('#stems-status').textContent = 'Hardware wird geprüft …';
    await refreshStemsStatus(true);
    renderStemsStatusText();
  }, 'click');
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
      // eigene Ordner der Sicherung dazunehmen
      if (Array.isArray(data.settings?.folders)) await saveFolders(mergeFolders(folderList(), data.settings.folders));
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
      // Ordner nicht ersetzen, sondern zusammenführen (auch lokal angelegte bleiben)
      Object.assign(S.settings, rest, { folders: mergeFolders(folderList(), rest.folders) });
      await saveSettings(S.local, S.settings);
      applyTheme();
    }
    syncFolders({ force: true });
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
  S.library.addEventListener('status', () => {
    upd();
    // nach jedem Abgleich der Arrangements auch die Ordnerliste abgleichen
    if (/^synchronisiert/.test(S.library.status)) syncFolders();
  });
  S.library.addEventListener('auth', () => {
    updateAccountButton();
    upd();
  });
  S.library.addEventListener('change', () => {
    if ($('#view-library').classList.contains('active')) renderLibrary();
  });
  $('#lib-new').addEventListener('click', () => startNew());
  bindLibraryFolders();
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
  // Spurentrennung: Hardware beim Start prüfen (nur Desktop-App; läuft im Hintergrund)
  refreshStemsStatus().then(renderStemsStatusText);
  S.library = new Library(S.local);
  S.follower = new ScoreFollower($('#pages'));
  await S.library.init(S.settings);
  S.tab = makeTab(defaultOpts());
  S.tabs = [S.tab];
  renderPresets();
  mountAllEffort();
  applyOptsToUi(S.opts);
  refreshEmptyState();
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
  // Datei: über Schritt 1 öffnet ein weiteres Lied einen neuen Tab; "Anderen Song wählen"
  // auf dem Start-Bildschirm ersetzt das Lied im aktiven Tab
  let fileReplace = false;
  $('#file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    const replace = fileReplace;
    fileReplace = false;
    if (f) handleFile(f, { replace });
  });
  const dz = $('#dropzone');
  dz.addEventListener('click', (e) => e.target.id !== 'file-input' && (fileReplace = false));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), dz.classList.add('over'))));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), dz.classList.remove('over'))));
  dz.addEventListener('drop', (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));
  $('#abc-load').addEventListener('click', async () => {
    const text = $('#abc-input').value.trim();
    if (!text) return toast('Bitte zuerst ABC-Noten eingeben.', 'error');
    if (S.busy) return busyToast();
    // eigener Text wird im selben Tab aktualisiert, ein neues Lied bekommt einen neuen Tab
    if (S.source?.name !== 'eingabe.abc' && tabInUse(S.tab)) {
      const t = makeTab(inheritOpts());
      t.abcText = text;
      t.srcTab = 'abc';
      await openTab(t);
    }
    if (await setSource({ name: 'eingabe.abc', format: 'abc', data: text })) toast(`„${S.song.title}“ übernommen`, 'ok');
    persistTabs();
  });
  // Start-Bildschirm: Song wählen bzw. ersetzen, Datei hineinziehen, Arrangement erstellen
  $('#es-file').addEventListener('click', () => {
    fileReplace = !!S.song && !S.arr;
    $('#file-input').value = '';
    $('#file-input').click();
  });
  $('#es-generate').addEventListener('click', () => $('#generate').click());
  $('#revise-go').addEventListener('click', () => revise());
  const es = $('#empty-state');
  ['dragenter', 'dragover'].forEach((ev) => es.addEventListener(ev, (e) => (e.preventDefault(), es.classList.add('over'))));
  ['dragleave', 'drop'].forEach((ev) => es.addEventListener(ev, (e) => (e.preventDefault(), es.classList.remove('over'))));
  es.addEventListener('drop', (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0], { replace: !S.arr && !S.tab.pendingId }));
  // Tabs
  $('#tab-add').addEventListener('click', () => startNew({ force: true }));
  // Besetzung: Original übernehmen / neu arrangieren
  $$('#arr-mode .seg').forEach((b) =>
    b.addEventListener('click', () => {
      setMethod(b.dataset.method);
      renderTabBar();
    }),
  );
  // Stimmenanzahl: Stepper und Regler (1–15)
  $('#vc-minus').addEventListener('click', () => setVoiceCount(S.opts.voices.length - 1));
  $('#vc-plus').addEventListener('click', () => setVoiceCount(S.opts.voices.length + 1));
  $('#vc-range').addEventListener('input', (e) => setVoiceCount(Number(e.target.value)));
  $('#opt-difficulty').addEventListener('change', (e) => (S.opts.difficulty = e.target.value === 'auto' ? 'auto' : Number(e.target.value)));
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
    if (S.busy) return busyToast(() => $('#generate').click());
    S.currentId = null;
    generate();
  });
  $('#dice').addEventListener('click', () => {
    if (S.busy) return busyToast(() => $('#dice').click());
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
  // zuletzt geöffnete Lieder wieder als Tabs
  restoreTabs().catch((e) => console.error(e));
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
