// Aufwand (wie der Schieberegler „Aufwand“ in Claude): fünf Stufen von „Schnell“ bis „Ultra“.
// Mehr Aufwand = mehr Zeit = bessere Noten. Gilt für die Analyse einer Aufnahme (KI-Durchgänge,
// Trennung von Gesang und Begleitung, Seitensignal) und für das Arrangieren (Varianten je
// Abschnitt und je Seed, Parametersuche, Nachbessern der schwächsten Stellen).
//
// Die Zeiten sind Obergrenzen (Budget): Die Arbeit endet früher, wenn nichts mehr besser wird.

export const EFFORT = [
  {
    level: 1,
    id: 'fast',
    name: 'Schnell',
    short: 'Schnell',
    time: 'wenige Sekunden',
    text: 'Ein KI-Durchgang, eine Fassung. Am schnellsten, aber am ungenauesten.',
    analysis: { passes: 1, hpss: false, side: false, shifts: 0, budgetMs: 0 },
    arrange: { seeds: 1, search: 1, budgetMs: 0, sweep: false, polish: 0 },
  },
  {
    level: 2,
    id: 'balanced',
    name: 'Ausgewogen',
    short: 'Ausgewogen',
    time: 'etwa 1–2 Minuten',
    text: 'Zwei KI-Ansichten (Original und ohne Schlagzeug), wenige Varianten.',
    analysis: { passes: 2, hpss: true, side: false, shifts: 0, budgetMs: 90000 },
    arrange: { seeds: 4, search: 3, budgetMs: 8000, sweep: false, polish: 0 },
  },
  {
    level: 3,
    id: 'thorough',
    name: 'Gründlich',
    short: 'Gründlich',
    time: 'etwa 3–6 Minuten',
    text: 'Mehrere KI-Durchgänge mit verschobenen Fenstern, Seitensignal, viele Varianten.',
    analysis: { passes: 4, hpss: true, side: true, shifts: 0, budgetMs: 4 * 60000 },
    arrange: { seeds: 10, search: 6, budgetMs: 25000, sweep: false, polish: 1 },
  },
  {
    level: 4,
    id: 'deep',
    name: 'Sehr gründlich',
    short: 'Sehr gründlich',
    time: 'etwa 10–15 Minuten',
    text: 'Acht KI-Durchgänge, Parametersuche, Nachbessern der schwächsten Stellen.',
    analysis: { passes: 8, hpss: true, side: true, shifts: 0, budgetMs: 9 * 60000 },
    arrange: { seeds: 24, search: 10, budgetMs: 2 * 60000, sweep: true, polish: 4 },
  },
  {
    level: 5,
    id: 'ultra',
    name: 'Ultra',
    short: 'Ultra',
    time: 'bis zu 30 Minuten',
    text: 'Alles, was möglich ist: viele KI-Durchgänge, große Variantensuche, wiederholtes Nachbessern.',
    analysis: { passes: 12, hpss: true, side: true, shifts: 0, budgetMs: 16 * 60000 },
    arrange: { seeds: 60, search: 16, budgetMs: 12 * 60000, sweep: true, polish: 12 },
  },
];

export const DEFAULT_EFFORT = 3;

export function effortOf(level) {
  const n = Math.round(Number(level));
  return EFFORT[Math.max(1, Math.min(5, Number.isFinite(n) ? n : DEFAULT_EFFORT)) - 1];
}

// ältere Einstellung quality: 'thorough' | 'fast' -> Stufe
export function effortFromLegacy(q) {
  return q === 'fast' ? 1 : DEFAULT_EFFORT;
}
