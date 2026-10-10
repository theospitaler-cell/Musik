# NoteCode – Quartett-Arrangements, Solo- & Playback-Noten

NoteCode macht aus einem Song Noten: **Quartett-Arrangements** (Brass, Saxophon, Streicher,
Holz, Blasmusik … frei kombinierbar), **Solo-Noten** für jedes Instrument oder Schlagzeug –
und **Playback-Noten zum Mitspielen**, die 1:1 der Datei folgen. Mit Wiedergabe und Mischpult,
Export als **PDF**, **Bild (PNG)**, **MuseScore (MusicXML)** und **MIDI**.

## Installieren

| Gerät | So geht's |
|---|---|
| **Windows** | Unter [Releases](../../releases/latest) `NoteCode-Setup-….exe` herunterladen und starten. Erscheint „Der Computer wurde durch Windows geschützt“: *Weitere Informationen → Trotzdem ausführen*. |
| **Android** | Unter [Releases](../../releases/latest) auf dem Handy `NoteCode-…-Android.apk` herunterladen, öffnen und installieren (beim ersten Mal „Installation aus dieser Quelle erlauben“). |

Die Installer werden bei jeder Änderung automatisch von GitHub gebaut
([Workflow](.github/workflows/apps.yml)) und als neues Release veröffentlicht.

## Schnellstart

1. **Song laden**: MP3, WAV, M4A, FLAC, OGG, MuseScore-Datei (MusicXML/MXL), MIDI oder ABC.
   Eine Fortschrittsanzeige zeigt jeden Schritt (Lesen, Dekodieren, Analyse, Noten setzen, Export).
2. **Besetzung**: Quartett (4 Instrumente + optional Schlagzeug) oder Solo-Noten.
3. **Stil & Optionen**: Brass Band Funk (Standard), Second Line, Swing, Ballade, Klassik,
   Polka/Marsch; Hauptsolist, Schwierigkeit, Form, Tempo, Tonart.
4. **Erstellen** → Noten ansehen, abspielen, exportieren.

Arrangements haben immer ungefähr die **Länge des Originals** (jeder Formteil einmal,
das Solo ersetzt einen Mittelteil, kurzer Schluss).

## Solo-Noten: frei oder Playback

„Solo“ heißt hier: ein vollwertiges Notenblatt für **genau ein Instrument**, das durchgehend die
**Hauptmelodie** des Songs spielt (Gesangs-/Lead-Linie) – keine Improvisation, keine Begleitfiguren.

- **Ohne Playback**: Intro aus der Schlussphrase des Songs, dann alle Formteile mit Melodie in
  Originalreihenfolge (taktgenau), der letzte Teil als Höhepunkt (wenn bequem spielbar eine Oktave
  höher), Schlusston mit Fermate. Die Melodie liegt in einer Oktavlage im Kernbereich des
  Instruments; lange Töne werden nicht mit Akkorden gefüllt, sondern phrasiert (Atemzeichen).
  Effekte idiomatisch: Posaune Glissando nur an geeigneten Sprüngen in lange Zieltöne (gleicher
  Naturton), Trompete Akzente auf Phrasen-Höhepunkten & Synkopen, Fall-offs und Shake im Jazz,
  Sax Scoops, Horn Rip. Wiederholte Formteile: gleiche Töne, andere Phrasierung.
- **Playback** (Schalter an): zum Mitspielen zur Aufnahme bzw. Datei. Die Noten sind **1:1 wie
  die Vorlage** – gleiche Taktzahl, gleicher Ablauf, gleiche Töne (nur eine Oktavlage für das
  Instrument), gleiches Tempo/Timing, kein zusätzliches Intro.
  - Wähle, **welche Stimmen** des Liedes übernommen werden – eine, mehrere oder „Alle 1:1“ –
    und **auf welchem Instrument** du sie spielst (z. B. Gesang → Trompete, Gitarre → Altsax,
    Bass → Tuba). Mehrstimmige Spuren werden zur obersten Linie (bzw. Basslinie) reduziert.
  - **Schlagzeug**: die Drum-Spur wird 1:1 übernommen; auf Wunsch kommen **Fills im Groove**
    dazu (Formteil-Enden, nach 8 Takten – Füße laufen weiter, Raster des Grooves bleibt).
  - Im Mischpult läuft das **Original** synchron mit: bei MP3 die Aufnahme selbst (Tempo-Regler
    ohne Tonhöhenänderung), bei MIDI/MusicXML jede übernommene Spur einzeln plus „Band“ und
    „Schlagzeug“ – so lässt sich die eigene Stimme im Original stummschalten.

### Hauptmelodie erkennen (lokal, ohne Cloud)

- **MIDI**: jede Spur und jeder Kanal ist eine eigene Stimme; die Lead-Spur wird nach
  Einstimmigkeit, Melodielage, Melodiedichte, Präsenz im Song sowie Name/Instrument (Gesang,
  Lead-Synth, Bläser) bewertet – Akkord-, Arpeggio-, Pad- und Bassspuren fallen heraus.
- **MusicXML**: Part 1 wird bevorzugt (Partitur-Konvention), sonst die Stimme mit den
  deutlichsten Melodie-Merkmalen. In der Oberfläche lässt sich die Melodie-Stimme umstellen.
- **Audio**: die erkannte Haupt-Frequenzlinie wird als durchgehende Notenspur gesetzt.

### MP3 & andere Aufnahmen

NoteCode erkennt aus der Aufnahme Tempo und Beats (auch Tempo-Schwankungen), Taktart und
Taktanfang, Melodie (Gesang/Lead), Akkorde, Tonart, Form und den Schlagzeug-Groove
(Bass Drum, Snare, Hi-Hat je Formteil, Swing-Feeling). Die Analyse läuft im Hintergrund.
Das Ergebnis ist eine Annäherung – am besten bei klar hörbarer Melodie. Die Analyse wird in
der Bibliothek gespeichert (und synchronisiert), die Aufnahme selbst bleibt auf dem Gerät.

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
- **Gegenbewegung zum Bass**: Gegenstimmen, Liegeklänge und Comping richten sich nach der
  Basslinie – fällt der Bass, steigen die Mittelstimmen (oder bleiben auf dem gemeinsamen Ton
  liegen); ein Korrekturdurchgang beseitigt verbleibende Parallelbewegungen.
- **Wiedererkennung**: Füllfiguren imitieren bevorzugt Motive der Melodie, das Solo beginnt mit
  einer ausgezierten Paraphrase der Melodie des ersetzten Formteils, Solo-Backgrounds spielen
  Riffs im Rhythmus des Song-Hooks; schon im ersten Thema ist der Satz vierstimmig.

**Instrumente & Spieltechnik**
- Tonumfang und bequeme Lage je Instrument, Atempausen für Bläser.
- Posaunen-Glissandi nur, wo sie physikalisch gehen (gleicher Naturton, Zugpositionen),
  Fall-offs, Doits, Scoops, Trompeten-Shakes, Horn-Rips und gestopfte Töne, Dämpfer mit
  Wechselzeit, Pizzicato/Arco, Bogenstriche, spielbare Doppelgriffe.
- Transposition der Einzelstimmen: B-Instrumente große Sekunde höher, Tenorsax/Tenorhorn
  große None, Altsax große Sexte, Baritonsax große Sexte + Oktave, Horn in F Quinte,
  Kontrabass/E-Bass Oktave. (Hinweis: Das Tenorsax wird – anders als in der ursprünglichen
  Vorgabe – korrekt eine große None höher notiert.)

**Schwierigkeit** – *Sehr leicht · Leicht · Mittel · Fortgeschritten · Profi* (schwierigste Stufe),
global, pro Stimme oder bei den Solo-Noten direkt unter der Besetzung; Standard „Automatisch“.
Beeinflusst Lage, Rhythmik („Sehr leicht“/„Leicht“: nur Viertel/Achtel, keine Synkopen-Bögen),
Sprünge, Effekte und Atmung. Zusätzlich lässt sich pro Stimme der **tiefste und höchste Ton**
(notiert) einstellen.


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

Wiedergabe mit hörbarer Dynamik, Artikulation, Swing-Achteln und Effekten.
Mischpult: Lautstärke, Stumm (M), Solo (S) und Panorama pro Stimme, Original-Spuren beim
Playback, Gesamtlautstärke, Tempo-Regler (50–130 %), Klick auf einen Takt startet dort.
Leertaste = Start/Pause. Auf dem Handy öffnen Mischpult und Export-Menü als Bottom-Sheet.

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

Ohne Konto speichert NoteCode alles lokal auf dem Gerät. Damit Arrangements auf **allen Geräten**
erscheinen, braucht es einen kleinen Server. NoteCode nutzt dafür ein eigenes, kostenloses
[Supabase](https://supabase.com)-Projekt (Datenbank + Anmeldung):

1. Bei supabase.com ein kostenloses Projekt anlegen.
2. Im Dashboard **SQL Editor** öffnen, den Inhalt von [`supabase/schema.sql`](supabase/schema.sql)
   einfügen und ausführen (legt Tabellen + Zugriffsschutz pro Benutzer an).
3. Unter **Project Settings → API** die **Project URL** und den **anon public key** kopieren.
4. Entweder in [`config.js`](config.js) eintragen (gilt dann automatisch für alle Installationen)
   oder in der App unter **Einstellungen → Konto & Synchronisierung → Server-Verbindung**.
5. In der App **Anmelden → Registrieren**. (Wenn in Supabase „Confirm email“ aktiv ist, zuerst
   die Bestätigungs-Mail öffnen.)

Synchronisiert werden Arrangements (Vorlage + alle Einstellungen, daraus wird das Arrangement
reproduzierbar neu erzeugt) und Standard-Einstellungen. Der Abgleich läuft beim Öffnen, beim
Speichern und alle 60 Sekunden; bei Konflikten gewinnt der neueste Stand. Der „anon key“ darf
öffentlich sein – jede Person kann über Row-Level-Security nur ihre eigenen Daten lesen.

## Entwicklung

```bash
npm test          # automatische Tests (Import inkl. Audio, Notensatz, Engine, Playback, Export, Sync)
npm run serve     # als Web-App im Browser: http://localhost:8000
npm install       # einmalig für die Desktop-App
npm run desktop   # Desktop-App starten (Electron)
npm run dist      # Installer bauen (dist/)
```

```
src/
  core/      Zeitraster, Zufall (Seed), XML, ZIP
  theory/    Tonhöhen/Schreibweise, Akkorde, Tonarten, Harmonie- & Formanalyse
  input/     ABC, MusicXML/MXL, MIDI, Audio (Beat-Tracking, Melodie, Akkorde, Schlagzeug)
  arrange/   Instrumente, Stile, Formplaner, Generatoren, Schwierigkeit,
             Solo frei (solo-free.js), Playback 1:1 (playalong.js), Nachbearbeitung
  output/    Notensatz, MusicXML, MIDI, Wiedergabe-Interpretation (Tempo-/Beat-Uhr), Regieplan
  web/       Oberfläche, Player/Mischpult, Notendarstellung (Verovio), Audio-Worker, Speicher & Sync
electron/    Desktop-App (lädt die Web-App über app://)
vendor/      Verovio (LGPL-3.0) und jsPDF (MIT), mitgeliefert für Offline-Betrieb
```

Das Arrangement ist pro **Variante** (Seed) reproduzierbar; „Würfeln“ erzeugt eine neue Fassung.

## Schlagzeug-Notation (Drum-Chart)

| Position | Instrument |
|---|---|
| ✕ auf der Hilfslinie über dem System | Crash |
| ✕ über dem System | Hi-Hat (geschlossen), ⊗ = offen |
| ✕ auf der obersten Linie | Ride |
| 4. und 3. Linie/Zwischenraum von unten | Tom hoch / Tom mittel |
| 3. Zwischenraum | Snare (in Klammern = Ghost-Note) |
| 2. Zwischenraum | Standtom |
| unterster Zwischenraum | Bass Drum |
| ✕ unter dem System | Hi-Hat mit dem Fuß |

Hände: Hals nach oben, Füße: Hals nach unten. Pro Formteil wird der Groove einmal
ausgeschrieben, danach stehen Slash-Takte („sim.“ = Groove weiterspielen). Fills
und Hits mit der Band sind ausgeschrieben und mit „Fill“ bzw. Akzenten markiert.
