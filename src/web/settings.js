// NoteCode – Einstellungen (lokal gespeichert, bei Anmeldung mit der Cloud synchronisiert).
export const DEFAULT_SETTINGS = {
  defaultVoices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'],
  defaultStyle: 'funk',
  defaultDrums: false,
  defaultSolo: 0,
  defaultLength: 'normal',
  defaultAdapt: 1,
  form: 'compact', // compact = Wiederholungen & D.S. al Coda, full = ausgeschrieben
  paper: 'A4',
  notesZoom: 1,
  concertScore: false,
  chords: 'solo', // solo | all | none
  tenorClef: false, // Tenorschlüssel für hohe Posaunen-/Cello-/Fagott-Lagen
  transposeAuto: true,
  theme: 'light', // light | auto
  autoSave: true,
  supabaseUrl: '',
  supabaseKey: '',
};

export async function loadSettings(local) {
  const cfg = (typeof window !== 'undefined' && window.NOTECODE_CONFIG) || {};
  const saved = (await local.getKV('settings')) || {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  if (!s.supabaseUrl && cfg.supabaseUrl) s.supabaseUrl = cfg.supabaseUrl;
  if (!s.supabaseKey && cfg.supabaseKey) s.supabaseKey = cfg.supabaseKey;
  return s;
}

export async function saveSettings(local, s, cloud = null) {
  await local.setKV('settings', s);
  if (cloud && cloud.user) {
    // Zugangsdaten nicht in die Cloud schreiben
    const { supabaseUrl, supabaseKey, ...shared } = s;
    void supabaseUrl;
    void supabaseKey;
    try {
      await cloud.saveSettings(shared);
    } catch {
      /* offline */
    }
  }
}
