# Mitgelieferte Bibliotheken

NoteCode liefert diese Bibliotheken direkt mit, damit die App offline und ohne
fremde Server funktioniert. Beide werden unverändert aus den offiziellen
npm-Paketen übernommen.

| Datei | Projekt | Version | Lizenz |
|---|---|---|---|
| `verovio-toolkit-wasm.js` | [Verovio](https://www.verovio.org) – Notensatz (MusicXML → SVG) | 4.5.1 | LGPL-3.0-or-later |
| `jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) – PDF-Erzeugung | 2.5.1 | MIT (siehe `jspdf-LICENSE.txt`) |
| `tfjs/tf.fesm.min.js` | [TensorFlow.js](https://www.tensorflow.org/js) – führt das KI-Modell im Gerät aus | 3.21.0 | Apache-2.0 (siehe `tfjs/LICENSE`) |
| `basic-pitch/model.json`, `group1-shard1of1.bin`, `notes.js` | [Basic Pitch](https://github.com/spotify/basic-pitch-ts) (Spotify) – lokale KI, die Noten aus Audio hört | 1.0.1 | Apache-2.0 (siehe `basic-pitch/LICENSE`) |

Verovio wird als eigenständige, austauschbare Datei geladen (dynamisches Laden
zur Laufzeit), wie es die LGPL vorsieht. Quellcode: https://github.com/rism-digital/verovio

Die lokale KI (Basic Pitch) läuft vollständig im Gerät (WebGL, sonst Prozessor) – es werden keine
Daten an Server geschickt. `basic-pitch/notes.js` ist die Nachbearbeitung aus `esm/toMidi.js`
des npm-Pakets ohne den MIDI-Export.
