// NoteCode – Ordner in der Bibliothek.
// Eigene Ordner: Liste in den Einstellungen (wird mit dem Konto synchronisiert),
// die Zuordnung steht im Arrangement selbst (item.folder = Ordner-ID).
// Automatische Ordner: Arrangements desselben Lieds (gleicher Titel der Vorlage).

// Titel des Lieds, aus dem das Arrangement entstand
export function songTitleOf(item) {
  return String(item?.songTitle || item?.source?.song?.title || item?.title || '').trim();
}

export function songKey(item) {
  return songTitleOf(item).toLowerCase().replace(/\s+/g, ' ');
}

export function liveFolders(folders) {
  return (folders || []).filter((f) => f && !f.deleted);
}

const byName = (a, b) => a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' });

// items: neueste zuerst. Ergebnis: eigene Ordner, automatische Ordner (≥ 2 Arrangements
// desselben Lieds, nur außerhalb eigener Ordner) und die übrigen Arrangements.
export function groupLibrary(items, folders) {
  const all = folders || [];
  const map = new Map(liveFolders(all).map((f) => [f.id, { ...f, items: [] }]));
  const outside = [];
  for (const it of items) {
    if (!it.folder) {
      outside.push(it);
      continue;
    }
    let f = map.get(it.folder);
    if (!f) {
      // Ordner woanders gelöscht -> wieder in die Übersicht; unbekannt (noch nicht
      // synchronisiert) -> als Ordner zeigen, damit nichts verschwindet
      if (all.some((x) => x.id === it.folder && x.deleted)) {
        outside.push(it);
        continue;
      }
      f = { id: it.folder, name: 'Ordner', missing: true, items: [] };
      map.set(it.folder, f);
    }
    f.items.push(it);
  }
  const bySong = new Map();
  for (const it of outside) {
    const k = songKey(it);
    if (!k) continue;
    if (!bySong.has(k)) bySong.set(k, []);
    bySong.get(k).push(it);
  }
  const auto = [];
  const loose = [];
  for (const it of outside) {
    const k = songKey(it);
    const group = k ? bySong.get(k) : null;
    if (group && group.length > 1) {
      if (group[0] === it) auto.push({ key: k, name: songTitleOf(group[0]), items: group, auto: true });
    } else loose.push(it);
  }
  return { folders: [...map.values()].sort(byName), auto, loose };
}

// Ordnerlisten zweier Geräte zusammenführen: je Ordner gewinnt der neueste Stand
// (auch Löschungen, die als { deleted: true } erhalten bleiben).
export function mergeFolders(a, b) {
  const map = new Map();
  for (const f of [...(a || []), ...(b || [])]) {
    if (!f || !f.id) continue;
    const cur = map.get(f.id);
    if (!cur || (f.updatedAt || '') > (cur.updatedAt || '')) map.set(f.id, { ...f });
  }
  return [...map.values()].sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || ''));
}

export function sameFolders(a, b) {
  const key = (l) =>
    JSON.stringify(
      (l || [])
        .map((f) => [f.id, f.name, !!f.deleted, f.updatedAt || ''])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
  return key(a) === key(b);
}

export function uniqueFolderName(folders, base = 'Neuer Ordner') {
  const names = new Set(liveFolders(folders).map((f) => f.name.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}
