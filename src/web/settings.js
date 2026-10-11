// NoteCode – Einstellungen (lokal gespeichert, bei Anmeldung mit der Cloud synchronisiert).
import { effortOf, effortFromLegacy } from '../core/effort.js';

export const DEFAULT_SETTINGS = {
  defaultVoices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'], // 2–8 Stimmen
  defaultStyle: 'funk',
  defaultDrums: false,
  defaultSolo: 0,
  defaultLength: 'normal',
  defaultAdapt: 1,
  defaultDifficulty: 'auto', // 'auto' | 1..5
  form: 'compact', // compact = Wiederholungen & D.S. al Coda, full = ausgeschrieben
  paper: 'A4',
  notesZoom: 1,
  concertScore: false,
  chords: 'solo', // solo | all | none
  tenorClef: false, // Tenorschlüssel für hohe Posaunen-/Cello-/Fagott-Lagen
  transposeAuto: true,
  theme: 'light', // light | auto
  autoSave: true,
  effort: 3, // Aufwand 1–5: Schnell … Ultra (mehr Zeit = bessere Noten)
  folders: [], // eigene Ordner der Bibliothek: { id, name, createdAt, updatedAt, deleted? }
  supabaseUrl: '',
  supabaseKey: '',
  assistantKey: '', // optional: eigener Schlüssel für den KI-Assistenten beim Überarbeiten (nur lokal)
};

export async function loadSettings(local) {
  const cfg = (typeof window !== 'undefined' && window.NOTECODE_CONFIG) || {};
  const saved = (await local.getKV('settings')) || {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  // ältere Einstellung „Genauigkeit“ (quality) -> Aufwand-Stufe
  if (saved.effort === undefined && saved.quality) s.effort = effortFromLegacy(saved.quality);
  s.effort = effortOf(s.effort).level;
  if (!s.supabaseUrl && cfg.supabaseUrl) s.supabaseUrl = cfg.supabaseUrl;
  if (!s.supabaseKey && cfg.supabaseKey) s.supabaseKey = cfg.supabaseKey;
  return s;
}

export async function saveSettings(local, s, cloud = null) {
  await local.setKV('settings', s);
  if (cloud && cloud.user) {
    // Zugangsdaten nicht in die Cloud schreiben
    const { supabaseUrl, supabaseKey, assistantKey, ...shared } = s;
    void supabaseUrl;
    void supabaseKey;
    void assistantKey;
    try {
      await cloud.saveSettings(shared);
    } catch {
      /* offline */
    }
  }
}
