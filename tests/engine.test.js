import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange } from '../src/arrange/engine.js';
import { PRESETS, slideGlissPossible, INSTRUMENTS } from '../src/arrange/instruments.js';
import { STYLE_LIST } from '../src/arrange/styles.js';
import { demoSong } from './helpers.js';
import { exportMusicXML } from '../src/output/musicxml.js';

const song = demoSong('saints');

test('alle Stile × Besetzungen: Tonumfang, keine Überlappungen, Bewegungsregel', () => {
  for (const { id: style } of STYLE_LIST) {
    for (const p of PRESETS) {
      const a = arrange(song, { style, voices: p.voices, drums: true, seed: 3 });
      a.voices.forEach((v) => {
        for (let i = 0; i < v.events.length; i++) {
          const e = v.events[i];
          for (const m of e.pitches) assert.ok(m >= v.inst.range[0] && m <= v.inst.range[1], `${style}/${p.id}: ${v.inst.name} außerhalb des Tonumfangs (${m})`);
          if (i) assert.ok(v.events[i - 1].start + v.events[i - 1].dur <= e.start, `${style}/${p.id}: Überlappung in ${v.inst.name}`);
        }
      });
      assert.equal(a.report.longNotesCovered, a.report.longNotes, `${style}/${p.id}: lange Melodietöne ohne Bewegung`);
      assert.ok(a.drums.events.length > 0);
    }
  }
});

test('Rollentausch: Melodie wandert zwischen den Stimmen', () => {
  const a = arrange(song, { style: 'funk', seed: 1 });
  const melodyVoices = new Set();
  for (const b of a.blocks) for (const seg of b.segments) seg.roles.forEach((r, i) => r === 'melody' && melodyVoices.add(i));
  assert.ok(melodyVoices.size >= 2, 'Melodie in mindestens zwei Stimmen');
});

test('Originallänge: jeder Formteil einmal, nur kurzes Intro & Schluss', () => {
  for (const id of ['saints', 'ode', 'grace', 'groove']) {
    const sg = demoSong(id);
    const a = arrange(sg, { style: 'funk', seed: 1 });
    assert.ok(a.totalBars <= sg.measureCount + 8, `${id}: ${a.totalBars} Takte bei ${sg.measureCount} Originaltakten`);
    assert.ok(a.totalBars >= sg.measureCount, id);
  }
});

test('Solist bekommt einen Formteil als Solo (statt zusätzlicher Takte)', () => {
  const sg = demoSong('grace');
  const a = arrange(sg, { style: 'funk', solo: 2, seed: 1 });
  const solo = a.blocks.find((b) => b.type === 'solo');
  assert.ok(solo, 'Solo vorhanden');
  assert.ok(solo.segments.every((s) => s.roles[2] === 'solo'));
  assert.ok(a.blocks.some((b) => b.type === 'shout'));
});

test('Ausgeschriebene Form ohne Sprünge', () => {
  const a = arrange(song, { style: 'funk', form: 'full', seed: 1 });
  assert.equal(a.form.segnoBar, null);
});

test('Deterministisch pro Variante, unterschiedlich zwischen Varianten', () => {
  const sig = (a) => a.voices.map((v) => v.events.map((e) => e.start + ':' + e.pitches.join()).join(',')).join('|');
  assert.equal(sig(arrange(song, { seed: 5 })), sig(arrange(song, { seed: 5 })));
  assert.notEqual(sig(arrange(song, { seed: 5 })), sig(arrange(song, { seed: 6 })));
});

test('Posaunen-Glissando nur auf demselben Naturton (Zugphysik)', () => {
  const tb = INSTRUMENTS.trombone;
  assert.equal(slideGlissPossible(58, 53, tb), true, 'Bb3 -> F3 (Pos. 1 -> 6 auf dem 3. Teilton)');
  assert.equal(slideGlissPossible(46, 58, tb), false, 'Oktavsprung braucht Teiltonwechsel');
});

test('Bläser bekommen Atempausen', () => {
  const a = arrange(demoSong('ode'), { style: 'ballad', seed: 2 });
  const tuba = a.voices[3];
  const sec = 60 / a.tempo / 24;
  // gespielte Dauer (Stakkato-Noten klingen kurz, auch wenn sie länger notiert sind)
  let start = 0;
  let maxRun = 0;
  for (let i = 0; i < tuba.events.length; i++) {
    const e = tuba.events[i];
    const p = tuba.events[i - 1];
    if (!p || e.start - (p.start + (p.playDur ?? p.dur)) >= 6) start = e.start;
    maxRun = Math.max(maxRun, (e.start + (e.playDur ?? e.dur) - start) * sec);
  }
  assert.ok(maxRun <= tuba.inst.breath * 1.6, `längste Phrase ${maxRun.toFixed(1)} s`);
});

test('Eigener Tonumfang pro Stimme wird eingehalten (notierte Tonhöhe)', () => {
  // Trompete höchstens notiert G5 (=79), Sousaphon nicht unter klingend Es2 (=39)
  const a = arrange(song, { style: 'funk', seed: 1, drums: false, ranges: [{ lo: null, hi: 79 }, null, null, { lo: 39, hi: null }] });
  const trp = a.voices[0];
  for (const e of trp.events) for (const m of e.pitches) assert.ok(m + 2 <= 79, `Trompete zu hoch: notiert ${m + 2}`);
  for (const e of a.voices[3].events) for (const m of e.pitches) assert.ok(m >= 39, `Sousaphon zu tief: ${m}`);
});

test('Schwierigkeit: Stufe 1 ohne 16tel & Effekte, Stufe pro Stimme', () => {
  const a = arrange(song, { style: 'funk', seed: 2, difficulty: 1, voiceDifficulty: [null, null, null, 5] });
  for (let v = 0; v < 3; v++) {
    for (const e of a.voices[v].events) {
      assert.equal(e.start % 12, 0, `Stimme ${v + 1}: nur Achtelraster`);
      assert.ok(!e.fx.some((f) => ['falloff', 'glissStart', 'doit', 'scoop'].includes(f)), 'keine Effekte');
    }
  }
  assert.deepEqual(a.levels, [1, 1, 1, 5]);
  const easyHi = Math.max(...a.voices[0].events.flatMap((e) => e.pitches));
  const pro = arrange(song, { style: 'funk', seed: 2, difficulty: 5 });
  assert.ok(easyHi <= Math.max(...pro.voices[0].events.flatMap((e) => e.pitches)), 'leichte Stufe nicht höher als Profi');
});

test('Solo-Noten (Play-along): gleiche Länge, gleiche Töne & Rhythmen wie die Vorlage', () => {
  const grace = demoSong('grace');
  const t = arrange(grace, { ensemble: 'solo', playback: true, soloInstrument: 'altoSax', seed: 1, style: 'funk' });
  assert.equal(t.voices.length, 1);
  assert.equal(t.drums, null);
  const lead = grace.pickup > 0 ? 1 : 0;
  assert.equal(t.totalBars, grace.measureCount + lead, 'exakt so viele Takte wie die Datei');
  // jede Melodienote an derselben Stelle, gleiche Tonhöhenklasse, eine einzige Oktavlage
  const off = lead * t.mt;
  const ev = t.voices[0].events;
  const shifts = new Set();
  for (const n of grace.melody) {
    const e = ev.find((x) => x.start === n.start + off);
    assert.ok(e, `Note bei ${n.start} vorhanden`);
    shifts.add(e.pitches[0] - n.midi);
  }
  assert.equal(shifts.size, 1);
  assert.equal([...shifts][0] % 12, 0);
  assert.equal(ev.length, grace.melody.length, 'keine zusätzlichen Töne');
  // Schlagzeug ohne Drum-Spur: Groove über exakt dieselben Takte
  const d = arrange(grace, { ensemble: 'solo', playback: true, soloInstrument: 'drums', seed: 1 });
  assert.equal(d.voices.length, 0);
  assert.equal(d.totalBars, grace.measureCount + lead);
  assert.ok(d.drums.events.length > 100);
  assert.ok(d.drums.events.every((e) => e.start < d.totalBars * d.mt));
});

test('Schlagzeug-Play-along: Drum-Spur 1:1, Fills nur im Groove ergänzt', () => {
  const sg = demoSong('ode');
  const mt = 96;
  const drumNotes = [];
  for (let bar = 0; bar < sg.measureCount; bar++) {
    for (let k = 0; k < 8; k++) drumNotes.push({ start: bar * mt + k * 12, dur: 6, midi: 42, vel: 80 });
    drumNotes.push({ start: bar * mt, dur: 6, midi: 36, vel: 100 }, { start: bar * mt + 48, dur: 6, midi: 36, vel: 100 });
    drumNotes.push({ start: bar * mt + 24, dur: 6, midi: 38, vel: 100 }, { start: bar * mt + 72, dur: 6, midi: 38, vel: 100 });
    drumNotes.push({ start: bar * mt + 30, dur: 6, midi: 60, vel: 100 }); // Bongo -> wird nicht notiert
  }
  const song = { ...sg, pickup: 0, melody: sg.melody.filter((n) => n.start >= 0), drumNotes, sections: [{ label: 'A', start: 0, length: 8 }, { label: 'B', start: 8, length: sg.measureCount - 8 }] };
  const plain = arrange(song, { ensemble: 'solo', playback: true, soloInstrument: 'drums', drumFills: false });
  assert.equal(plain.totalBars, song.measureCount);
  const kit = drumNotes.filter((n) => n.midi !== 60);
  assert.equal(plain.drums.events.length, kit.length, '1:1 übernommen');
  for (const n of kit) assert.ok(plain.drums.events.some((e) => e.start === n.start && e.pitches[0] === n.midi));
  const filled = arrange(song, { ensemble: 'solo', playback: true, soloInstrument: 'drums' });
  assert.equal(filled.totalBars, song.measureCount);
  const fillBar = 7; // Ende von Teil A
  const toms = filled.drums.events.filter((e) => e.start >= fillBar * mt && e.start < (fillBar + 1) * mt && [48, 45, 41].includes(e.pitches[0]));
  assert.ok(toms.length >= 1, 'Fill am Formteil-Ende');
  // Füße laufen im Fill weiter (gleicher Groove)
  assert.ok(filled.drums.events.some((e) => e.start === fillBar * mt + 48 && e.pitches[0] === 36));
  // Raster des Grooves (Achtel) bleibt erhalten
  for (const e of filled.drums.events) assert.equal(e.start % 6, 0);
  assert.ok(filled.drums.events.some((e) => e.start === 8 * mt && e.pitches[0] === 49), 'Crash nach dem Fill');
  // außerhalb der Fill-Takte unverändert
  const sig = (a, bar) => a.drums.events.filter((e) => e.start >= bar * mt && e.start < (bar + 1) * mt).map((e) => `${e.start}:${e.pitches[0]}`).sort().join();
  assert.equal(sig(filled, 3), sig(plain, 3));
});

test('Solo-Noten Posaune: spielt taktgenau die Hauptmelodie von „When the Saints“', () => {
  const s = demoSong('saints');
  const a = arrange(s, { ensemble: 'solo', soloInstrument: 'trombone', style: 'funk', seed: 1 });
  assert.equal(a.voices.length, 1);
  const v = a.voices[0];
  const tb = v.inst;
  const mt = a.mt;
  // keine Improvisation, keine Begleitfiguren
  assert.ok(!a.blocks.some((b) => b.type === 'solo'));
  assert.ok(v.events.every((e) => e.role === 'melody'));
  const shifts = new Set();
  const themeBlocks = a.blocks.filter((b) => b.source);
  assert.equal(themeBlocks.length, s.sections.length, 'jeder Formteil des Songs kommt vor');
  for (const b of themeBlocks) {
    const sec = b.source;
    assert.equal(b.measures, sec.length, 'gleiche Taktzahl je Formteil');
    const a0 = sec.start * mt;
    const a1 = a0 + sec.length * mt;
    const mel = s.melody.filter((n) => n.start >= a0 && n.start < a1);
    // jede Melodienote steht im entsprechenden Takt auf derselben Zählzeit
    for (const n of mel) {
      const t = b.startBar * mt + (n.start - a0);
      const e = v.events.find((x) => x.start === t);
      assert.ok(e, `Takt ${Math.floor(n.start / mt) + 1}: Melodienote fehlt`);
      const d = e.pitches[0] - (n.midi + a.transposeShift);
      assert.equal(((d % 12) + 12) % 12, 0, 'gleiche Tonhöhe (oktaviert)');
      shifts.add(d);
    }
    // keine fremden Töne im Formteil
    const inBlock = v.events.filter((x) => x.start >= b.startBar * mt && x.start < (b.startBar + b.measures) * mt);
    const melStarts = new Set(mel.map((n) => b.startBar * mt + (n.start - a0)));
    for (const x of inBlock) assert.ok(melStarts.has(x.start), `fremder Ton bei ${x.start}`);
  }
  assert.ok(shifts.size <= 2, 'eine Oktavlage (höchstens Höhepunkt eine Oktave höher)');
  // spielbar: alles im Tonumfang, Kern im bequemen Bereich
  const ps = v.events.map((e) => e.pitches[0]);
  assert.ok(ps.every((m) => m >= tb.range[0] && m <= tb.range[1]));
  assert.ok(ps.filter((m) => m >= tb.comfort[0] && m <= tb.comfort[1]).length / ps.length >= 0.9);
  // Posaunen-Glissandi nur, wo der Zug es erlaubt
  const evs = v.events;
  for (let i = 0; i < evs.length - 1; i++) if (evs[i].fx.includes('glissStart')) assert.ok(slideGlissPossible(evs[i].pitches[0], evs[i + 1].pitches[0], tb));
  // Schlagzeug-Solo: Drum-Chart ohne Drum-Solo-Block
  const d = arrange(s, { ensemble: 'solo', soloInstrument: 'drums', seed: 1 });
  assert.ok(d.drums.events.length > 50);
  assert.ok(!d.blocks.some((b) => /Drum-Solo/.test(b.name)));
});

test('Solo mit Playback: Posaune spielt die Hauptmelodie 1:1', () => {
  const s = demoSong('saints');
  const a = arrange(s, { ensemble: 'solo', playback: true, soloInstrument: 'trombone', seed: 1 });
  const off = a.sourceOffset;
  for (const n of s.melody) {
    const e = a.voices[0].events.find((x) => x.start === n.start + off);
    assert.ok(e);
    assert.equal((((e.pitches[0] - n.midi) % 12) + 12) % 12, 0);
  }
});

test('Playback mit mehreren Originalstimmen: jede Spur 1:1 auf dem gewählten Instrument', () => {
  const sg = demoSong('ode');
  const bass = sg.chords.map((c) => ({ start: c.start, dur: c.dur, midi: 36 + c.chord.rootPc, vel: 90 }));
  const pad = sg.chords.flatMap((c) => c.chord.tones.map((t) => ({ start: c.start, dur: c.dur, midi: 60 + t.pc, vel: 70 })));
  const song = { ...sg, source: 'midi', tracks: [{ id: 't0', name: 'Gesang', program: 0, mel: true, notes: sg.melody }, { id: 't1', name: 'Bass', program: 33, notes: bass }, { id: 't2', name: 'Keys', program: 4, notes: pad }], drumNotes: [] };
  const a = arrange(song, { ensemble: 'solo', playback: true, playParts: [{ source: 'melody', inst: 'trumpet' }, { source: 't1', inst: 'tuba' }, { source: 't2', inst: 'altoSax' }, { source: 'drums', inst: 'drums' }] });
  assert.equal(a.voices.length, 3);
  assert.ok(a.drums, 'Schlagzeug (Stil-Groove, da die Vorlage keins hat)');
  assert.equal(a.totalBars, song.measureCount);
  // Bass: Grundtöne an denselben Stellen, Keys: oberster Ton
  for (const n of bass) assert.ok(a.voices[1].events.some((e) => e.start === n.start && (e.pitches[0] - n.midi) % 12 === 0));
  const top = (c) => Math.max(...c.chord.tones.map((t) => 60 + t.pc));
  for (const c of sg.chords) assert.ok(a.voices[2].events.some((e) => e.start === c.start && (e.pitches[0] - top(c)) % 12 === 0));
  // Original-Kanäle: übernommene Stimmen einzeln, Rest als Band
  const keys = a.backing.channels.map((c) => c.key);
  assert.deepEqual(keys, ['orig:melody', 'orig:t1', 'orig:t2']);
  // MusicXML: alle Stimmen + Schlagzeug, gültige Takte
  const xml = exportMusicXML(a, { mode: 'score' });
  assert.equal((xml.match(/<score-part /g) || []).length, 4);
});

test('Quartett: Mittelstimmen in Gegenbewegung zum Bass (fällt der Bass, steigen sie)', () => {
  const tot = { contrary: 0, oblique: 0, similar: 0 };
  for (const id of ['saints', 'ode', 'grace'])
    for (const style of ['funk', 'swing', 'ballad', 'classical', 'polka'])
      for (const seed of [1, 2]) {
        const a = arrange(demoSong(id), { style, seed });
        for (const k in tot) tot[k] += a.motion[k];
      }
  const n = tot.contrary + tot.oblique + tot.similar;
  assert.ok(n > 100, 'genug Bassbewegungen geprüft');
  assert.ok(tot.similar / n <= 0.05, `Parallelbewegung mit dem Bass: ${tot.similar}/${n}`);
  assert.ok(tot.contrary > 5 * tot.similar, `Gegenbewegung ${tot.contrary} vs. parallel ${tot.similar}`);
});

test('Quartett: Wiedererkennung – Solo beginnt mit der Melodie, Backgrounds zitieren den Hook', () => {
  const s = demoSong('grace');
  const a = arrange(s, { style: 'funk', solo: 0, seed: 1, form: 'full' });
  const sb = a.blocks.find((b) => b.type === 'solo');
  assert.ok(sb && sb.paraphrase, 'Solo ersetzt einen Formteil mit Melodie');
  const sv = sb.segments[0].roles.indexOf('solo');
  const t0 = sb.startBar * a.mt;
  const half = Math.floor(sb.measures / 2) * a.mt;
  const mel = sb.paraphrase.filter((n) => n.start < half - a.beat);
  const solo = a.voices[sv].events;
  const hit = mel.filter((n) => solo.some((e) => e.start === t0 + n.start && (((e.pitches[0] - n.midi) % 12) + 12) % 12 === 0)).length;
  assert.ok(hit / mel.length >= 0.7, `Melodie im Solo angespielt: ${hit}/${mel.length}`);
  // Background-Riffs im Rhythmus des ersten Melodietakts
  const motif = s.melody.filter((n) => n.start >= 0 && n.start < a.mt).map((n) => n.start);
  const riffs = a.voices.flatMap((v) => v.events.filter((e) => e.hookRiff));
  assert.ok(riffs.length > 0, 'Hook-Riffs vorhanden');
  assert.ok(riffs.every((e) => motif.includes(e.start % a.mt)), 'Riff-Rhythmus = Hook-Rhythmus');
});

test('Schwierigkeit verändert die Noten: Profi mit Läufen & Verzierungen, Originaltöne bleiben (auch Playback)', () => {
  const s = demoSong('saints');
  for (const playback of [false, true]) {
    const mk = (difficulty) => arrange(s, { ensemble: 'solo', soloInstrument: 'trumpet', style: 'funk', difficulty, playback, seed: 1 });
    const mid = mk(3);
    const adv = mk(4);
    const pro = mk(5);
    const n = (a) => a.voices[0].events.length;
    assert.ok(n(adv) > n(mid) || n(adv) > mk('auto').voices[0].events.length, 'Fortgeschritten hat mehr Töne');
    assert.ok(n(pro) >= n(mid) * 1.4, `Profi deutlich mehr Töne (${n(pro)} vs ${n(mid)})`);
    assert.ok(pro.voices[0].events.some((e) => e.embellish && e.dur === 6), 'Profi: 16tel-Läufe');
    assert.equal(pro.totalBars, mid.totalBars, 'Länge bleibt gleich');
    // jeder Melodieton steht weiterhin an seinem Platz
    const off = playback ? pro.sourceOffset : null;
    if (playback) for (const m of s.melody) assert.ok(pro.voices[0].events.some((e) => e.start === m.start + off && (((e.pitches[0] - m.midi) % 12) + 12) % 12 === 0));
    const inst = pro.voices[0].inst;
    assert.ok(pro.voices[0].events.every((e) => e.pitches[0] >= inst.range[0] && e.pitches[0] <= inst.range[1]));
  }
});
