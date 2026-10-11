// Stil-Bibliothek (datengetrieben).
// Rhythmus-Strings: ein Zeichen = 1 Sechzehntel.
//   'X' Akzent, 'x' Anschlag, 'o' kurz/staccato (bzw. Ghost-Note beim Schlagzeug),
//   '-' Ton weiterklingen lassen, '.' Pause.
// Bass-Riffs: [step, länge(16tel), token, artikulation]
//   token: R Grundton, R8 Oktave darüber, 5 Quinte darüber, 5- Quinte darunter,
//          3 Terz, b7 kleine Septime (bzw. Septime des Akkords), 6 Sexte,
//          A chromatischer Annäherungston (Halbton unter dem nächsten Grundton),
//          Ab (Halbton darüber), S diatonischer Schritt zum nächsten Grundton.

export function parseRhythm(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === 'X' || c === 'x' || c === 'o') {
      let len = 1;
      while (str[i + len] === '-') len++;
      out.push({ step: i, len, accent: c === 'X', short: c === 'o' });
    }
  }
  return out;
}

export const STYLES = {
  funk: {
    id: 'funk',
    tempoRange: [84, 124],
    name: 'Brass Band Funk',
    feel: 'straight16',
    defaultTempo: 104,
    tempoText: 'Funky',
    sub: 6, // Grundraster für Läufe (16tel)
    soloOver: 'vamp',
    fxRate: 0.6,
    dyn: { intro: 'mf', theme: 'mf', interlude: 'f', solo: 'mp', shout: 'f', recap: 'mf', coda: 'ff', variation: 'mf' },
    bass: {
      kind: 'riff',
      riffs: [
        [[0, 3, 'R', 'acc'], [3, 1, 'R', 'st'], [6, 2, 'R8', 'st'], [10, 1, '5', 'st'], [11, 1, 'b7', ''], [12, 2, 'R8', 'acc'], [14, 2, 'A', '']],
        [[0, 2, 'R', 'acc'], [3, 1, 'R', 'st'], [4, 2, '5-', 'st'], [7, 1, 'R', ''], [8, 2, 'b7', 'st'], [10, 2, 'R8', 'acc'], [14, 1, '5', 'st'], [15, 1, 'A', '']],
        [[0, 2, 'R', 'acc'], [2, 2, 'R', 'st'], [6, 1, 'R8', 'st'], [7, 3, '5', ''], [10, 2, 'b7', 'st'], [12, 1, 'R', 'st'], [13, 1, 'R', ''], [14, 2, 'A', '']],
      ],
      riffsSlow: [
        [[0, 3, 'R', 'acc'], [3, 1, 'R', 'st'], [6, 2, 'R8', 'st'], [8, 1, '5', 'st'], [10, 2, 'b7', ''], [13, 1, 'R8', 'st'], [14, 2, 'A', '']],
      ],
      riffsFast: [
        [[0, 4, 'R', 'acc'], [6, 2, 'R', 'st'], [8, 2, '5', 'st'], [10, 2, 'b7', ''], [12, 2, 'R8', 'acc'], [14, 2, 'A', 'st']],
        [[0, 2, 'R', 'acc'], [4, 2, '5-', 'st'], [6, 2, 'R', ''], [10, 2, 'R8', 'acc'], [12, 2, 'b7', 'st'], [14, 2, 'A', '']],
      ],
    },
    comp: {
      // Achtelraster = gut lesbar; die 16tel-Synkopen übernimmt der Bass
      4: ['..X-..o...X-..o.', 'X-....o.o.....o.', '..X-....X-..X-..', '..o.X-....o.X-..', 'o.....X-..o...X-'],
      pads: ['X---------------', 'X-------X-------'],
      riffs: ['x.x...X-..x.x.X-', 'X-..x...X-..x.o.', '..x.x.X-..x.x.X-'],
    },
    drums: {
      4: { hh: 'x.x.x.x.x.x.x.x.', sn: '....X..o.o..X..o', bd: 'X.....x...X..x..' },
      4.1: { hh: 'xxxxxxxxxxxxxxxx', sn: '....X..o.o..X...', bd: 'X..x..x...X.....' },
    },
  },
  secondline: {
    id: 'secondline',
    tempoRange: [96, 132],
    name: 'New Orleans Second Line',
    feel: 'straight16',
    defaultTempo: 112,
    tempoText: 'Second Line',
    sub: 6,
    soloOver: 'vamp',
    fxRate: 0.65,
    dyn: { intro: 'f', theme: 'mf', interlude: 'f', solo: 'mp', shout: 'f', recap: 'mf', coda: 'ff', variation: 'mf' },
    bass: {
      kind: 'riff',
      riffs: [
        [[0, 4, 'R', 'acc'], [6, 2, '5-', ''], [8, 2, 'R', 'st'], [10, 2, '3', ''], [12, 2, '5', 'acc'], [14, 2, 'A', '']],
        [[0, 3, 'R', 'acc'], [3, 3, 'R', ''], [6, 2, '5', ''], [10, 2, 'R8', 'st'], [12, 2, 'b7', ''], [14, 2, 'A', '']],
      ],
      riffsFast: [[[0, 4, 'R', 'acc'], [6, 2, '5-', ''], [8, 4, 'R', 'st'], [12, 2, '5', 'acc'], [14, 2, 'A', '']]],
    },
    comp: {
      4: ['..X-....X-..o...', 'X-..o.....X-..o.', '....X-......X-..'],
      pads: ['X---------------', 'X-------X-------'],
      riffs: ['x.x.X-..x.x.X-..', 'X-.x..X-..x.X-..'],
    },
    drums: {
      4: { sn: 'x.oXo.o.x.oXo.oo', bd: 'X..x..x.X.......', ride: 'x...x...x...x...' },
    },
  },
  swing: {
    id: 'swing',
    tempoRange: [96, 240],
    name: 'Jazz / Swing',
    feel: 'swing8',
    defaultTempo: 132,
    tempoText: 'Swing',
    sub: 12,
    soloOver: 'changes',
    fxRate: 0.5,
    dyn: { intro: 'mf', theme: 'mf', interlude: 'mf', solo: 'mp', shout: 'f', recap: 'mf', coda: 'f', variation: 'mf' },
    bass: { kind: 'walk' },
    comp: {
      4: ['X-----x-........', '....X-......x-..', '..x-....x-......', 'X-.......x------'],
      pads: ['X---------------', 'X-------X-------'],
      riffs: ['X-.x..X-....x-..', '..x-x-..X-......', 'x.x.X-..x.x.X-..'],
    },
    drums: {
      4: { ride: 'x...x.x.x...x.x.', hhPedal: '....x.......x...', bd: 'o...o...o...o...', sn: '..........o.....' },
    },
  },
  ballad: {
    id: 'ballad',
    tempoRange: [54, 84],
    name: 'Pop-Ballade',
    feel: 'straight8',
    defaultTempo: 72,
    tempoText: 'Ballad',
    sub: 12,
    soloOver: 'changes',
    fxRate: 0.2,
    modulateFinal: 1,
    dyn: { intro: 'p', theme: 'mp', interlude: 'mp', solo: 'mp', shout: 'f', recap: 'mf', coda: 'p', variation: 'mf' },
    bass: { kind: 'ballad' },
    comp: {
      4: ['X-------X-------', 'X-----x-X-------', 'X---------------', 'X-------x---x---'],
      pads: ['X---------------'],
      riffs: ['X-----x-X-----x-'],
    },
    drums: {
      4: { hh: 'x.x.x.x.x.x.x.x.', rim: '....x.......x...', bd: 'x.......x.x.....' },
    },
  },
  classical: {
    id: 'classical',
    tempoRange: [56, 152],
    name: 'Klassischer Satz',
    feel: 'straight8',
    defaultTempo: 96,
    tempoText: 'Moderato',
    sub: 12,
    soloOver: 'changes',
    fxRate: 0.15,
    strict: true, // strenge Stimmführung (keine Quint-/Oktavparallelen in allen Stimmpaaren)
    dyn: { intro: 'mf', theme: 'mf', interlude: 'mp', solo: 'mf', shout: 'f', recap: 'f', coda: 'f', variation: 'mp' },
    bass: { kind: 'classical' },
    comp: {
      4: ['X-------X-------', 'X---X---X---X---', 'X-------X---X---'],
      pads: ['X---------------', 'X-------X-------'],
      riffs: ['X---X---X---X---'],
    },
    drums: {
      4: { bd: 'x.......x.......', ride: 'x...x...x...x...' },
    },
  },
  polka: {
    id: 'polka',
    tempoRange: [96, 144],
    name: 'Polka / Marsch (Blasmusik)',
    feel: 'straight8',
    defaultTempo: 120,
    tempoText: 'Polka',
    sub: 12,
    soloOver: 'changes',
    fxRate: 0.15,
    modulateTrio: 5,
    dyn: { intro: 'f', theme: 'mf', interlude: 'f', solo: 'mf', shout: 'f', recap: 'f', coda: 'ff', variation: 'mp' },
    bass: { kind: 'oompah' },
    comp: {
      4: ['..x-..x-..x-..x-', '..x-..x-..x-..x-', '..o...o...o...o.'],
      2: ['..x-..x-'],
      3: ['....x-..x-..'],
      pads: ['X-------X-------'],
      riffs: ['..x-..x-..x-..x-'],
    },
    drums: {
      4: { bd: 'x.......x.......', sn: '..x...x...x...x.', hh: '..x...x...x...x.' },
      2: { bd: 'x...x...', sn: '..x...x.', hh: '..x...x.' },
      3: { bd: 'x...........', sn: '....x...x...', hh: '....x...x...' },
    },
  },
};

// ---- Weitere Stile ---------------------------------------------------------
// Jeder ist eine Spielart eines Grundstils (id = Grundstil: Satztechnik, Artikulation, Solo-
// Sprache), mit eigenem Namen, Tempobereich, Bass-, Begleit- und Schlagzeug-Mustern.
// key = Kennung für Auswahl & Speichern.
for (const [k, st] of Object.entries(STYLES)) st.key = k;
const variant = (base, key, over) => (STYLES[key] = { ...STYLES[base], modulateFinal: 0, modulateTrio: 0, ...over, id: base, key });

variant('ballad', 'pop', {
  name: 'Pop',
  tempoRange: [72, 138],
  defaultTempo: 104,
  heading: 'Pop',
  hint: 'Straight 8ths',
  fxRate: 0.25,
  dyn: { intro: 'mp', theme: 'mf', interlude: 'mf', solo: 'mf', shout: 'f', recap: 'mf', coda: 'f', variation: 'mf' },
  bass: {
    kind: 'riff',
    riffs: [
      [[0, 6, 'R', ''], [6, 2, 'R', ''], [8, 4, '5', ''], [12, 2, 'R', ''], [14, 2, 'S', '']],
      [[0, 2, 'R', ''], [2, 2, 'R', ''], [4, 2, 'R', ''], [6, 2, 'R', ''], [8, 2, 'R', ''], [10, 2, 'R', ''], [12, 2, 'R', ''], [14, 2, 'S', '']],
      [[0, 4, 'R', ''], [4, 2, 'R', ''], [6, 2, '5', ''], [8, 4, 'R8', ''], [12, 4, '5', '']],
    ],
  },
  comp: {
    4: ['X-------X-------', 'X-----x-X-------', 'X---x---X---x---', 'X-----X---X-----'],
    pads: ['X---------------', 'X-------X-------'],
    riffs: ['X-----x-X-----x-'],
  },
  drums: { 4: { hh: 'x.x.x.x.x.x.x.x.', sn: '....X.......X...', bd: 'X.....x.X.......' } },
});

variant('funk', 'rock', {
  name: 'Rock',
  feel: 'straight8',
  tempoRange: [100, 190],
  defaultTempo: 132,
  heading: 'Rock',
  hint: 'Driving 8ths',
  sub: 12,
  fxRate: 0.35,
  dyn: { intro: 'f', theme: 'mf', interlude: 'f', solo: 'mf', shout: 'ff', recap: 'f', coda: 'ff', variation: 'mf' },
  bass: {
    kind: 'riff',
    riffs: [
      [[0, 2, 'R', 'acc'], [2, 2, 'R', ''], [4, 2, 'R', ''], [6, 2, 'R', ''], [8, 2, 'R', 'acc'], [10, 2, 'R', ''], [12, 2, 'R', ''], [14, 2, 'A', '']],
      [[0, 2, 'R', 'acc'], [2, 2, 'R', ''], [4, 2, 'R8', ''], [6, 2, 'R', ''], [8, 2, 'R', 'acc'], [10, 2, 'R', ''], [12, 2, '5', ''], [14, 2, 'b7', '']],
    ],
  },
  comp: {
    4: ['X-..X-..X-..X-..', 'X-....X-X-......', 'X-X-..X-..X-X-..'],
    pads: ['X-------X-------'],
    riffs: ['X-X-..X-X-X-..X-'],
  },
  drums: { 4: { hh: 'x.x.x.x.x.x.x.x.', sn: '....X.......X...', bd: 'X.......X.x.....' } },
});

variant('funk', 'soul', {
  name: 'Soul / R&B',
  tempoRange: [76, 126],
  defaultTempo: 98,
  heading: 'Soul',
  hint: 'Laid back',
  fxRate: 0.45,
  bass: {
    kind: 'riff',
    riffs: [
      [[0, 3, 'R', 'acc'], [3, 1, 'R', ''], [4, 2, '5', ''], [8, 3, 'R', ''], [11, 1, '5', ''], [12, 2, '6', ''], [14, 2, 'A', '']],
      [[0, 4, 'R', 'acc'], [6, 2, '3', ''], [8, 2, '5', ''], [10, 2, '6', ''], [12, 2, 'R8', 'acc'], [14, 2, 'S', '']],
    ],
  },
  comp: {
    4: ['....X-......X-..', '....x.x.....X-..', '..x-X-....x-X-..'],
    pads: ['X---------------', 'X-------X-------'],
    riffs: ['x.x.X-..x.x.X-..'],
  },
  drums: { 4: { hh: 'x.x.x.x.x.x.x.x.', sn: '....X.......X...', bd: 'X.....x.x.X.....' } },
});

variant('secondline', 'latin', {
  name: 'Latin (Bossa / Samba)',
  feel: 'straight8',
  tempoRange: [88, 150],
  defaultTempo: 116,
  heading: 'Latin',
  hint: 'Straight 8ths',
  fxRate: 0.35,
  bass: {
    kind: 'riff',
    riffs: [
      [[0, 6, 'R', ''], [6, 2, '5', ''], [8, 6, '5', ''], [14, 2, 'R', '']],
      [[0, 3, 'R', 'acc'], [6, 2, '5', ''], [8, 2, '5', ''], [12, 2, 'R8', ''], [14, 2, 'S', '']],
    ],
  },
  comp: {
    4: ['X-..x-.x..x-..x-', '..x-..x-x...x-..', 'x-.x-.x-..x-.x-.'],
    pads: ['X---------------', 'X-------X-------'],
    riffs: ['x-.x-.x-x-.x-.x-'],
  },
  drums: { 4: { hh: 'x.x.x.x.x.x.x.x.', rim: 'x..x..x...x.x...', bd: 'x.....xxx.....xx' } },
});

variant('funk', 'reggae', {
  name: 'Reggae / Ska',
  feel: 'straight8',
  tempoRange: [60, 170],
  defaultTempo: 84,
  heading: 'Reggae',
  hint: 'Offbeats kurz',
  sub: 12,
  fxRate: 0.25,
  dyn: { intro: 'mf', theme: 'mf', interlude: 'mf', solo: 'mp', shout: 'f', recap: 'mf', coda: 'f', variation: 'mf' },
  bass: {
    kind: 'riff',
    riffs: [
      [[0, 2, 'R', ''], [4, 2, 'R', ''], [6, 2, '5', ''], [10, 2, '3', ''], [12, 4, 'R', '']],
      [[2, 2, 'R', ''], [4, 4, '5-', ''], [10, 2, 'R', ''], [12, 2, '3', ''], [14, 2, 'S', '']],
    ],
  },
  comp: {
    4: ['....o.......o...', '..o...o...o...o.', '....o.o.....o.o.'],
    pads: ['X---------------'],
    riffs: ['..o...o...o...o.'],
  },
  drums: { 4: { hh: 'x.x.x.x.x.x.x.x.', rim: '........x.......', bd: '........x.......' } },
});

variant('funk', 'disco', {
  name: 'Disco / Dance',
  feel: 'straight8',
  tempoRange: [106, 138],
  defaultTempo: 120,
  heading: 'Disco',
  hint: 'Four on the floor',
  sub: 12,
  fxRate: 0.4,
  bass: {
    kind: 'riff',
    riffs: [
      [[0, 2, 'R', 'st'], [2, 2, 'R8', 'st'], [4, 2, 'R', 'st'], [6, 2, 'R8', 'st'], [8, 2, 'R', 'st'], [10, 2, 'R8', 'st'], [12, 2, 'R', 'st'], [14, 2, 'R8', 'st']],
      [[0, 2, 'R', 'st'], [2, 2, 'R8', 'st'], [4, 2, 'R', 'st'], [6, 2, 'R8', 'st'], [8, 2, 'R', 'st'], [10, 2, 'R8', 'st'], [12, 2, '5', 'st'], [14, 2, 'A', '']],
    ],
  },
  comp: {
    4: ['..x-..x-..x-..x-', '..o...o...o.x-..', 'X-....x-..x-..x-'],
    pads: ['X---------------', 'X-------X-------'],
    riffs: ['..x-..x-..x-x-x-'],
  },
  drums: { 4: { hh: '..x...x...x...x.', sn: '....X.......X...', bd: 'X...X...X...X...' } },
});

variant('swing', 'blues', {
  name: 'Blues / Shuffle',
  tempoRange: [56, 150],
  defaultTempo: 96,
  heading: 'Shuffle',
  hint: 'Achtel triolisch',
  fxRate: 0.55,
});

variant('polka', 'march', {
  name: 'Marsch',
  tempoRange: [92, 132],
  defaultTempo: 112,
  heading: 'Tempo di Marcia',
  hint: null,
});

variant('polka', 'waltz', {
  name: 'Walzer',
  tempoRange: [84, 210],
  defaultTempo: 150,
  heading: 'Tempo di Valse',
  hint: null,
});

export const STYLE_LIST = Object.values(STYLES).map((s) => ({ id: s.key, name: s.name }));

export function getStyle(id) {
  return STYLES[id] || STYLES.funk;
}

// Anteil der Einsätze auf Sechzehntel-Zwischenzeiten (Melodie + Bass): hoch = Funk-/Soul-Gefühl
function sixteenthShare(song) {
  const notes = [...(song.melody || []), ...((song.tracks || []).find((t) => t.role === 'bass')?.notes || [])].filter((n) => n.start >= 0);
  if (notes.length < 16) return 0;
  return notes.filter((n) => n.start % 12 === 6).length / notes.length;
}

// Bass Drum auf allen vier Zählzeiten (Disco/Dance)?
function fourOnFloor(song) {
  const kicks = (song.drumNotes || []).filter((d) => d.midi === 36 || d.midi === 35);
  const bars = song.measureCount || 0;
  if (!bars || kicks.length < 2 * bars) return false;
  const mt = ((song.meter?.beats || 4) * 96) / (song.meter?.beatType || 4);
  const per = new Map();
  for (const k of kicks) if (k.start >= 0 && k.start % 24 === 0) per.set(Math.floor(k.start / mt), (per.get(Math.floor(k.start / mt)) || 0) + 1);
  return [...per.values()].filter((c) => c >= 4).length >= 0.6 * bars;
}

// Stil automatisch aus dem Song ableiten: Taktart, Tempo, Swing/Shuffle, Sechzehntel-Gefühl,
// Schlagzeug-Muster, Titel/Spurnamen – aus allen Stilen, nicht nur den Grundstilen
export function autoStyle(song) {
  const m = song.meter || { beats: 4, beatType: 4 };
  const tempo = song.tempo || 100;
  const names = (song.parts || song.tracks || []).map((p) => p.name || '').join(' ');
  const text = `${names} ${song.title || ''}`;
  const classicalNames = /(violin|viola|cello|violoncello|kontrabass|soprano|sopran|alto|tenor|bass\b|oboe|fagott|bassoon|horn in f|cembalo|organ|orgel)/i;
  const classicalCount = (song.parts || []).filter((p) => classicalNames.test(p.name || '')).length;
  if (classicalCount >= 3) return 'classical';
  if (/(composer|bach|mozart|beethoven|haydn|händel|handel|schubert|brahms|vivaldi)/i.test(song.composer || '')) return 'classical';
  // ausdrückliche Hinweise im Titel
  if (/(walzer|waltz|valse)/i.test(text) && m.beats === 3) return 'waltz';
  if (/\b(marsch|march|marcia)\b/i.test(text)) return 'march';
  if (/polka/i.test(text)) return 'polka';
  if (/(reggae|ska)/i.test(text)) return 'reggae';
  if (/(samba|bossa|salsa|latin|mambo|cha.?cha|rumba)/i.test(text)) return 'latin';
  if (/(blues|shuffle|boogie)/i.test(text)) return 'blues';
  if (/(swing|jazz)/i.test(text)) return 'swing';
  if (/(second line|new orleans)/i.test(text)) return 'secondline';
  if (song.swing) return tempo < 104 ? 'blues' : 'swing';
  if (m.beatType === 8 && m.beats % 3 === 0) return tempo < 90 ? 'ballad' : m.beats >= 12 ? 'blues' : 'polka';
  if (m.beats === 3) return tempo < 100 ? 'ballad' : tempo < 126 ? 'classical' : 'waltz';
  if (m.beats === 2) return tempo < 112 ? 'march' : 'polka';
  if (tempo < 74) return 'ballad';
  const s16 = sixteenthShare(song);
  if (tempo >= 106 && tempo <= 138 && fourOnFloor(song)) return 'disco';
  if (tempo < 92) return s16 >= 0.22 ? 'soul' : 'ballad';
  if (tempo <= 126) return s16 >= 0.3 ? 'funk' : s16 >= 0.18 ? 'soul' : 'pop';
  if (tempo <= 150) return s16 >= 0.25 ? 'funk' : 'pop';
  return 'rock';
}

// Muster auf die Taktlänge (in 16teln) zuschneiden/wiederholen
export function fitRhythmString(str, steps) {
  if (str.length === steps) return str;
  if (str.length > steps) return str.slice(0, steps);
  let s = str;
  while (s.length < steps) s += str;
  return s.slice(0, steps);
}

export function compPatterns(style, steps) {
  const c = style.comp;
  const key = steps === 8 ? 2 : steps === 12 ? 3 : 4;
  const list = c[key] || c[4];
  return list.map((p) => fitRhythmString(p, steps));
}

export function drumGroove(style, steps, variant = 0) {
  const d = style.drums;
  let g = null;
  if (steps === 8) g = d[2];
  else if (steps === 12) g = d[3] || { bd: 'x.....x.....', sn: '......x.....', hh: 'x.x.x.x.x.x.' };
  else if (steps === 16) g = variant && d[4.1] ? d[4.1] : d[4];
  if (!g) {
    // generischer Groove
    const s = Array(steps).fill('.');
    const bd = [...s];
    bd[0] = 'x';
    const sn = [...s];
    sn[Math.floor(steps / 2)] = 'x';
    const hh = s.map((_, i) => (i % 2 === 0 ? 'x' : '.'));
    g = { bd: bd.join(''), sn: sn.join(''), hh: hh.join('') };
  }
  const out = {};
  for (const [k, v] of Object.entries(g)) out[k] = fitRhythmString(v, steps);
  return out;
}
