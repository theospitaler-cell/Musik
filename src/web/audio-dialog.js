// Dialog "Audio als MP3": Gesamtmix (wie im Mischpult) oder eine einzelne Stimme, wahlweise
// mit der Original-Aufnahme, im Original- oder Übe-Tempo. Berechnung & Kodierung lokal.
import { renderMixdown, encodeMp3, canStretchOffline } from './audio-export.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// auch bei verdecktem Fenster weiterlaufen (dort liefert der Browser keine Bilder)
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
let busy = false;

function dialogEl() {
  let dlg = document.getElementById('mp3-dialog');
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.id = 'mp3-dialog';
  dlg.className = 'mp3-dialog';
  dlg.innerHTML = `<form method="dialog" class="mp3-form">
      <div class="mp3-head"><span class="mp3-icon"><svg><use href="#i-wave" /></svg></span><div><h2>Audio als MP3</h2><p class="muted small">Die Vorschau-Wiedergabe als Datei – wird direkt auf diesem Gerät berechnet.</p></div></div>
      <div class="segmented mp3-mode" role="radiogroup" aria-label="Inhalt">
        <button type="button" class="seg active" data-mode="mix">Gesamtmix</button>
        <button type="button" class="seg" data-mode="part">Einzelne Stimme</button>
      </div>
      <p class="muted small mp3-mix-hint">Alle Stimmen so, wie sie im Mischpult eingestellt sind (Lautstärke, Stumm, Solo, Panorama).</p>
      <label class="field mp3-part hidden"><span>Stimme</span><select id="mp3-part"></select></label>
      <label class="toggle-row mp3-rec hidden"><span><strong>Original-Aufnahme mitmischen</strong><small>die geladene Aufnahme läuft synchron mit</small></span><input type="checkbox" class="switch" id="mp3-rec" /></label>
      <div class="field mp3-tempo hidden"><span>Tempo</span>
        <div class="segmented small" role="radiogroup" aria-label="Tempo"><button type="button" class="seg active" data-speed="1">Original (100 %)</button><button type="button" class="seg" data-speed="practice">Übe-Tempo</button></div>
        <small class="muted mp3-tempo-note"></small>
      </div>
      <label class="field"><span>Qualität</span><select id="mp3-kbps"><option value="128">128 kbit/s – kleine Datei</option><option value="192" selected>192 kbit/s – Standard</option><option value="256">256 kbit/s – hoch</option></select></label>
      <div class="mp3-actions"><button type="button" class="btn ghost" data-act="cancel">Abbrechen</button><button type="submit" class="btn primary" value="ok" data-act="ok"><svg><use href="#i-download" /></svg><span>MP3 erstellen</span></button></div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.querySelector('[data-act="cancel"]').addEventListener('click', () => dlg.close('cancel'));
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close('cancel')); // Klick neben den Dialog
  return dlg;
}

// deps: {player, arr, baseName, safeName, progress, download, toast}
export function openAudioExport(deps) {
  const { player } = deps;
  if (!player) return;
  if (busy) {
    deps.toast('Ein MP3 wird gerade erstellt …');
    return;
  }
  const dlg = dialogEl();
  const $ = (s) => dlg.querySelector(s);
  const recPart = player.parts.find((p) => p.audio);
  const speed = player.speed;
  const st = { mode: 'mix', rec: recPart ? player.audible(recPart) : false, recTouched: false, speed: 1 };
  // Stimmen zur Auswahl (die Aufnahme selbst über den Schalter)
  const sel = $('#mp3-part');
  sel.innerHTML = player.parts
    .filter((p) => !p.audio)
    .map((p) => `<option value="${esc(p.key)}">${esc(p.title)}${p.sub && p.sub !== p.title ? ` – ${esc(p.sub)}` : ''}</option>`)
    .join('');
  const firstAudible = player.parts.find((p) => !p.audio && player.audible(p));
  if (firstAudible) sel.value = String(firstAudible.key);
  const render = () => {
    dlg.querySelectorAll('.mp3-mode .seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === st.mode));
    $('.mp3-mix-hint').classList.toggle('hidden', st.mode !== 'mix');
    $('.mp3-part').classList.toggle('hidden', st.mode !== 'part');
    $('.mp3-rec').classList.toggle('hidden', !recPart);
    $('#mp3-rec').checked = st.rec;
    const tempo = $('.mp3-tempo');
    tempo.classList.toggle('hidden', speed === 1);
    const stretchOk = !(st.rec && recPart) || canStretchOffline();
    if (!stretchOk) st.speed = 1;
    const pb = tempo.querySelector('[data-speed="practice"]');
    pb.textContent = `Übe-Tempo (${Math.round(speed * 100)} %)`;
    pb.disabled = !stretchOk;
    tempo.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', (b.dataset.speed === 'practice' ? speed : 1) === st.speed));
    $('.mp3-tempo-note').textContent = stretchOk ? (st.speed !== 1 ? 'Langsamer zum Üben – die Aufnahme behält ihre Tonhöhe.' : '') : 'Übe-Tempo mit Aufnahme kann dieser Browser nicht berechnen.';
  };
  dlg.querySelectorAll('.mp3-mode .seg').forEach(
    (b) =>
      (b.onclick = () => {
        st.mode = b.dataset.mode;
        // Einzelstimme: Aufnahme standardmäßig aus (außer bewusst eingeschaltet)
        if (!st.recTouched && recPart) st.rec = st.mode === 'mix' ? player.audible(recPart) : false;
        render();
      }),
  );
  $('#mp3-rec').onchange = (e) => {
    st.rec = e.target.checked;
    st.recTouched = true;
    render();
  };
  $('.mp3-tempo')
    .querySelectorAll('.seg')
    .forEach(
      (b) =>
        (b.onclick = () => {
          st.speed = b.dataset.speed === 'practice' ? speed : 1;
          render();
        }),
    );
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    run(deps, { mode: st.mode, partKey: sel.value, withRecording: !!recPart && st.rec, speed: st.speed, kbps: Number($('#mp3-kbps').value) || 192 });
  };
  render();
  dlg.returnValue = '';
  dlg.showModal();
}

async function run(deps, o) {
  const { player, arr, baseName, safeName, progress, download, toast } = deps;
  const part = o.mode === 'part' ? player.part(o.partKey) : null;
  const hasRec = player.parts.some((p) => p.audio);
  let name = part ? `${baseName}_${safeName(part.title)}${part.sub && part.sub !== part.title ? `_${safeName(part.sub)}` : ''}` : `${baseName}_Mix`;
  if (hasRec) name += part ? (o.withRecording ? '_mit_Original' : '') : o.withRecording ? '' : '_ohne_Original';
  if (o.speed !== 1) name += `_Tempo_${Math.round(o.speed * 100)}`;
  const title = `${arr.meta?.title || 'NoteCode'} – ${part ? part.title : 'Mix'}${o.speed !== 1 ? ` (${Math.round(o.speed * 100)} %)` : ''}`;
  busy = true;
  const pg = progress('MP3 wird erstellt');
  try {
    pg.set('Stimmen werden berechnet', 0.01);
    await nextFrame();
    const t0 = performance.now();
    const mix = await renderMixdown(player, { ...o, onProgress: (t, f) => pg.set(t, 0.01 + 0.55 * f) });
    pg.set('MP3 wird kodiert', 0.57);
    await nextFrame();
    const blob = await encodeMp3(mix.channels, mix.sampleRate, { kbps: o.kbps, title, onProgress: (f) => pg.set('MP3 wird kodiert', 0.57 + 0.42 * f) });
    console.info(`MP3 (${(mix.duration / 60).toFixed(1)} min) in ${Math.round(performance.now() - t0)} ms`);
    pg.set('Fertig', 1);
    download(`${name}.mp3`, blob, 'audio/mpeg');
    toast(`MP3 erstellt: ${Math.floor(mix.duration / 60)}:${String(Math.round(mix.duration % 60)).padStart(2, '0')} min · ${(blob.size / 1048576).toFixed(1)} MB`, 'ok');
  } catch (e) {
    console.error(e);
    toast('MP3-Export fehlgeschlagen: ' + e.message, 'error');
  } finally {
    busy = false;
    setTimeout(() => pg.done(), 400);
  }
}
