// Gedruckte Taktfolge: Wiederholungen (|: :| 2x), Segno, To Coda, D.S. al Coda, Coda.
// Die Wiedergabe nutzt die ausgeschriebene Zeitleiste; der Notensatz nur die
// gedruckten Takte (jeweils mit Verweis "src" auf den Zeitleisten-Takt).
export function printedMeasures(arr) {
  const total = arr.totalBars;
  const form = arr.form || { repeats: [] };
  const out = [];
  let bar = 0;
  const repeats = [...(form.repeats || [])].sort((a, b) => a.start - b.start);
  while (bar < total) {
    if (form.skip && bar === form.skip.from && form.skip.to > form.skip.from) {
      bar = form.skip.to;
      continue;
    }
    const rep = repeats.find((r) => r.start === bar);
    if (rep) {
      for (let k = 0; k < rep.len; k++) out.push({ src: bar + k, startRepeat: k === 0, endRepeat: k === rep.len - 1 ? rep.times : 0, repeatTimes: rep.times });
      bar += rep.len * rep.times;
      continue;
    }
    out.push({ src: bar });
    bar++;
  }
  for (const m of out) {
    if (form.segnoBar !== null && m.src === form.segnoBar) m.segno = true;
    if (form.toCodaBar !== null && m.src === form.toCodaBar && form.skip) m.toCoda = true;
    if (form.dsBar !== null && m.src === form.dsBar && form.skip) m.dalSegno = true;
    if (form.codaBar !== null && m.src === form.codaBar && form.skip) m.coda = true;
  }
  out.forEach((m, i) => (m.number = i + 1));
  return out;
}

// Wiedergabe-Reihenfolge aus der gedruckten Form (zur Kontrolle/Tests)
export function playbackOrder(printed) {
  const order = [];
  let i = 0;
  let dsDone = false;
  let inDsRange = false; // zwischen Segno und To Coda nach dem Rücksprung: ohne Wiederholungen
  let guard = 0;
  let repStart = 0;
  let repCount = 1;
  while (i < printed.length && guard++ < 100000) {
    const m = printed[i];
    if (m.startRepeat && repCount === 1) repStart = i;
    order.push(m.src);
    if (m.endRepeat && repCount < m.endRepeat && !inDsRange) {
      repCount++;
      i = repStart;
      continue;
    }
    if (m.endRepeat) repCount = 1;
    if (inDsRange && m.toCoda) {
      inDsRange = false;
      i = printed.findIndex((x) => x.coda);
      continue;
    }
    if (m.dalSegno && !dsDone) {
      dsDone = true;
      inDsRange = true;
      i = printed.findIndex((x) => x.segno);
      continue;
    }
    i++;
  }
  return order;
}

// Zeitleisten-Takt -> Index des gedruckten Takts (für Mitlese-Markierung & Klick-Sprung)
export function timelineToPrinted(arr, printed = printedMeasures(arr)) {
  const map = new Map();
  printed.forEach((pm, i) => {
    if (!map.has(pm.src)) map.set(pm.src, i);
  });
  // D.S.-Kopien auf die Originaltakte abbilden
  for (const b of arr.blocks) {
    if (b.copyOf === undefined) continue;
    const src = arr.blocks[b.copyOf];
    for (let k = 0; k < b.measures; k++) if (map.has(src.startBar + k)) map.set(b.startBar + k, map.get(src.startBar + k));
  }
  // Wiederholungen
  for (const r of arr.form?.repeats || []) {
    for (let pass = 1; pass < r.times; pass++) for (let k = 0; k < r.len; k++) if (map.has(r.start + k)) map.set(r.start + pass * r.len + k, map.get(r.start + k));
  }
  return (bar) => (map.has(bar) ? map.get(bar) : null);
}
