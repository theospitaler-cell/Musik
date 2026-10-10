// Übe-Tempo: die Aufnahme wird ohne Tonhöhenänderung gestreckt und bleibt dabei exakt
// auf der Zeitachse der Noten (kein Wegdriften, auch nach vielen Sekunden).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StretchEngine } from '../src/web/stretch-worklet.js';

const SR = 44100;

function renderAll(engine, n) {
  const out = engine.ch.map(() => new Float32Array(n));
  // in kleinen Blöcken wie im Audio-Thread (128 Samples)
  for (let k = 0; k < n; k += 128) engine.render(out, k, Math.min(128, n - k));
  return out;
}

// Klicks (kurze Impulse) alle 0,25 s -> Schwerpunkt jedes Klicks in der Ausgabe
function clickTrack(sec, every = 0.25) {
  const x = new Float32Array(Math.round(sec * SR));
  const times = [];
  for (let t = 0.1; t < sec - 0.1; t += every) {
    const i = Math.round(t * SR);
    for (let k = 0; k < 40; k++) x[i + k] = Math.exp(-k / 8) * (k % 2 ? -1 : 1);
    times.push(t);
  }
  return { x, times };
}

function centroid(y, center, radius) {
  let s = 0;
  let w = 0;
  for (let i = Math.max(0, center - radius); i < Math.min(y.length, center + radius); i++) {
    const e = y[i] * y[i];
    s += e * i;
    w += e;
  }
  return w > 0 ? s / w : null;
}

for (const speed of [0.5, 0.75, 1.2]) {
  test(`Übe-Tempo ${Math.round(speed * 100)} %: Klicks liegen ohne Drift an der richtigen Stelle`, () => {
    const { x, times } = clickTrack(30);
    const eng = new StretchEngine([x, x], SR);
    eng.start(0, speed);
    const y = renderAll(eng, Math.round((30 / speed) * SR))[0];
    let worst = 0;
    for (const t of times) {
      const want = (t / speed) * SR;
      const c = centroid(y, Math.round(want), Math.round(0.06 * SR));
      assert.ok(c !== null, `Klick bei ${t}s fehlt`);
      worst = Math.max(worst, Math.abs(c - want) / SR);
    }
    // Schwerpunkt jedes Klicks innerhalb von 4 ms – auch nach 30 s kein Drift
    assert.ok(worst < 0.004, `max. Abweichung ${(worst * 1000).toFixed(1)} ms`);
  });
}

test('Übe-Tempo: Tonhöhe bleibt erhalten (Sinus 440 Hz bei 75 % und 50 %)', () => {
  const x = new Float32Array(SR * 4);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
  for (const speed of [0.75, 0.5]) {
    const eng = new StretchEngine([x], SR);
    eng.start(0, speed);
    const y = renderAll(eng, Math.round((3.5 / speed) * SR))[0];
    // Nulldurchgänge im eingeschwungenen Teil zählen
    const a = Math.round(0.5 * SR);
    const b = y.length - Math.round(0.2 * SR);
    let zc = 0;
    for (let i = a + 1; i < b; i++) if ((y[i - 1] < 0 && y[i] >= 0) || (y[i - 1] >= 0 && y[i] < 0)) zc++;
    const f = zc / 2 / ((b - a) / SR);
    assert.ok(Math.abs(f - 440) < 4, `Frequenz ${f.toFixed(1)} Hz bei ${speed}`);
    // gleichmäßige Lautstärke (keine Lücken oder Auslöschungen)
    let min = Infinity;
    for (let i = a; i + 2048 < b; i += 2048) {
      let e = 0;
      for (let k = 0; k < 2048; k++) e += y[i + k] * y[i + k];
      min = Math.min(min, Math.sqrt(e / 2048));
    }
    assert.ok(min > 0.3, `Pegel bricht ein (${min.toFixed(2)})`);
  }
});

test('Originaltempo: Aufnahme wird sample-genau durchgereicht, auch mit Vorlauf und Startposition', () => {
  const x = new Float32Array(SR);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.01) * 0.5;
  const eng = new StretchEngine([x], SR);
  eng.start(-1000, 1); // Aufnahme beginnt erst nach 1000 Samples
  const y = renderAll(eng, 5000)[0];
  assert.equal(y[999], 0);
  assert.equal(y[1000], x[0]);
  assert.equal(y[4000], x[3000]);
  eng.start(20000, 1);
  const z = renderAll(eng, 300)[0];
  assert.equal(z[17], x[20017]);
});
