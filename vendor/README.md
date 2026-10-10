# Mitgelieferte Bibliotheken

NoteCode liefert diese Bibliotheken direkt mit, damit die App offline und ohne
fremde Server funktioniert. Alle werden unverändert aus den offiziellen
npm-Paketen übernommen.

| Datei | Projekt | Version | Lizenz |
|---|---|---|---|
| `verovio-toolkit-wasm.js` | [Verovio](https://www.verovio.org) – Notensatz (MusicXML → SVG) | 4.5.1 | LGPL-3.0-or-later |
| `jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) – PDF-Erzeugung | 2.5.1 | MIT (siehe `jspdf-LICENSE.txt`) |
| `lame.min.js` | [lamejs](https://github.com/zhuker/lamejs) – MP3-Kodierung (JavaScript-Portierung von [LAME](https://lame.sourceforge.io)) | 1.2.1 | LGPL-3.0 (siehe `lamejs-LICENSE.txt`) |

Verovio wird als eigenständige, austauschbare Datei geladen (dynamisches Laden
zur Laufzeit), wie es die LGPL vorsieht. Quellcode: https://github.com/rism-digital/verovio

`lame.min.js` ist die Datei `lame.min.js` aus dem npm-Paket `lamejs@1.2.1`
(unverändert). Sie wird ebenfalls als eigenständige, austauschbare Datei geladen –
im Web-Worker `src/web/mp3-worker.js` per `importScripts`, als Rückfall per
`<script>` – und dient dem Export „Audio als MP3“. NoteCode nutzt LAME, das
LAME-Projekt: https://lame.sourceforge.io · Quellcode der JavaScript-Portierung:
https://github.com/zhuker/lamejs
