// Üben im Player: Wiedergabe-Tempo (50–120 % in 5er-Schritten, Schnellwahl 50/75/100 %) für
// Noten und Original-Aufnahme gemeinsam, und "Mitlaufen" (Noten blättern automatisch mit).
// Beim Schlagzeug-Modus ist die Tempo-Wahl hervorgehoben.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let hintShown = false;

function showSpeed(pct) {
  $('#p-speed').value = String(pct);
  $('#p-speed-label').textContent = `${pct} %`;
  $$('#p-speed-quick [data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === pct));
  $('#player')?.classList.toggle('slowed', pct !== 100);
}

function speedPct() {
  return Number($('#p-speed').value) || 100;
}

function renderFollow(f) {
  const b = $('#p-follow');
  if (!b) return;
  const state = !f.enabled ? 'off' : f.userPaused ? 'paused' : 'on';
  b.classList.toggle('on', state === 'on');
  b.classList.toggle('paused', state === 'paused');
  b.setAttribute('aria-pressed', String(f.enabled));
  b.title =
    state === 'on'
      ? 'Mitlaufen: Noten blättern beim Abspielen automatisch mit (an)'
      : state === 'paused'
        ? 'Mitlaufen pausiert, weil du selbst gescrollt hast – tippen zum Fortsetzen'
        : 'Mitlaufen ist aus – tippen zum Einschalten';
  const lab = b.querySelector('span');
  if (lab) lab.textContent = state === 'paused' ? 'Pausiert' : 'Mitlaufen';
}

// einmalig beim Start der App
export function bindPractice({ getPlayer, follower }) {
  const range = $('#p-speed');
  const apply = (pct) => {
    pct = Math.max(50, Math.min(120, Math.round(pct / 5) * 5));
    showSpeed(pct);
    getPlayer()?.setSpeed(pct / 100);
  };
  // beim Ziehen nur anzeigen, beim Loslassen übernehmen (kein Stottern)
  range.addEventListener('input', () => showSpeed(speedPct()));
  range.addEventListener('change', () => apply(speedPct()));
  $$('#p-speed-quick [data-speed]').forEach((b) => b.addEventListener('click', () => apply(Number(b.dataset.speed))));
  // Tastatur: + / − ändern das Tempo in 5er-Schritten
  document.addEventListener('keydown', (e) => {
    if (!getPlayer() || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '-') {
      e.preventDefault();
      apply(speedPct() + (e.key === '+' ? 5 : -5));
    }
  });
  follower.onChange = renderFollow;
  $('#p-follow')?.addEventListener('click', () => {
    if (follower.enabled && follower.userPaused) follower.resume();
    else follower.setEnabled(!follower.enabled);
  });
  renderFollow(follower);
  showSpeed(speedPct());
}

// für jeden neuen Player: gewähltes Übe-Tempo übernehmen, Schlagzeug-Modus hervorheben
export function syncPractice(player, arr, toast = null) {
  player.setSpeed(speedPct() / 100);
  const drums = arr?.options?.ensemble === 'drums';
  $('#player')?.classList.toggle('practice', drums);
  const t = $('#p-speed-title');
  if (t) t.textContent = drums ? 'Übe-Tempo' : 'Tempo';
  if (drums && !hintShown && toast) {
    hintShown = true;
    toast('Üben: Tempo unten wählen (z. B. 50 % oder 75 %) – Noten und Aufnahme bleiben synchron, die Noten blättern automatisch mit.');
  }
}
