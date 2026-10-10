// Wiederholungen (|: :| mit 1./2. Klammer) ausschreiben.
// measures: [{startRepeat, endRepeat, ending}] -> Liste von Takt-Indizes
export function expandOrder(measures) {
  const out = [];
  let repeatStart = 0;
  let pass = 1;
  let i = 0;
  let guard = 0;
  while (i < measures.length && guard++ < 20000) {
    const m = measures[i];
    if (m.startRepeat && pass === 1) repeatStart = i;
    if (m.ending && !endingMatches(m.ending, pass)) {
      i++;
      continue;
    }
    out.push(i);
    if (m.endRepeat) {
      const times = m.repeatTimes || 2;
      if (pass < times) {
        pass++;
        i = repeatStart;
        continue;
      }
      pass = 1;
      repeatStart = i + 1;
    }
    i++;
  }
  return out;
}

function endingMatches(ending, pass) {
  if (Array.isArray(ending)) return ending.includes(pass);
  return ending === pass;
}
