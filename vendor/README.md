# Mitgelieferte Bibliotheken

NoteCode liefert zwei Bibliotheken direkt mit, damit die App offline und ohne
fremde Server funktioniert. Beide werden unverändert aus den offiziellen
npm-Paketen übernommen.

| Datei | Projekt | Version | Lizenz |
|---|---|---|---|
| `verovio-toolkit-wasm.js` | [Verovio](https://www.verovio.org) – Notensatz (MusicXML → SVG) | 4.5.1 | LGPL-3.0-or-later |
| `jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) – PDF-Erzeugung | 2.5.1 | MIT (siehe `jspdf-LICENSE.txt`) |

Verovio wird als eigenständige, austauschbare Datei geladen (dynamisches Laden
zur Laufzeit), wie es die LGPL vorsieht. Quellcode: https://github.com/rism-digital/verovio
