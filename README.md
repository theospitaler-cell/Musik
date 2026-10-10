# NoteCode – Quartett-Arrangements & Solo-Noten

NoteCode arrangiert Songs automatisch für **Quartette** (Brass, Saxophon, Streicher,
Holz, Blasmusik … frei kombinierbar) oder als **Solo-Noten** (jedes Instrument oder
Schlagzeug). Die App läuft im Browser – am Rechner, Tablet und Handy – und liefert
Noten zum Mitlesen, Wiedergabe mit Mischpult sowie Export als **PDF**, **Bild (PNG)**,
**MuseScore (MusicXML)** und **MIDI**.

## Schnellstart

1. App öffnen (siehe [Veröffentlichen](#veröffentlichen-github-pages)) oder lokal starten:
   ```bash
   python3 -m http.server 8000   # im Projektordner
   # dann http://localhost:8000 öffnen
   ```
2. **Vorlage** wählen: Demo-Song, Datei (MusicXML/MXL von MuseScore, MIDI, ABC) oder ABC-Text.
3. **Besetzung**: Quartett (4 Instrumente + optional Schlagzeug) oder Solo-Noten.
4. **Stil & Solo**: Brass Band Funk (Standard), Second Line, Swing, Ballade, Klassik,
   Polka/Marsch; Hauptsolist, Schwierigkeit, Länge, Form, Tempo, Tonart.
5. **Arrangement erstellen** → Noten ansehen, abspielen, exportieren.

## Was NoteCode schreibt

**Formplan** (Beispiel Funk, Standardlänge):
Intro (Bass-Riff → Stabs → Hook aus dem Song → Tutti-Build-up) · Thema (Melodie
wandert zwischen den Stimmen) · Interlude (Send-off-Riff) · Solo (erst nur Bass/Groove,
dann Backgrounds) · *D.S. al Coda* · Coda mit Shout Chorus, Tag (2×) und Schlussakkord.

**Satztechnik**
- Kein Parallel-Block-Satz: Gegenstimmen bewegen sich, wenn die Melodie hält oder pausiert
  (Läufe, Motiv-Imitation, Arpeggien, Funk-Riffs); die Einhaltung wird geprüft.
- Gegenbewegung von Bass und Melodie, Quint-/Oktavparallelen werden erkannt und korrigiert
  (Klassik: in allen Stimmpaaren).
- Homophonie nur an Höhepunkten (Shout Chorus, Hits, Schluss).
- Rollentausch: Melodie in Tenor- oder Bassstimme, der Solist bekommt einen Formteil.

**Instrumente & Spieltechnik**
- Tonumfang und bequeme Lage je Instrument, Atempausen für Bläser.
- Posaunen-Glissandi nur, wo sie physikalisch gehen (gleicher Naturton, Zugpositionen),
  Fall-offs, Doits, Scoops, Trompeten-Shakes, Horn-Rips und gestopfte Töne, Dämpfer mit
  Wechselzeit, Pizzicato/Arco, Bogenstriche, spielbare Doppelgriffe.
- Transposition der Einzelstimmen: B-Instrumente große Sekunde höher, Tenorsax/Tenorhorn
  große None, Altsax große Sexte, Baritonsax große Sexte + Oktave, Horn in F Quinte,
  Kontrabass/E-Bass Oktave. (Hinweis: Das Tenorsax wird – anders als in der ursprünglichen
  Vorgabe – korrekt eine große None höher notiert.)

**Schwierigkeit (1–5)** – global oder pro Stimme, Standard „Automatisch“:
1 Sehr leicht · 2 Leicht · 3 Mittel · 4 Fortgeschritten · 5 Profi. Beeinflusst Lage,
Rhythmik (Stufe 1–2 nur Viertel/Achtel, keine Synkopen-Bögen), Sprünge, Effekte und Atmung.
Zusätzlich lässt sich pro Stimme der **tiefste und höchste Ton** (notiert) einstellen.

**Solo-Noten** – für ein Instrument: Intro mit Hook, Thema mit eigenen Fill-Ins, Variation,
ausgeschriebenes Solo über die Akkorde, Höhepunkt-Reprise, Coda; Akkordsymbole für eine
Begleitung. Für Schlagzeug: Drum-Chart mit Grooves, Fills, Hits zur Melodie und Drum-Solo.

## Notenbild

- Partitur und transponierte Einzelstimmen; in Stimmen steht der Instrumentenname nur
  oben links auf Seite 1.
- Kompakte Form mit Segno, *To Coda*, *D.S. al Coda* und Wiederholungen („2x“) –
  oder komplett ausgeschrieben.
- Mehrtaktpausen als H-Balken mit Taktzahl, Stichnoten vor Einsätzen nach langen Pausen.
- Große Probenbuchstaben, Taktzahl an jedem System, 4 Takte pro System.
- Balken nach Zählzeiten (Takthälfte sichtbar), ruhiges Pausenbild, Dach-Akzent (^) für
  „kurz & betont“.
- Vortragsangaben: Tempo/Stil mit Metronomzahl, Dynamik & Hairpins, *espressivo*,
  *cantabile*, *sempre staccato*, *Tutti*, *rit.*, Fermaten, Atemzeichen.
- Tenorschlüssel nur auf Wunsch (Einstellungen), sonst Bassschlüssel.

## Wiedergabe & Mischpult

Wiedergabe direkt im Browser mit hörbarer Dynamik, Artikulation, Swing-Achteln und Effekten.
Mischpult: Lautstärke, Stumm (M), Solo (S) und Panorama pro Stimme, Gesamtlautstärke,
Tempo-Regler (50–130 %), Klick auf einen Takt startet dort. Leertaste = Start/Pause.

## Exporte

| Export | Inhalt |
|---|---|
| MuseScore-Paket (.zip) | Partitur + alle Stimmen (MusicXML 4.0), MIDI, Regieplan |
| MusicXML | aktuelle Ansicht, öffnet direkt in MuseScore, Dorico, Sibelius, Finale |
| PDF | aktuelle Ansicht oder Partitur + alle Stimmen in einer Datei |
| PNG | Seiten der aktuellen Ansicht (≈250 dpi) |
| MIDI | alle Stimmen inkl. Tempoverlauf und Effekten (Pitch-Bend) |
| Regieplan (.md) | Formverlauf, Rollen je Stimme, Effekte, Prüfbericht |

## Konto & Synchronisierung (alle Geräte)

Ohne Konto speichert NoteCode alles lokal im Browser. Damit Arrangements auf **allen Geräten**
erscheinen, braucht es einen kleinen Server. NoteCode nutzt dafür ein eigenes, kostenloses
[Supabase](https://supabase.com)-Projekt (Datenbank + Anmeldung):

1. Bei supabase.com ein kostenloses Projekt anlegen.
2. Im Dashboard **SQL Editor** öffnen, den Inhalt von [`supabase/schema.sql`](supabase/schema.sql)
   einfügen und ausführen (legt Tabellen + Zugriffsschutz pro Benutzer an).
3. Unter **Project Settings → API** die **Project URL** und den **anon public key** kopieren.
4. Entweder in [`config.js`](config.js) eintragen (gilt dann automatisch auf allen Geräten)
   oder in der App unter **Einstellungen → Konto & Synchronisierung → Server-Verbindung**.
5. In der App **Anmelden → Registrieren**. (Wenn in Supabase „Confirm email“ aktiv ist, zuerst
   die Bestätigungs-Mail öffnen.)

Synchronisiert werden Arrangements (Vorlage + alle Einstellungen, daraus wird das Arrangement
reproduzierbar neu erzeugt) und Standard-Einstellungen. Der Abgleich läuft beim Öffnen, beim
Speichern und alle 60 Sekunden; bei Konflikten gewinnt der neueste Stand. Der „anon key“ darf
öffentlich sein – jede Person kann über Row-Level-Security nur ihre eigenen Daten lesen.

## Veröffentlichen (GitHub Pages)

Repository → **Settings → Pages** → „Deploy from a branch“ → Branch wählen, Ordner `/ (root)`.
NoteCode ist eine statische Web-App (kein Build-Schritt) und lässt sich auf dem Handy über
„Zum Home-Bildschirm“ wie eine App installieren.

## Entwicklung

```bash
npm test          # 29 automatische Tests (Import, Notensatz, Engine, Export, Sync)
npm run serve     # lokaler Server auf Port 8000
```

```
src/
  core/      Zeitraster, Zufall (Seed), XML, ZIP
  theory/    Tonhöhen/Schreibweise, Akkorde, Tonarten, Harmonie- & Formanalyse
  input/     ABC, MusicXML/MXL, MIDI
  arrange/   Instrumente, Stile, Formplaner, Generatoren, Schwierigkeit, Solo-Noten, Nachbearbeitung
  output/    Notensatz (Taktaufteilung, Balken), MusicXML, MIDI, Wiedergabe-Interpretation, Regieplan
  web/       Oberfläche, Player/Mischpult, Notendarstellung (Verovio), Speicher & Sync
vendor/      Verovio (LGPL-3.0) und jsPDF (MIT), mitgeliefert für Offline-Betrieb
```

Das Arrangement ist pro **Variante** (Seed) reproduzierbar; „Würfeln“ erzeugt eine neue Fassung.
