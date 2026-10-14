// Noten ändern: Startbildschirm, Notenblatt-Editor (Foto/Scan, MusicXML, MIDI, ABC), Besetzungs-Schemas in den
// Einstellungen, Auswahl in der Bibliothek (Partitur / PDF). Die Logik steckt in src/sheet; hier ist nur die
// Oberfläche. app.js übergibt alles Nötige in env (kein Import von app.js, damit es keine Kreise gibt).
import { INSTRUMENTS, FAMILIES } from '../arrange/instruments.js';
import { makeKey, keyNameDe } from '../theory/keys.js';
import { CLEFS, analyzeXml } from '../sheet/transpose.js';
import { newProject, projectXml, transposeProject, setClefProject, convertProject, shiftOctaveProject, undo, redo, infoOf } from '../sheet/project.js';
import { describeMeasure, measureCount } from '../sheet/octave.js';
import { addVoices, listParts, extractPart } from '../sheet/addvoices.js';
import { mergeScores } from '../sheet/merge.js';
import { readScore, partsOf, measuresOf } from '../sheet/xml.js';
import { normalizeSchemes, activeScheme, schemeVoices, addScheme, setSlot, updateScheme, removeScheme, SLOT_NAMES, SLOT_COUNT } from '../sheet/schemes.js';
import { loadSong, detectFormat } from '../input/index.js';
import { readMusicXMLFile } from '../input/musicxml.js';
import { orchestrate } from '../engine/index.js';
import { renderPages, responsiveSvg, pagesToPngs, svgPagesToCanvases, canvasesToPdf, xmlToPdf } from './render.js';
import { decodeImage, grayToCanvas, canvasToBlob, preparePage, analyzePage, planSystems, renderScanPage, pageChords, toGray } from './sheet-pages.js';

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|heic|heif|tiff?)$/i;
const FORMAT_LABEL = { scan: 'Scan', datei: 'Datei', score: 'Partitur', bibliothek: 'Bibliothek' };

export function createSheetUI(env) {
  const { $, $$, toast, progress, download, showView, S, safeName } = env;
  const E = {
    project: null,
    id: null,
    folder: null,
    createdAt: null,
    mode: 'original', // 'original' = Original-Seite behalten, 'engraved' = neu gesetzt
    prepared: [], // je Scan-Seite { page(gray), staves, skew }
    canvases: [], // zuletzt gezeigte Seiten (für Export)
    partId: null, // gewählte Stimme bei Partituren
    token: 0,
    engine: null, // { kind: 'desktop'|'builtin'|'none', text }
    busy: false,
    // Oktavieren: Geltungsbereich und Auswahl
    oct: { scope: 'all', from: 1, to: 1, line: 1, measure: 1, notes: new Set() },
    lines: [], // Zeilen des gezeigten Blatts: [{ from, to, page, staff }] (Takte im ganzen Stück, 1-basiert)
  };
  const resetOct = () => {
    E.oct = { scope: 'all', from: 1, to: 1, line: 1, measure: 1, notes: new Set() };
    E.lines = [];
  };

  const h = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // „Trompete in B 2“ -> trumpet (Zähler am Ende ignorieren)
  const instrumentIdByName = (name) => {
    const n = String(name || '').replace(/\s+\d+$/, '').trim();
    return Object.values(INSTRUMENTS).find((i) => i.name === n)?.id || null;
  };

  function instrumentOptions({ concert = false, none = false, selected = null } = {}) {
    let out = '';
    if (none) out += `<option value="">– keine –</option>`;
    if (concert) out += `<option value="concert"${selected === 'concert' ? ' selected' : ''}>Klingend (C-Instrument / Konzertton)</option>`;
    const groups = {};
    for (const inst of Object.values(INSTRUMENTS)) {
      if (inst.id === 'drums') continue;
      (groups[inst.family] = groups[inst.family] || []).push(inst);
    }
    for (const [fam, list] of Object.entries(groups)) {
      out += `<optgroup label="${esc(FAMILIES[fam] || fam)}">`;
      for (const i of list) out += `<option value="${i.id}"${selected === i.id ? ' selected' : ''}>${esc(i.name)}</option>`;
      out += '</optgroup>';
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------- Start
  async function renderHome() {
    const box = $('#home-recent');
    box.innerHTML = '';
    let items = [];
    try {
      items = (await S.library.list()).slice(0, 6);
    } catch {
      items = [];
    }
    if (!items.length) return;
    box.appendChild(h('h3', '', 'Zuletzt bearbeitet'));
    const list = h('div', 'home-recent-list');
    for (const it of items) {
      const b = h('button', 'home-recent-item');
      b.type = 'button';
      const sm = it.summary || {};
      b.innerHTML = `<strong>${esc(it.title || 'Ohne Titel')}</strong><small>${it.kind === 'sheet' ? 'Notenblatt' : esc(sm.style || 'Arrangement')}${sm.key ? ' · ' + esc(sm.key) : ''}</small>`;
      b.addEventListener('click', () => env.openItem(it.id));
      list.appendChild(b);
    }
    box.appendChild(list);
  }

  // ------------------------------------------------------------------------------------- Erkennung
  async function refreshEngine() {
    const d = window.notecodeDesktop;
    let eng = { kind: 'builtin', text: 'Notenerkennung: einfache eingebaute Erkennung (saubere Drucke, gerade aufgenommen). Für Fotos und dichte Sätze: Desktop-App mit KI-Erkennung.' };
    if (d && d.omrStatus) {
      try {
        const st = await d.omrStatus();
        if (st.available) eng = { kind: 'desktop', text: 'Notenerkennung: KI (homr) – bereit, läuft auf diesem Computer.' };
        else eng = { kind: 'builtin', text: 'Notenerkennung: einfache eingebaute Erkennung. Für die KI-Erkennung einmal „node scripts/setup-omr.mjs“ ausführen.' };
      } catch {
        // bleibt bei der eingebauten Erkennung
      }
    }
    E.engine = eng;
    const p = $('#sheet-engine');
    if (p) p.textContent = eng.text;
    const st = $('#omr-status');
    if (st) st.textContent = eng.text;
    return eng;
  }

  // Ein Bild -> MusicXML (Desktop: homr; sonst die eingebaute Erkennung)
  async function recognize(blob, prepared, onProgress) {
    const eng = E.engine || (await refreshEngine());
    if (eng.kind === 'desktop') {
      const d = window.notecodeDesktop;
      const off = d.onOmrProgress ? d.onOmrProgress((p) => onProgress?.(p.text || 'Noten werden erkannt', p.frac)) : null;
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const r = await d.recognizeSheet(bytes, /png/.test(blob.type) ? 'png' : 'jpg');
        return { xml: r.xml, engine: 'KI (homr)' };
      } finally {
        if (off) off();
      }
    }
    const { recognizeSimple } = await import('../sheet/image/recognize.js');
    onProgress?.('Noten werden erkannt', 0.3);
    const r = recognizeSimple(prepared);
    return { xml: r.xml, engine: 'eingebaute Erkennung', warnings: r.warnings || [] };
  }

  // ---------------------------------------------------------------------------------------- Laden
  async function pageFromImage(blob) {
    const img = await decodeImage(blob);
    const { page, skew } = preparePage(img);
    const staves = analyzePage(page);
    return { page, staves, skew };
  }

  async function loadFiles(files) {
    const list = [...files];
    if (!list.length) return;
    if (E.busy) return toast('Ein Vorgang läuft noch.');
    E.busy = true;
    const pg = progress('Notenblatt wird geladen', { cancellable: false });
    try {
      const images = list.filter((f) => IMAGE_RE.test(f.name) || /^image\//.test(f.type)).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
      if (images.length) await loadScans(images, pg);
      else await loadScoreFile(list[0], pg);
    } catch (e) {
      console.error(e);
      toast('Notenblatt konnte nicht geladen werden: ' + (e.message || e), 'error');
    } finally {
      pg.done();
      E.busy = false;
    }
  }

  async function loadScans(images, pg) {
    const pages = [];
    const prepared = [];
    const warnings = [];
    let engine = '';
    for (let i = 0; i < images.length; i++) {
      const label = images.length > 1 ? `Seite ${i + 1} von ${images.length}: ` : '';
      pg.set(`${label}Bild wird aufbereitet`, i / images.length);
      await new Promise((r) => setTimeout(r, 0));
      const prep = await pageFromImage(images[i]);
      if (!prep.staves.length) throw new Error(`${images[i].name}: keine Notenzeilen gefunden – bitte gerade, gut ausgeleuchtet und möglichst formatfüllend aufnehmen`);
      pg.set(`${label}Noten werden erkannt`, (i + 0.3) / images.length);
      // erkannt wird das aufbereitete (weiße, gerade) Bild – für beide Erkennungen die beste Vorlage
      const canvas = grayToCanvas(prep.page);
      const blob = await canvasToBlob(canvas, 'image/png');
      const r = await recognize(blob, prep, (t, f) => pg.set(label + t, (i + 0.3 + 0.7 * (f ?? 0)) / images.length));
      engine = r.engine;
      (r.warnings || []).forEach((w) => warnings.push(w));
      pages.push({ xml: r.xml, base: r.xml });
      prepared.push(prep);
    }
    const title = (analyzeXml(pages[0].xml).title || '').replace(/^Allegro|^Allegretto|^Andante|^Moderato/i, '').trim();
    const baseName = images[0].name.replace(/\.[^.]+$/, '');
    const project = newProject({ title: title || baseName, pages, origin: 'scan', sourceInstrument: S.settings.sheetSourceInstrument || 'trumpet' });
    setProject(project, { prepared, mode: 'original' });
    E.id = null;
    notice(`Erkannt mit ${engine}: ${infoOf(project).parts[0]?.notes || 0} Noten auf ${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'}. Bitte prüfen – die Erkennung ist eine Annäherung.${warnings.length ? ' ' + warnings.join(' · ') : ''}`);
    await renderView();
  }

  async function loadScoreFile(file, pg) {
    pg.set('Datei wird gelesen', 0.2);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fmt = detectFormat(file.name, bytes);
    let xml;
    let title = file.name.replace(/\.[^.]+$/, '');
    if (fmt === 'musicxml') {
      xml = await readMusicXMLFile(bytes, file.name);
      title = analyzeXml(xml).title || title;
    } else if (fmt === 'midi' || fmt === 'abc') {
      const song = await loadSong({ name: file.name, data: fmt === 'abc' ? new TextDecoder().decode(bytes) : bytes, format: fmt });
      title = song.title && song.title !== 'Ohne Titel' ? song.title : title;
      pg.set('Noten werden gesetzt', 0.6);
      const r = orchestrate(song, { voices: 1, instruments: ['trumpet'], transpose: 0, title });
      xml = r.xml();
    } else {
      throw new Error('Dieses Format wird hier nicht unterstützt (Bild, MusicXML, MIDI oder ABC)');
    }
    const info = analyzeXml(xml);
    // Dateien ohne <transpose> sind klingend notiert; mit <transpose> kommt die Notierung aus der Datei
    const hasTranspose = info.parts.some((p) => p.transposeSemis);
    const project = newProject({ title, xml, origin: 'datei', sourceInstrument: hasTranspose ? null : 'concert' });
    setProject(project, { prepared: [], mode: 'engraved' });
    E.id = null;
    notice('');
    await renderView();
  }

  function setProject(project, { prepared = [], mode = 'engraved', id = null } = {}) {
    E.project = project;
    E.prepared = prepared;
    E.mode = prepared.length && project.origin === 'scan' ? mode : 'engraved';
    E.partId = null;
    E.id = id;
    resetOct();
    renderPanels();
    syncMode();
  }

  // ------------------------------------------------------------------------------------- Anzeige
  function notice(text, kind = '') {
    const n = $('#sheet-notice');
    n.textContent = text || '';
    n.classList.toggle('hidden', !text);
    n.classList.toggle('error', kind === 'error');
  }

  function syncMode() {
    const canOriginal = E.prepared.length > 0 && E.project?.origin === 'scan' && partsOf(readScore(projectXml(E.project))).length === 1;
    if (!canOriginal && E.mode === 'original') E.mode = 'engraved';
    $$('#sheet-mode .seg').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === E.mode);
      if (b.dataset.mode === 'original') b.disabled = !canOriginal;
    });
    $('#sheet-empty').classList.toggle('hidden', !!E.project);
    $('#sheet-view').classList.toggle('hidden', !E.project);
    $('#sheet-undo').disabled = !E.project?.history.length;
    $('#sheet-redo').disabled = !E.project?.future.length;
    $('#sheet-sub').textContent = E.project ? `${E.project.title || 'Ohne Titel'} · ${FORMAT_LABEL[E.project.origin] || ''}` : 'Notenblatt einscannen oder laden';
  }

  async function renderView() {
    if (!E.project) return;
    const token = ++E.token;
    syncMode();
    const box = $('#sheet-pages');
    const pg = progress('Notenblatt wird gesetzt', { cancellable: false });
    try {
      const pages = [];
      if (E.mode === 'original') {
        const warns = [];
        for (let i = 0; i < E.project.pages.length; i++) {
          pg.set(`Seite ${i + 1} von ${E.project.pages.length}`, i / E.project.pages.length);
          await new Promise((r) => setTimeout(r, 0));
          // unverändert: das aufbereitete Original (weißer Hintergrund) ohne neu gesetzte Zeilen
          const pgi = E.project.pages[i];
          const gray = pgi.xml === pgi.base ? E.prepared[i].page : await renderScanPage(E.prepared[i], pgi.xml, { onWarn: (w) => warns.push(w), base: pgi.base, chords: E.project.chords !== false });
          const canvas = grayToCanvas(gray);
          pages.push({ el: canvas, canvas });
          if (token !== E.token) return;
        }
        if (warns.length) notice([...new Set(warns)].join(' · '));
      } else {
        const svgs = await renderPages(projectXml(E.project), { paper: S.settings.paper, part: partsOf(readScore(projectXml(E.project))).length === 1, zoom: S.settings.notesZoom, onProgress: (t, f) => pg.set(t, f) });
        if (token !== E.token) return;
        for (const svg of svgs) pages.push({ el: responsiveSvg(svg), svg });
      }
      box.innerHTML = '';
      E.canvases = [];
      for (const p of pages) {
        const wrap = h('div', 'sheet-page');
        wrap.appendChild(p.el);
        box.appendChild(wrap);
        E.canvases.push(p);
      }
      computeLines();
      wirePageSelection();
      renderPanels();
      paintSelection();
    } catch (e) {
      console.error(e);
      notice('Das Blatt konnte nicht gesetzt werden: ' + (e.message || e), 'error');
      if (E.mode === 'original') {
        E.mode = 'engraved';
        pg.done();
        return renderView();
      }
    } finally {
      pg.done();
    }
  }

  // ------------------------------------------------------------------------------ Zeilen & Auswahl
  // Zeilen des gezeigten Blatts (jeweils von–bis Takt, im ganzen Stück fortlaufend gezählt)
  function computeLines() {
    const lines = [];
    let m = 0;
    const p = E.project;
    if (!p) {
      E.lines = [];
      return;
    }
    if (E.mode === 'original') {
      // Original-Seite: Zeilen aus den Zeilenumbrüchen der Erkennung bzw. den Taktstrichen im Bild
      p.pages.forEach((pg, i) => {
        const total = measureCount(pg.xml);
        let counts = null;
        try {
          counts = E.prepared[i] ? planSystems(pg.xml, E.prepared[i].staves).counts : null;
        } catch {
          counts = null;
        }
        if (!counts || counts.reduce((a, c) => a + c, 0) !== total) counts = [total];
        counts.forEach((c, k) => {
          lines.push({ from: m + 1, to: m + c, page: i, staff: k });
          m += c;
        });
      });
    } else {
      // gesetzte Seiten: Takte je System im SVG
      E.canvases.forEach((c, pageIndex) => {
        systemMeasureCounts(c.svg || '').forEach((k, s) => {
          lines.push({ from: m + 1, to: m + k, page: pageIndex, staff: s });
          m += k;
        });
      });
    }
    E.lines = lines;
    if (E.oct.line > lines.length) E.oct.line = Math.max(1, lines.length);
  }

  // Takte je System aus dem Verovio-SVG
  function systemMeasureCounts(svg) {
    const out = [];
    const parts = String(svg).split(/class="system"/);
    for (let i = 1; i < parts.length; i++) out.push((parts[i].match(/class="measure"/g) || []).length);
    return out.filter((n) => n > 0);
  }

  const totalMeasures = () => (E.project ? measureCount(projectXml(E.project), E.partId) : 0);

  function selectedRange() {
    const o = E.oct;
    if (o.scope === 'all') return null;
    if (o.scope === 'line') {
      const L = E.lines[o.line - 1];
      return L ? [L.from, L.to] : null;
    }
    if (o.scope === 'measures') return [Math.min(o.from, o.to), Math.max(o.from, o.to)];
    return [o.measure, o.measure];
  }

  function octTargetText() {
    const o = E.oct;
    const total = totalMeasures();
    if (o.scope === 'all') return `Ganzes Stück · ${total} Takte`;
    if (o.scope === 'line') {
      const L = E.lines[o.line - 1];
      return L ? `Zeile ${o.line} · Takte ${L.from}–${L.to}` : 'Zeile wählen';
    }
    if (o.scope === 'measures') {
      const [a, b] = selectedRange();
      return a === b ? `Takt ${a}` : `Takte ${a}–${b}`;
    }
    return o.notes.size ? `${o.notes.size} ${o.notes.size === 1 ? 'Ton' : 'Töne'} gewählt` : 'Töne wählen';
  }

  // Auswahl im Blatt sichtbar machen (Original-Seite: Rahmen über den Takten; gesetzte Seite: Takte einfärben)
  function paintSelection() {
    $$('#sheet-pages .sel-box, #sheet-pages .sel-rect').forEach((n) => n.remove());
    const range = selectedRange();
    if (!range) return;
    const [a, b] = range;
    if (E.mode === 'original') {
      E.lines.forEach((L) => {
        const lo = Math.max(a, L.from);
        const hi = Math.min(b, L.to);
        if (lo > hi) return;
        const prep = E.prepared[L.page];
        const staff = prep?.staves[L.staff];
        const wrap = $$('#sheet-pages .sheet-page')[L.page];
        if (!staff || !wrap) return;
        const W = prep.page.width;
        const H = prep.page.height;
        const bars = staff.barlines.filter((x) => x > staff.x0 + staff.space * 1.5);
        const n = L.to - L.from + 1;
        const edges = bars.length === n ? [staff.x0, ...bars] : Array.from({ length: n + 1 }, (_, k) => staff.x0 + ((staff.x1 - staff.x0) * k) / n);
        const x0 = edges[lo - L.from];
        const x1 = edges[hi - L.from + 1] ?? staff.x1;
        const box = document.createElement('div');
        box.className = 'sel-box';
        box.style.left = `${(x0 / W) * 100}%`;
        box.style.width = `${((x1 - x0) / W) * 100}%`;
        box.style.top = `${((staff.top - staff.space * 2.2) / H) * 100}%`;
        box.style.height = `${((staff.bottom - staff.top + staff.space * 4.4) / H) * 100}%`;
        wrap.appendChild(box);
      });
    } else {
      let idx = 0;
      E.canvases.forEach((c) => {
        if (!c.el || !c.el.querySelectorAll) return;
        c.el.querySelectorAll('g.measure').forEach((g) => {
          idx++;
          if (idx < a || idx > b) return;
          try {
            const bb = g.getBBox();
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('class', 'sel-rect');
            rect.setAttribute('x', bb.x);
            rect.setAttribute('y', bb.y);
            rect.setAttribute('width', bb.width);
            rect.setAttribute('height', bb.height);
            g.appendChild(rect);
          } catch {
            /* nicht gezeichnet */
          }
        });
      });
    }
  }

  // Ein Klick auf einen Takt im Blatt wählt ihn (Umschalt = bis dahin erweitern)
  function pickMeasure(m, extend) {
    const o = E.oct;
    if (o.scope === 'all') o.scope = 'measures';
    if (o.scope === 'line') {
      const i = E.lines.findIndex((L) => m >= L.from && m <= L.to);
      if (i >= 0) o.line = i + 1;
    } else if (o.scope === 'notes') {
      if (o.measure !== m) o.measure = m;
    } else if (extend) {
      o.to = m;
    } else {
      o.from = m;
      o.to = m;
    }
    o.measure = m;
    renderPanels();
    paintSelection();
  }

  function wirePageSelection() {
    const box = $('#sheet-pages');
    box.onclick = (e) => {
      if (!E.project) return;
      if (E.mode === 'original') {
        const canvas = e.target.closest('canvas');
        if (!canvas) return;
        const wrap = canvas.closest('.sheet-page');
        const page = $$('#sheet-pages .sheet-page').indexOf(wrap);
        const prep = E.prepared[page];
        if (!prep) return;
        const rect = canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * prep.page.width;
        const y = ((e.clientY - rect.top) / rect.height) * prep.page.height;
        let best = null;
        for (const L of E.lines.filter((l) => l.page === page)) {
          const s = prep.staves[L.staff];
          if (!s) continue;
          const dist = y < s.top ? s.top - y : y > s.bottom ? y - s.bottom : 0;
          if (dist <= s.space * 4 && (!best || dist < best.dist)) best = { L, s, dist };
        }
        if (!best) return;
        const bars = best.s.barlines.filter((bx) => bx > best.s.x0 + best.s.space * 1.5);
        const n = best.L.to - best.L.from + 1;
        const edges = bars.length === n ? [best.s.x0, ...bars, best.s.x1 + 1e9] : Array.from({ length: n + 1 }, (_, k) => best.s.x0 + ((best.s.x1 - best.s.x0) * k) / n);
        let k = 0;
        while (k < n - 1 && x > edges[k + 1]) k++;
        pickMeasure(best.L.from + k, e.shiftKey);
      } else {
        const g = e.target.closest('g.measure');
        if (!g) return;
        let idx = 0;
        let found = 0;
        E.canvases.forEach((c) => {
          if (!c.el || !c.el.querySelectorAll) return;
          c.el.querySelectorAll('g.measure').forEach((n) => {
            idx++;
            if (n === g) found = idx;
          });
        });
        if (found) pickMeasure(found, e.shiftKey);
      }
    };
  }

  // ----------------------------------------------------------------------------------- Bedienfelder
  const keyChoices = (mode) => Array.from({ length: 15 }, (_, i) => makeKey(i - 7, mode));

  function renderPanels() {
    const box = $('#sheet-panels');
    box.innerHTML = '';
    if (!E.project) return;
    const p = E.project;
    const xml = projectXml(p);
    const info = analyzeXml(xml);
    const multi = info.parts.length > 1;
    const part = info.parts.find((x) => x.id === E.partId) || info.parts[0];
    const mode = /<mode>minor<\/mode>/.test(xml) ? 'minor' : 'major';
    const keyNow = makeKey(info.fifths, mode);
    const scheme = activeScheme(S.settings);
    const sheet = h('section', 'card step sheet-panel');
    sheet.innerHTML = `
      <div class="step-head"><span class="step-num">2</span><div class="step-title"><h2>Notenblatt bearbeiten</h2><p>${esc(keyNameDe(keyNow))} · ${part ? part.measures : 0} Takte · ${info.parts.length} ${info.parts.length === 1 ? 'Stimme' : 'Stimmen'}</p></div></div>
      <label class="field"><span>Titel</span><input type="text" id="sheet-title" value="${esc(p.title || '')}" maxlength="120" /></label>
      ${multi ? `<div class="part-list" id="sheet-parts">${info.parts.map((x) => `<button type="button" data-part="${esc(x.id)}" class="${x.id === (part && part.id) ? 'active' : ''}"><span>${esc(x.name)}</span><small>${esc(CLEFS[x.clef]?.name || x.clef)}</small></button>`).join('')}</div><p class="muted small">Schlüssel und Instrument gelten für die gewählte Stimme, Transponieren für alle.</p>` : ''}
      <label class="field"><span>Notiert für</span><select id="sheet-source">${instrumentOptions({ concert: true, selected: p.sourceInstrument || (part && part.transposeSemis ? null : 'concert') })}</select></label>
      <div class="sub-label"><span>Schlüssel</span><span class="sub-note">${esc(CLEFS[part?.clef]?.name || '')}</span></div>
      <div class="clef-grid" id="sheet-clefs">
        ${['G2', 'F4', 'C3', 'C4'].map((id) => `<button type="button" class="clef-btn${part?.clef === id ? ' active' : ''}" data-clef="${id}"><b>${{ G2: '𝄞', F4: '𝄢', C3: '𝄡', C4: '𝄡' }[id]}</b><span>${esc(CLEFS[id].name.replace('schlüssel', ''))}</span></button>`).join('')}
      </div>
      <div class="sub-label" style="margin-top:14px"><span>Transponieren</span><span class="sub-note">${esc(keyNameDe(keyNow))}</span></div>
      <div class="sheet-btn-row">
        <button class="btn ghost small" data-tr="-1" type="button">− Halbton</button>
        <button class="btn ghost small" data-tr="1" type="button">+ Halbton</button>
      </div>
      <label class="field"><span>Zieltonart</span><select id="sheet-key">${keyChoices(mode).map((k) => `<option value="${k.fifths}"${k.fifths === info.fifths ? ' selected' : ''}>${esc(keyNameDe(k))}${k.fifths === 0 ? '' : ` (${Math.abs(k.fifths)} ${k.fifths > 0 ? '♯' : '♭'})`}</option>`).join('')}</select></label>
      ${chordsHtml()}
      ${octaveHtml(info, part)}
    `;
    box.appendChild(sheet);

    const inst = h('section', 'card step sheet-panel');
    inst.innerHTML = `
      <div class="step-head"><span class="step-num">3</span><div class="step-title"><h2>Für ein Instrument umschreiben</h2><p>Töne 1:1 – passende Lage, Schlüssel und Vorzeichen</p></div></div>
      <label class="field"><span>Zielinstrument</span><select id="sheet-target">${instrumentOptions({ selected: scheme.voices[0] })}</select></label>
      <div class="sheet-info" id="sheet-range">${rangeText(part, scheme.voices[0])}</div>
      <div class="sheet-btn-row"><button class="btn primary" id="sheet-convert" type="button"><svg><use href="#i-wand" /></svg><span>Umschreiben</span></button></div>
    `;
    box.appendChild(inst);

    const voices = schemeVoices(scheme).slice(1);
    const add = h('section', 'card step sheet-panel');
    add.innerHTML = `
      <div class="step-head"><span class="step-num">4</span><div class="step-title"><h2>Stimmen dazuschreiben</h2><p>Dieses Blatt bleibt Hauptstimme · Schema „${esc(scheme.name)}“</p></div></div>
      <label class="field"><span>Hauptstimme spielt</span><select id="sheet-lead">${instrumentOptions({ selected: p.instrument || (INSTRUMENTS[p.sourceInstrument] ? p.sourceInstrument : scheme.voices[0]) })}</select></label>
      ${voices.length ? `<div class="voice-pick" id="sheet-voices">${voices.map((v, i) => `<label><input type="checkbox" value="${v}" checked /><span>${esc(INSTRUMENTS[v].name)}</span><small>${SLOT_NAMES[i + 1]}</small></label>`).join('')}</div>` : '<p class="muted small">Im aktiven Schema sind keine weiteren Stimmen gesetzt – in den Einstellungen unter „Besetzung“ ergänzen.</p>'}
      <label class="field"><span>Führung</span><select id="sheet-mode-voices"><option value="dynamic">Dynamisch &amp; polyphon</option><option value="classic">Klassischer Solo-Lead</option></select></label>
      <div class="sheet-btn-row"><button class="btn primary" id="sheet-addvoices" type="button" ${voices.length ? '' : 'disabled'}><svg><use href="#i-plus" /></svg><span>Stimmen schreiben</span></button></div>
    `;
    box.appendChild(add);

    const out = h('section', 'card step sheet-panel');
    out.innerHTML = `
      <div class="step-head"><span class="step-num">5</span><div class="step-title"><h2>Speichern &amp; Exportieren</h2></div></div>
      <div class="sheet-btn-row">
        <button class="btn primary" id="sheet-save" type="button"><svg><use href="#i-save" /></svg><span>In Bibliothek speichern</span></button>
      </div>
      <div class="sheet-btn-row">
        <button class="btn ghost small" id="sheet-pdf" type="button"><svg><use href="#i-pdf" /></svg><span>PDF</span></button>
        <button class="btn ghost small" id="sheet-png" type="button"><svg><use href="#i-image" /></svg><span>PNG</span></button>
        <button class="btn ghost small" id="sheet-xml" type="button"><svg><use href="#i-file" /></svg><span>MusicXML</span></button>
        ${multi ? '<button class="btn ghost small" id="sheet-parts-save" type="button"><svg><use href="#i-layers" /></svg><span>Stimmen einzeln speichern</span></button>' : ''}
      </div>
    `;
    box.appendChild(out);
    bindPanels(info, part);
  }

  // Akkordsymbole im Bild (nur bei Scans in der Original-Ansicht)
  function chordsHtml() {
    if (!E.project || E.project.origin !== 'scan' || !E.prepared.length) return '';
    let list = [];
    try {
      E.prepared.forEach((prep) => pageChords(prep).forEach((row) => row.forEach((c) => list.push(c.root.letter + (c.acc ? (c.acc.kind === '#' ? '♯' : '♭') : '')))));
    } catch {
      list = [];
    }
    const on = E.project.chords !== false;
    const info = list.length ? `${list.length} Akkordsymbole erkannt: ${esc(list.slice(0, 14).join(' · '))}${list.length > 14 ? ' …' : ''}` : 'Keine Akkordsymbole im Bild erkannt.';
    return `
      <label class="check-row"><input type="checkbox" id="sheet-chords" ${on ? 'checked' : ''} /><span>Akkordsymbole im Bild mitändern</span></label>
      <p class="muted small" id="sheet-chords-info">${info}${on && list.length ? ' · Zusätze wie „7“ oder „m“ bleiben, nur der Grundton wird angepasst.' : ''}</p>`;
  }

  // Oktavieren: ganzes Stück, Zeile, Takte oder einzelne Töne
  function octaveHtml(info, part) {
    const o = E.oct;
    const total = totalMeasures();
    const scopes = [['all', 'Ganzes Stück'], ['line', 'Zeile'], ['measures', 'Takte'], ['notes', 'Töne']];
    let detail = '';
    if (o.scope === 'line') {
      detail = E.lines.length
        ? `<label class="field"><span>Zeile</span><select id="oct-line">${E.lines.map((L, i) => `<option value="${i + 1}"${o.line === i + 1 ? ' selected' : ''}>Zeile ${i + 1} · Takte ${L.from}–${L.to}</option>`).join('')}</select></label>`
        : '<p class="muted small">Die Zeilen erscheinen, sobald das Blatt gesetzt ist.</p>';
    } else if (o.scope === 'measures') {
      detail = `<div class="oct-range"><label class="field"><span>Von Takt</span><input type="number" id="oct-from" min="1" max="${total}" value="${Math.min(o.from, total)}" inputmode="numeric" /></label><label class="field"><span>bis Takt</span><input type="number" id="oct-to" min="1" max="${total}" value="${Math.min(o.to, total)}" inputmode="numeric" /></label></div><p class="muted small">Oder im Blatt auf einen Takt tippen (Umschalt + Klick erweitert).</p>`;
    } else if (o.scope === 'notes') {
      const d = describeMeasure(projectXml(E.project), { measure: o.measure, partId: part ? part.id : null });
      const chips = d.notes.length
        ? d.notes.map((n) => `<button type="button" class="note-chip${o.notes.has(`${o.measure}:${n.index}`) ? ' on' : ''}${n.grace ? ' grace' : ''}" data-note="${n.index}">${esc(n.label)}</button>`).join('')
        : '<span class="muted small">In diesem Takt stehen keine Töne.</span>';
      detail = `<div class="oct-range"><label class="field"><span>Takt</span><input type="number" id="oct-measure" min="1" max="${total}" value="${o.measure}" inputmode="numeric" /></label></div><div class="note-chips" id="oct-notes">${chips}</div><p class="muted small">Töne antippen, um sie zu wählen – auch über mehrere Takte. <button type="button" class="link-btn" id="oct-clear">Auswahl löschen</button></p>`;
    }
    return `
      <div class="sub-label" style="margin-top:14px"><span>Oktavieren</span><span class="sub-note" id="oct-target">${esc(octTargetText())}</span></div>
      <div class="oct-scope" id="oct-scope" role="radiogroup" aria-label="Was oktavieren">
        ${scopes.map(([id, name]) => `<button type="button" class="oct-btn${o.scope === id ? ' active' : ''}" data-scope="${id}">${name}</button>`).join('')}
      </div>
      ${detail}
      <div class="sheet-btn-row">
        <button class="btn ghost small" data-oct="-1" type="button">Oktave tiefer ↓</button>
        <button class="btn ghost small" data-oct="1" type="button">Oktave höher ↑</button>
      </div>`;
  }

  function rangeText(part, targetId) {
    const t = INSTRUMENTS[targetId];
    if (!part || part.lowest === null || !t) return 'Tonumfang wird nach dem Umschreiben geprüft.';
    const semis = INSTRUMENTS[E.project?.sourceInstrument]?.transpose.semis ?? 0;
    const lo = part.lowest - semis;
    const hi = part.highest - semis;
    return `Klingender Umfang des Blatts: <strong>${noteName(lo)}–${noteName(hi)}</strong> · ${esc(t.name)}: ${noteName(t.range[0])}–${noteName(t.range[1])}, bequem ${noteName(t.comfort[0])}–${noteName(t.comfort[1])}.`;
  }
  const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const noteName = (m) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

  function bindPanels(info, part) {
    const p = E.project;
    const sel = (id) => $(id);
    const after = async (fn) => {
      try {
        fn();
        syncMode();
        await renderView();
      } catch (e) {
        console.error(e);
        toast('Änderung nicht möglich: ' + (e.message || e), 'error');
      }
    };
    sel('#sheet-title').addEventListener('change', (e) => {
      p.title = e.target.value.trim();
      syncMode();
    });
    sel('#sheet-source').addEventListener('change', (e) => {
      p.sourceInstrument = e.target.value;
      S.settings.sheetSourceInstrument = e.target.value;
      renderPanels();
    });
    $$('#sheet-parts button').forEach((b) =>
      b.addEventListener('click', () => {
        E.partId = b.dataset.part;
        renderPanels();
      }),
    );
    $$('#sheet-clefs .clef-btn').forEach((b) =>
      b.addEventListener('click', () => after(() => setClefProject(p, b.dataset.clef, { parts: part ? [part.id] : null }))),
    );
    $$('[data-tr]').forEach((b) => b.addEventListener('click', () => after(() => transposeProject(p, { chromatic: Number(b.dataset.tr) }))));
    $$('#oct-scope .oct-btn').forEach((b) =>
      b.addEventListener('click', () => {
        E.oct.scope = b.dataset.scope;
        if (E.oct.scope === 'notes') E.oct.notes = E.oct.notes || new Set();
        renderPanels();
        paintSelection();
      }),
    );
    $('#oct-line')?.addEventListener('change', (e) => {
      E.oct.line = Number(e.target.value);
      renderPanels();
      paintSelection();
    });
    const clampM = (v) => Math.max(1, Math.min(totalMeasures() || 1, Math.round(Number(v) || 1)));
    $('#oct-from')?.addEventListener('change', (e) => {
      E.oct.from = clampM(e.target.value);
      if (E.oct.to < E.oct.from) E.oct.to = E.oct.from;
      renderPanels();
      paintSelection();
    });
    $('#oct-to')?.addEventListener('change', (e) => {
      E.oct.to = clampM(e.target.value);
      if (E.oct.from > E.oct.to) E.oct.from = E.oct.to;
      renderPanels();
      paintSelection();
    });
    $('#oct-measure')?.addEventListener('change', (e) => {
      E.oct.measure = clampM(e.target.value);
      renderPanels();
      paintSelection();
    });
    $$('#oct-notes .note-chip').forEach((b) =>
      b.addEventListener('click', () => {
        const k = `${E.oct.measure}:${b.dataset.note}`;
        if (E.oct.notes.has(k)) E.oct.notes.delete(k);
        else E.oct.notes.add(k);
        b.classList.toggle('on');
        const t = $('#oct-target');
        if (t) t.textContent = octTargetText();
      }),
    );
    $('#oct-clear')?.addEventListener('click', () => {
      E.oct.notes.clear();
      renderPanels();
    });
    $$('[data-oct]').forEach((b) =>
      b.addEventListener('click', () => {
        const dir = Number(b.dataset.oct);
        const o = E.oct;
        const opts = { octaves: dir, parts: null };
        if (o.scope !== 'all' && info.parts.length > 1 && part) opts.parts = [part.id];
        if (o.scope === 'notes') {
          if (!o.notes.size) return toast('Bitte zuerst Töne antippen.', 'error');
          opts.notes = [...o.notes].map((k) => {
            const [measure, index] = k.split(':').map(Number);
            return { measure, index };
          });
        } else if (o.scope !== 'all') {
          const range = selectedRange();
          if (!range) return toast('Bitte zuerst eine Zeile oder Takte wählen.', 'error');
          opts.measures = range;
        }
        const what = octTargetText();
        after(() => {
          const r = shiftOctaveProject(p, opts);
          if (!r.changed) toast(r.clamped ? 'Weiter geht es nicht – die Töne liegen schon am Rand des Notenbereichs.' : 'Hier gab es nichts zu ändern.');
          else toast(`${what}: ${r.changed} ${r.changed === 1 ? 'Ton' : 'Töne'} ${dir > 0 ? 'eine Oktave höher' : 'eine Oktave tiefer'}${r.clamped ? ` (${r.clamped} am Rand übersprungen)` : ''}`, 'ok');
        });
      }),
    );
    $('#sheet-chords')?.addEventListener('change', (e) =>
      after(() => {
        p.chords = e.target.checked;
      }),
    );
    sel('#sheet-key').addEventListener('change', (e) =>
      after(() => {
        const r = transposeProject(p, { toFifths: Number(e.target.value) });
        if (!r.changed) toast('Das Blatt steht schon in dieser Tonart.');
      }),
    );
    sel('#sheet-target').addEventListener('change', (e) => {
      sel('#sheet-range').innerHTML = rangeText(part, e.target.value);
    });
    sel('#sheet-convert').addEventListener('click', () =>
      after(() => {
        const r = convertProject(p, { targetId: sel('#sheet-target').value, tenorClef: S.settings.tenorClef !== false, partId: part ? part.id : null });
        const t = INSTRUMENTS[sel('#sheet-target').value];
        toast(`Für ${t.name} umgeschrieben${r.octaves ? ` (${r.octaves > 0 ? '+' : ''}${r.octaves} Oktave${Math.abs(r.octaves) > 1 ? 'n' : ''})` : ''}${r.outOfRange ? ` – ${r.outOfRange} Töne liegen außerhalb des Tonumfangs` : ''}`, r.outOfRange ? '' : 'ok');
      }),
    );
    $('#sheet-addvoices')?.addEventListener('click', () => addVoicesNow());
    sel('#sheet-save').addEventListener('click', () => save());
    sel('#sheet-pdf').addEventListener('click', () => exportPdf());
    sel('#sheet-png').addEventListener('click', () => exportPng());
    sel('#sheet-xml').addEventListener('click', () => download(`${safeName(p.title || 'Notenblatt')}.musicxml`, projectXml(p), 'application/vnd.recordare.musicxml+xml'));
    $('#sheet-parts-save')?.addEventListener('click', () => savePartsSeparately());
  }

  async function addVoicesNow() {
    const p = E.project;
    const picked = $$('#sheet-voices input:checked').map((i) => i.value);
    if (!picked.length) return toast('Bitte mindestens eine weitere Stimme wählen.', 'error');
    if (listParts(projectXml(p)).length > 1) return toast('Das Blatt hat schon mehrere Stimmen – bitte zuerst eine Stimme einzeln speichern.', 'error');
    const pg = progress('Stimmen werden geschrieben', { cancellable: false });
    try {
      await new Promise((r) => setTimeout(r, 20));
      const lead = $('#sheet-lead').value;
      const r = addVoices(projectXml(p), {
        sourceId: p.sourceInstrument || 'concert',
        lead,
        voices: picked,
        mode: $('#sheet-mode-voices').value,
        activity: S.opts?.orchActivity ?? 3,
        title: p.title,
      });
      const np = newProject({ title: p.title, xml: r.xml, origin: 'score', sourceInstrument: lead });
      np.instrument = lead;
      np.history = [...p.history];
      setProject(np, { prepared: [], mode: 'engraved', id: E.id });
      notice(`${r.instruments.length} Stimmen: ${r.instruments.map((i) => INSTRUMENTS[i].short.replace(/\.$/, '')).join(', ')}. Die Hauptstimme ist dein Notenblatt (Töne 1:1).`);
      await renderView();
    } catch (e) {
      console.error(e);
      toast('Stimmen konnten nicht geschrieben werden: ' + (e.message || e), 'error');
    } finally {
      pg.done();
    }
  }

  // ----------------------------------------------------------------------------- Speichern/Export
  async function save({ quiet = false } = {}) {
    const p = E.project;
    if (!p) return null;
    const xml = projectXml(p);
    const info = analyzeXml(xml);
    const id = E.id || undefined;
    const prev = id ? await S.library.get(id) : null;
    const key = (i) => `sheet-img:${id || 'neu'}:${i}`;
    const item = {
      id,
      kind: 'sheet',
      title: p.title || 'Notenblatt',
      songTitle: p.title || null,
      folder: prev ? prev.folder || null : E.folder || null,
      createdAt: prev?.createdAt,
      sheet: { origin: p.origin, sourceInstrument: p.sourceInstrument, instrument: p.instrument, chords: p.chords !== false, mode: E.mode, pages: p.pages.map((x) => ({ xml: x.xml, base: x.base })), hasImages: E.prepared.length },
      summary: {
        style: p.origin === 'scan' ? 'Notenblatt (Scan)' : info.parts.length > 1 ? 'Partitur' : 'Notenblatt',
        voices: info.parts.map((x) => x.name),
        key: keyNameDe(makeKey(info.fifths, /<mode>minor<\/mode>/.test(xml) ? 'minor' : 'major')),
        bars: info.parts[0]?.measures || 0,
      },
    };
    const saved = await S.library.save(item);
    E.id = saved.id;
    // aufbereitete Seitenbilder bleiben nur auf diesem Gerät (kein Sync: zu groß)
    if (E.prepared.length && S.local?.setKV) {
      try {
        for (let i = 0; i < E.prepared.length; i++) {
          const blob = await canvasToBlob(grayToCanvas(E.prepared[i].page), 'image/png');
          await S.local.setKV(`sheet-img:${saved.id}:${i}`, blob);
        }
      } catch (e) {
        console.warn('Seitenbilder nicht gespeichert', e);
      }
    }
    void key;
    if (!quiet) toast('In der Bibliothek gespeichert', 'ok');
    return saved;
  }

  async function pagesForExport() {
    if (E.mode === 'original') return E.canvases.map((c) => c.canvas);
    const svgs = E.canvases.map((c) => c.svg).filter(Boolean);
    return svgPagesToCanvases(svgs, S.settings.paper);
  }

  async function exportPdf() {
    const pg = progress('PDF wird erstellt', { cancellable: false });
    try {
      if (E.mode === 'original') await canvasesToPdf(await pagesForExport(), { title: E.project.title, name: `${safeName(E.project.title || 'Notenblatt')}.pdf`, download, original: true });
      else await xmlToPdf(projectXml(E.project), { paper: S.settings.paper, title: E.project.title, name: `${safeName(E.project.title || 'Notenblatt')}.pdf`, download, part: listParts(projectXml(E.project)).length === 1 });
    } catch (e) {
      toast('PDF konnte nicht erstellt werden: ' + (e.message || e), 'error');
    } finally {
      pg.done();
    }
  }

  async function exportPng() {
    const pg = progress('Bilder werden erstellt', { cancellable: false });
    try {
      const canvases = await pagesForExport();
      const base = safeName(E.project.title || 'Notenblatt');
      for (const [i, c] of canvases.entries()) {
        const blob = await canvasToBlob(c, 'image/png');
        download(`${base}${canvases.length > 1 ? `_Seite_${i + 1}` : ''}.png`, new Uint8Array(await blob.arrayBuffer()), 'image/png');
      }
    } finally {
      pg.done();
    }
  }

  async function savePartsSeparately() {
    const p = E.project;
    const xml = projectXml(p);
    const parts = listParts(xml);
    for (const part of parts) {
      await S.library.save({
        kind: 'sheet',
        title: `${p.title || 'Notenblatt'} – ${part.name}`,
        songTitle: p.title || null,
        folder: E.folder || null,
        sheet: { origin: 'datei', sourceInstrument: null, instrument: instrumentIdByName(part.name), mode: 'engraved', pages: [{ xml: extractPart(xml, part.id) }], hasImages: 0 },
        summary: { style: 'Notenblatt', voices: [part.name], key: '', bars: part.notes ? analyzeXml(xml).parts[0].measures : 0 },
      });
    }
    toast(`${parts.length} Stimmen einzeln in der Bibliothek gespeichert`, 'ok');
  }

  // ------------------------------------------------------------------------------ Bibliothek öffnen
  async function openItem(it) {
    const s = it.sheet;
    if (!s) return toast('Dieses Notenblatt ist beschädigt.', 'error');
    const project = newProject({ title: it.title, pages: s.pages.map((x) => ({ xml: x.xml, base: x.base })), origin: s.origin === 'scan' ? 'scan' : s.origin || 'datei', sourceInstrument: s.sourceInstrument });
    project.instrument = s.instrument || null;
    project.chords = s.chords !== false;
    const prepared = [];
    if (s.hasImages && S.local?.getKV) {
      try {
        for (let i = 0; i < s.hasImages; i++) {
          const blob = await S.local.getKV(`sheet-img:${it.id}:${i}`);
          if (!blob) throw new Error('Bild fehlt');
          const img = await decodeImage(blob);
          const page = toGray(img);
          prepared.push({ page, staves: analyzePage(page), skew: 0 });
        }
      } catch {
        prepared.length = 0;
      }
    }
    E.folder = it.folder || null;
    setProject(project, { prepared, mode: prepared.length ? s.mode || 'original' : 'engraved', id: it.id });
    showView('sheet');
    notice(s.hasImages && !prepared.length ? 'Die Original-Seite liegt nur auf dem Gerät, auf dem das Blatt eingescannt wurde – hier wird es neu gesetzt.' : '');
    await renderView();
  }

  // ------------------------------------------------------------------------- Bibliothek: Auswahl
  const sel = { on: false, ids: new Set() };
  function setSelecting(on) {
    sel.on = on;
    if (!on) sel.ids.clear();
    $('#library-grid').classList.toggle('selecting', on);
    $('#lib-selbar').classList.toggle('hidden', !on);
    $('#lib-select span').textContent = on ? 'Auswahl beenden' : 'Auswählen';
    $('#folder-select span').textContent = on ? 'Auswahl beenden' : 'Auswählen';
    updateSelCount();
    env.renderLibrary();
  }
  function updateSelCount() {
    $('#lib-selcount').textContent = `${sel.ids.size} ausgewählt`;
    $('#lib-merge-score').disabled = sel.ids.size < 2;
    $('#lib-merge-pdf').disabled = sel.ids.size < 1;
  }
  // Wird von der Bibliothek je Karte aufgerufen
  function decorateCard(card, it) {
    if (!sel.on) return;
    card.classList.toggle('selected', sel.ids.has(it.id));
    const cb = h('input', 'lib-check');
    cb.type = 'checkbox';
    cb.checked = sel.ids.has(it.id);
    cb.setAttribute('aria-label', `„${it.title}“ auswählen`);
    const toggle = () => {
      if (sel.ids.has(it.id)) sel.ids.delete(it.id);
      else sel.ids.add(it.id);
      cb.checked = sel.ids.has(it.id);
      card.classList.toggle('selected', cb.checked);
      updateSelCount();
    };
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
    card.addEventListener('click', (e) => {
      if (e.target.closest('button, input')) return;
      toggle();
    });
    card.appendChild(cb);
  }

  async function selectedItems() {
    const out = [];
    for (const id of sel.ids) {
      const it = await S.library.get(id);
      if (it && !it.deleted) out.push(it);
    }
    // Reihenfolge wie im Schema: erst nach Auswahlreihenfolge (Set bleibt in Einfügereihenfolge)
    return out;
  }

  function itemXml(it) {
    if (it.sheet) return projectXml(newProject({ pages: it.sheet.pages.map((x) => ({ xml: x.xml })) }));
    return null;
  }

  async function itemPages(it, pg) {
    if (!it.sheet) throw new Error(`„${it.title}“ ist ein Arrangement – bitte als Notenblatt speichern oder dort „Noten ändern“ nutzen`);
    const s = it.sheet;
    // Original-Seiten, wenn die Bilder auf diesem Gerät liegen
    if (s.hasImages && S.local?.getKV && s.mode === 'original') {
      try {
        const out = [];
        for (let i = 0; i < s.hasImages; i++) {
          const blob = await S.local.getKV(`sheet-img:${it.id}:${i}`);
          if (!blob) throw new Error('Bild fehlt');
          const img = await decodeImage(blob);
          const page = toGray(img);
          const prep = { page, staves: analyzePage(page), skew: 0 };
          const pgs = s.pages[i];
          out.push(grayToCanvas(pgs.base && pgs.xml === pgs.base ? prep.page : await renderScanPage(prep, pgs.xml, { base: pgs.base, chords: s.chords !== false })));
        }
        return out;
      } catch {
        // neu gesetzt
      }
    }
    const xml = itemXml(it);
    const svgs = await renderPages(xml, { paper: S.settings.paper, part: partsOf(readScore(xml)).length === 1, zoom: S.settings.notesZoom, onProgress: (t, f) => pg?.set(`${it.title}: ${t}`, f) });
    return svgPagesToCanvases(svgs, S.settings.paper);
  }

  // Dialog mit sortierbarer Seitenliste -> ein PDF
  async function mergePdf() {
    const items = await selectedItems();
    if (!items.length) return;
    const pg = progress('Seiten werden vorbereitet', { cancellable: false });
    let rows = [];
    try {
      for (const it of items) {
        const pages = await itemPages(it, pg);
        pages.forEach((c, i) => rows.push({ canvas: c, name: it.title, page: i + 1, of: pages.length, on: true }));
      }
    } catch (e) {
      pg.done();
      return toast(e.message || String(e), 'error');
    }
    pg.done();
    const dlg = $('#sheet-dialog');
    $('#sheet-dialog-title').textContent = 'PDF zusammenstellen';
    $('#sheet-dialog-sub').textContent = 'Reihenfolge ändern, Seiten abwählen – dann als ein PDF speichern.';
    const body = $('#sheet-dialog-body');
    const foot = $('#sheet-dialog-foot');
    const draw = () => {
      body.innerHTML = '';
      rows.forEach((r, i) => {
        const row = h('div', 'order-row' + (r.on ? '' : ' off'));
        const img = new Image();
        img.src = r.thumb || (r.thumb = thumbOf(r.canvas));
        img.alt = '';
        const name = h('div', 'order-name', `<span>${esc(r.name)}</span><small>Seite ${r.page} von ${r.of}</small>`);
        const btns = h('div', 'order-btns');
        const mk = (label, title, fn, disabled) => {
          const b = h('button', 'icon-btn small');
          b.type = 'button';
          b.textContent = label;
          b.title = title;
          b.disabled = !!disabled;
          b.addEventListener('click', (e) => {
            e.preventDefault();
            fn();
            draw();
          });
          btns.appendChild(b);
        };
        mk('↑', 'Nach oben', () => [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]], i === 0);
        mk('↓', 'Nach unten', () => [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]], i === rows.length - 1);
        mk(r.on ? '✕' : '＋', r.on ? 'Seite weglassen' : 'Seite wieder aufnehmen', () => (r.on = !r.on));
        row.append(img, name, btns);
        body.appendChild(row);
      });
    };
    draw();
    foot.innerHTML = '';
    const cancel = h('button', 'btn ghost');
    cancel.type = 'button';
    cancel.textContent = 'Abbrechen';
    cancel.addEventListener('click', () => dlg.close());
    const go = h('button', 'btn primary');
    go.type = 'button';
    go.innerHTML = '<svg><use href="#i-pdf" /></svg><span>PDF speichern</span>';
    go.addEventListener('click', async () => {
      const use = rows.filter((r) => r.on).map((r) => r.canvas);
      if (!use.length) return toast('Mindestens eine Seite wählen.', 'error');
      dlg.close();
      const p2 = progress('PDF wird erstellt', { cancellable: false });
      try {
        await canvasesToPdf(use, { title: items.length === 1 ? items[0].title : 'NoteCode Notenblätter', name: `${safeName(items.length === 1 ? items[0].title : 'Notenblaetter')}.pdf`, download, original: true });
      } finally {
        p2.done();
      }
    });
    foot.append(cancel, go);
    dlg.showModal();
  }

  const thumbOf = (c) => {
    const t = document.createElement('canvas');
    const f = 120 / c.width;
    t.width = 120;
    t.height = Math.round(c.height * f);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.7);
  };

  // Auswahl -> eine Partitur (Stimmen in Auswahlreihenfolge, Name aus dem Titel)
  async function mergeToScore() {
    const items = await selectedItems();
    const sheets = items.filter((i) => i.sheet);
    if (sheets.length < 2) return toast('Bitte mindestens zwei Notenblätter auswählen.', 'error');
    const first = sheets[0];
    const defaultTitle = (first.songTitle || first.title || 'Partitur').replace(/\s+[–-]\s+.*$/, '') + ' (Partitur)';
    const dlg = $('#sheet-dialog');
    $('#sheet-dialog-title').textContent = 'Zu einer Partitur';
    $('#sheet-dialog-sub').textContent = `${sheets.length} Stimmen – Titel und Reihenfolge festlegen.`;
    const body = $('#sheet-dialog-body');
    const foot = $('#sheet-dialog-foot');
    const order = sheets.map((s) => ({ it: s, name: s.sheet.instrument ? INSTRUMENTS[s.sheet.instrument]?.name : analyzeXml(itemXml(s)).parts[0]?.name || s.title, inst: s.sheet.instrument || instrumentIdByName(analyzeXml(itemXml(s)).parts[0]?.name) }));
    // Systeme nach dem aktiven Schema ordnen (Maininstrument oben, dann 2. Stimme …); Unbekanntes bleibt in der Auswahlreihenfolge dahinter
    {
      const slots = activeScheme(S.settings).voices;
      const used = new Set();
      const rank = (o) => {
        const i = slots.findIndex((v, k) => v && v === o.inst && !used.has(k));
        if (i >= 0) used.add(i);
        return i >= 0 ? i : 99;
      };
      // gleiche Instrumente nach Namen (… 1 vor … 2), dann nach den Plätzen des Schemas
      order.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
      order.forEach((o) => (o.rank = rank(o)));
      order.sort((a, b) => a.rank - b.rank);
    }
    const titleIn = h('label', 'field', `<span>Titel der Partitur</span><input type="text" value="${esc(defaultTitle)}" maxlength="120" />`);
    const list = h('div', 'part-list');
    const draw = () => {
      list.innerHTML = '';
      order.forEach((o, i) => {
        const row = h('div', 'order-row');
        row.style.gridTemplateColumns = 'minmax(0,1fr) auto';
        row.appendChild(h('div', 'order-name', `<span>${esc(o.name)}</span><small>${esc(o.it.title)}</small>`));
        const btns = h('div', 'order-btns');
        for (const [label, d] of [['↑', -1], ['↓', 1]]) {
          const b = h('button', 'icon-btn small');
          b.type = 'button';
          b.textContent = label;
          b.disabled = i + d < 0 || i + d >= order.length;
          b.addEventListener('click', (e) => {
            e.preventDefault();
            [order[i + d], order[i]] = [order[i], order[i + d]];
            draw();
          });
          btns.appendChild(b);
        }
        row.appendChild(btns);
        list.appendChild(row);
      });
    };
    draw();
    body.innerHTML = '';
    body.append(titleIn, list);
    foot.innerHTML = '';
    const cancel = h('button', 'btn ghost');
    cancel.type = 'button';
    cancel.textContent = 'Abbrechen';
    cancel.addEventListener('click', () => dlg.close());
    const go = h('button', 'btn primary');
    go.type = 'button';
    go.innerHTML = '<svg><use href="#i-layers" /></svg><span>Partitur erstellen</span>';
    go.addEventListener('click', async () => {
      dlg.close();
      try {
        const title = titleIn.querySelector('input').value.trim() || defaultTitle;
        const r = mergeScores(order.map((o) => ({ xml: itemXml(o.it), name: o.name })), { title });
        const saved = await S.library.save({
          kind: 'sheet',
          title,
          songTitle: title,
          folder: first.folder || null,
          sheet: { origin: 'score', sourceInstrument: null, instrument: null, mode: 'engraved', pages: [{ xml: r.xml }], hasImages: 0 },
          summary: { style: 'Partitur', voices: order.map((o) => o.name), key: '', bars: r.measures },
        });
        toast(`Partitur mit ${r.parts} Stimmen gespeichert`, 'ok');
        setSelecting(false);
        const it = await S.library.get(saved.id);
        openItem(it);
      } catch (e) {
        toast('Partitur konnte nicht erstellt werden: ' + (e.message || e), 'error');
      }
    });
    foot.append(cancel, go);
    dlg.showModal();
  }

  // --------------------------------------------------------------------------- Einstellungen: Schemas
  function renderSchemes() {
    const st = S.settings;
    const n = normalizeSchemes(st);
    const cur = n.schemes.find((s) => s.id === n.activeScheme);
    const selEl = $('#scheme-select');
    selEl.innerHTML = n.schemes.map((s) => `<option value="${esc(s.id)}"${s.id === cur.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    const box = $('#scheme-slots');
    box.innerHTML = '';
    cur.voices.forEach((v, i) => {
      const row = h('label', 'scheme-slot' + (i === 0 ? ' main' : ''));
      row.appendChild(h('span', '', SLOT_NAMES[i]));
      const s = document.createElement('select');
      s.innerHTML = instrumentOptions({ none: i > 0, selected: v });
      s.value = v || '';
      s.addEventListener('change', () => commit(setSlot(n.schemes, cur.id, i, s.value || null), cur.id));
      row.appendChild(s);
      box.appendChild(row);
    });
    return n;
  }

  async function commit(list, activeId) {
    const patch = { schemes: list, activeScheme: activeId };
    const active = list.find((s) => s.id === activeId);
    // „Noten schreiben“ (alte Version) startet mit den Stimmen des aktiven Schemas
    patch.defaultVoices = schemeVoices(active).slice(0, 8);
    await env.updateSettings(patch);
    renderSchemes();
  }

  function bindSchemes() {
    $('#scheme-select').addEventListener('change', (e) => commit(normalizeSchemes(S.settings).schemes, e.target.value));
    $('#scheme-new').addEventListener('click', () => {
      const n = normalizeSchemes(S.settings);
      const name = prompt('Name des neuen Schemas', 'Neues Schema');
      if (!name) return;
      const r = addScheme(n.schemes, { name: name.trim() || 'Neues Schema', voices: ['trumpet', null, null, null, null, null] });
      commit(r.list, r.id);
    });
    $('#scheme-copy').addEventListener('click', () => {
      const n = normalizeSchemes(S.settings);
      const cur = n.schemes.find((s) => s.id === n.activeScheme);
      const r = addScheme(n.schemes, { name: `${cur.name} (Kopie)`, from: cur.id });
      commit(r.list, r.id);
    });
    $('#scheme-rename').addEventListener('click', () => {
      const n = normalizeSchemes(S.settings);
      const cur = n.schemes.find((s) => s.id === n.activeScheme);
      const name = prompt('Neuer Name', cur.name);
      if (!name || !name.trim()) return;
      commit(updateScheme(n.schemes, cur.id, { name: name.trim() }), cur.id);
    });
    $('#scheme-delete').addEventListener('click', () => {
      const n = normalizeSchemes(S.settings);
      if (n.schemes.length <= 1) return toast('Ein Schema muss bleiben.');
      const cur = n.schemes.find((s) => s.id === n.activeScheme);
      if (!confirm(`Schema „${cur.name}“ löschen?`)) return;
      const list = removeScheme(n.schemes, cur.id);
      commit(list, list[0].id);
    });
  }

  // ------------------------------------------------------------------------------------- Einbinden
  function mount() {
    $('#home-edit').addEventListener('click', () => showView('sheet'));
    $('#home-write').addEventListener('click', () => showView('arrange'));
    const onFiles = (files) => files && files.length && loadFiles(files);
    $('#sheet-file').addEventListener('change', (e) => {
      onFiles(e.target.files);
      e.target.value = '';
    });
    $('#sheet-camera').addEventListener('change', (e) => {
      onFiles(e.target.files);
      e.target.value = '';
    });
    const dz = $('#sheet-drop');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), dz.classList.add('over'))));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), dz.classList.remove('over'))));
    dz.addEventListener('drop', (e) => onFiles(e.dataTransfer.files));
    $('#sheet-from-lib').addEventListener('click', async () => {
      const items = (await S.library.list()).filter((i) => i.sheet);
      if (!items.length) return toast('In der Bibliothek liegt noch kein Notenblatt.');
      const dlg = $('#sheet-dialog');
      $('#sheet-dialog-title').textContent = 'Notenblatt aus der Bibliothek';
      $('#sheet-dialog-sub').textContent = '';
      const body = $('#sheet-dialog-body');
      body.innerHTML = '';
      for (const it of items) {
        const b = h('button', 'move-opt');
        b.type = 'button';
        b.innerHTML = `<svg><use href="#i-file" /></svg><span>${esc(it.title)}</span><small>${esc(it.summary?.style || '')}</small>`;
        b.addEventListener('click', () => {
          dlg.close();
          openItem(it);
        });
        body.appendChild(b);
      }
      $('#sheet-dialog-foot').innerHTML = '';
      dlg.showModal();
    });
    $$('#sheet-mode .seg').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.disabled) return;
        E.mode = b.dataset.mode;
        renderView();
      }),
    );
    $('#sheet-undo').addEventListener('click', async () => {
      if (E.project && undo(E.project)) await renderView();
    });
    $('#sheet-redo').addEventListener('click', async () => {
      if (E.project && redo(E.project)) await renderView();
    });
    $('#lib-select').addEventListener('click', () => setSelecting(!sel.on));
    $('#folder-select').addEventListener('click', () => setSelecting(!sel.on));
    $('#lib-select-off').addEventListener('click', () => setSelecting(false));
    $('#lib-merge-pdf').addEventListener('click', () => mergePdf());
    $('#lib-merge-score').addEventListener('click', () => mergeToScore());
    bindSchemes();
    renderSchemes();
    $('#omr-recheck').addEventListener('click', async () => {
      $('#omr-status').textContent = 'Wird geprüft …';
      const d = window.notecodeDesktop;
      if (d && d.omrStatus) await d.omrStatus(true).catch(() => null);
      refreshEngine();
    });
    refreshEngine();
  }

  return { mount, renderHome, renderSchemes, openItem, decorateCard, onShowSheet: refreshEngine, isSelecting: () => sel.on, save };
}
