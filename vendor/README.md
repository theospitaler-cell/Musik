# Mitgelieferte Bibliotheken

NoteCode liefert diese Bibliotheken direkt mit, damit die App offline und ohne
fremde Server funktioniert. Alle werden unverändert aus den offiziellen
npm-Paketen übernommen.

| Datei | Projekt | Version | Lizenz |
|---|---|---|---|
| `verovio-toolkit-wasm.js` | [Verovio](https://www.verovio.org) – Notensatz (MusicXML → SVG) | 4.5.1 | LGPL-3.0-or-later |
| `jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) – PDF-Erzeugung | 2.5.1 | MIT (siehe `jspdf-LICENSE.txt`) |
| `lame.min.js` | [lamejs](https://github.com/zhuker/lamejs) – MP3-Kodierung (JavaScript-Portierung von [LAME](https://lame.sourceforge.io)) | 1.2.1 | LGPL-3.0 (siehe `lamejs-LICENSE.txt`) |
| `tfjs/tf.fesm.min.js` | [TensorFlow.js](https://www.tensorflow.org/js) – führt das KI-Modell im Gerät aus | 3.21.0 | Apache-2.0 (siehe `tfjs/LICENSE`) |
| `basic-pitch/model.json`, `group1-shard1of1.bin`, `notes.js` | [Basic Pitch](https://github.com/spotify/basic-pitch-ts) (Spotify) – lokale KI, die Noten aus Audio hört | 1.0.1 | Apache-2.0 (siehe `basic-pitch/LICENSE`) |

Verovio wird als eigenständige, austauschbare Datei geladen (dynamisches Laden
zur Laufzeit), wie es die LGPL vorsieht. Quellcode: https://github.com/rism-digital/verovio

`lame.min.js` ist die Datei `lame.min.js` aus dem npm-Paket `lamejs@1.2.1`
(unverändert). Sie wird ebenfalls als eigenständige, austauschbare Datei geladen –
im Web-Worker `src/web/mp3-worker.js` per `importScripts`, als Rückfall per
`<script>` – und dient dem Export „Audio als MP3“. NoteCode nutzt LAME, das
LAME-Projekt: https://lame.sourceforge.io · Quellcode der JavaScript-Portierung:
https://github.com/zhuker/lamejs
Die lokale KI (Basic Pitch) läuft vollständig im Gerät (WebGL, sonst Prozessor) – es werden keine
Daten an Server geschickt. `basic-pitch/notes.js` ist die Nachbearbeitung aus `esm/toMidi.js`
des npm-Pakets ohne den MIDI-Export.
