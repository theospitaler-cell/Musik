# NoteCode – Arrangements für 2–8 Instrumente (bis Kammerorchester), Solo-, Schlagzeug- & Playback-Noten

NoteCode macht aus einem Song Noten: **Arrangements für 2 bis 8 Instrumente** (Brass, Saxophon,
Streicher, Holz, Blasmusik … frei kombinierbar – neu arrangiert oder „Original übernehmen“),
**Solo-Noten** für jedes Instrument, eine eigene Kategorie **Schlagzeug** (immer mit Playback) –
und **Playback-Noten zum Mitspielen**, die 1:1 der Datei folgen. Alles läuft lokal und kostenlos,
auch die **KI**, die Noten aus MP3s hört. Mit Wiedergabe und Mischpult,
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
2. **Besetzung**: *Mehrere* (2–8 Instrumente + optional Schlagzeug), *Solo* oder *Schlagzeug*.
3. **Stil & Optionen**: Brass Band Funk (Standard), Second Line, Swing, Ballade, Klassik, Polka,
   Pop, Rock, Soul/R&B, Latin, Reggae/Ska, Disco, Blues/Shuffle, Marsch, Walzer – oder
   **Automatisch** (wählt aus allen nach Tempo, Taktart, Swing, Sechzehntel-Gefühl, Bass-Drum-Muster
   und Titel); Hauptsolist, Schwierigkeit, Form, Tempo, Tonart.
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

NoteCode erkennt aus der Aufnahme Tempo und Beats, Taktart und Taktanfang, Melodie
(Gesang/Lead), Bass, Begleitung, Akkorde, Tonart, Form und das Schlagzeug Takt für Takt.
Die Analyse läuft im Hintergrund.

- **Lokale KI**: [Basic Pitch](https://github.com/spotify/basic-pitch-ts) (Spotify, Apache-2.0)
  hört die Noten mehrstimmig – direkt im Gerät mit TensorFlow.js, ohne Server, ohne Kosten. Sie
  rechnet im Hauptfenster auf der Grafikkarte (ein ganzes Lied in Sekunden; im Web-Worker bleibt
  WebGL in manchen Umgebungen hängen), sonst im Worker auf dem Prozessor.
- **Stimmen**: aus den KI-Noten werden **Melodie** (führende Stimme – die Gesangslinie der
  Signalanalyse dient als Hinweis, bei Parallelstimmen führt die obere), **Bass** (tiefste Stimme,
  ohne Bass-Drum-Geister) und bis zu **zwei Mittelstimmen** getrennt. Tonart, Akkorde, Taktart und
  Taktanfang kommen aus diesen Noten (das Spektrum löst im Bass keine Halbtöne auf).
- **Lesbar**: im mittleren Tempo stehen alle Stimmen im Achtel-Raster, nur echte Synkopen bleiben
  als Sechzehntel; schnelle, durchsynkopierte Stücke werden im doppelten Tempo mit Achteln notiert.
- **Schnelle Läufe & Tonwiederholungen**: Folgen aus mindestens drei gleichmäßigen Tönen, die
  genau auf dem Raster des Schlags liegen (Sechzehntel ab Tempo ~88, Achtel-Triolen, 16tel-Triolen,
  32tel; Abstand höchstens 170 ms – Gesang in Balladen um Tempo 80 liegt bei 190 ms), bleiben als
  eigene Noten erhalten – auch wenn die KI sie nur 60–120 ms kurz hört – und werden nicht ins
  Achtel-Raster vereinfacht. Lautstärken sind relativ zum Lied gemeint (dichte Mischungen liegen bei
  KI-Werten um 0,4, klare um 0,6); die Begleitung muss mehr als 1,6× lauter sein, um einem Lauf die
  Führung zu nehmen. Eine Wiederholung
  desselben Tons zählt nur mit **echtem Anschlag**: die Teiltöne dieses Tons brechen ein und
  steigen wieder an (Transienten-Erkennung im Audio). Ein Splitter ohne Einbruch ist dagegen der
  Beginn desselben Tons (die KI löst den Einsatz zweimal aus) – der Ton beginnt dann am früheren
  Einsatz statt bis zu 80 ms zu spät. Das Raster hängt am Schlag, nicht an den Notenenden: kurze
  Pausen zwischen Staccato-Noten verschieben nichts. Gesang, Vibrato und Gleiten bleiben wie
  bisher vereinfacht (Muster müssen sehr genau und schnell sein); Mittelstimmen ebenso.
- **Form**: Formteile aus Takt-Merkmalen (Harmonik, Melodie, Lautstärke, Dichte, Schlagzeug) –
  Wiederholungen bekommen denselben Buchstaben, jeder Teil seine Lautstärke (leise Strophe,
  lauter Refrain); Dynamik und Dichte des Arrangements folgen ihr.
- **Von Hand korrigieren** (im Projekt unter der Analyse): *Taktanfang* einen Schlag früher/später,
  *Tempo ×2 / ÷2* (Achtel statt Sechzehntel bzw. umgekehrt), *Neu analysieren* für gespeicherte
  Aufnahmen aus älteren Versionen.
- **Halbes Tempo erkannt?** Bei schnellen Liedern (ab ~150 BPM) wählt die Beat-Suche gern die Hälfte
  (150 als 75). Mit den KI-Noten prüft NoteCode, ob bei diesem Tempo regelmäßige Ketten aus 32teln
  (mindestens 5 % der Töne) vorkommen und Bass Drum/Snare auch zwischen den Schlägen liegen – dann
  wird das Tempo verdoppelt (Hinweis in den Warnungen, mit *Tempo ÷2* umkehrbar). Echte langsame
  Lieder mit Sechzehntel-Hi-Hat oder Gitarrenzupfen bleiben unberührt.
- **Tempo**: der Schlag muss die Takt-Periode des Rhythmus-Musters ganzzahlig teilen (schließt
  Schein-Tempi durch Synkopen-Figuren aus, z. B. punktierte Achtel = 4/3 des Tempos); bei
  gleichmäßigem Tempo bleibt er am Raster. Tempokurve über das ganze Stück – auch **Tempowechsel**, **rit.** und **accel.**;
  in den Noten stehen neue Metronomangaben, „rit.“ und „a tempo“, die Wiedergabe folgt genau der
  Aufnahme. Shuffles werden im 12/8-Takt notiert (♩. = …).
- **Schlagzeug**: Harmonisch/Perkussiv-Trennung, dann NMF-Zerlegung in Bass Drum, Snare,
  Hi-Hat/Ride/Crash und Toms (Klangprofile passen sich dem Lied an), Ghost-Notes, offene Hi-Hat,
  Fills und Crashes wie gespielt.
- **Taktartwechsel** aus MIDI und MusicXML werden übernommen (neue Taktangabe in den Noten,
  Wiedergabe und Export mit den echten Taktlängen).
- **Geprüft an vielen Liedern, nicht an einem**: eine Testsammlung mit Rock, Halftime, Shuffle,
  Walzer, Funk, Ride, Ritardando, Tempowechsel und reinem Schlagzeug misst Tempo, Beats,
  Taktanfänge, Schlagzeug-Trefferquote und Melodie bei jeder Änderung.
### Aufwand: von „Schnell“ bis „Ultra“

Ein Schieberegler mit fünf Stufen (wie der Aufwand-Regler in Claude) steht bei der Aufnahme, bei
*Arrangement erstellen* und in den Einstellungen. Mehr Aufwand = mehr Zeit = bessere Noten:

| Stufe | Analyse einer Aufnahme | Arrangieren | Dauer (ca.) |
|---|---|---|---|
| Schnell | 1 KI-Durchgang | 1 Fassung | Sekunden |
| Ausgewogen | 2 KI-Ansichten (Original, ohne Schlagzeug) | wenige Varianten | 1–2 Min. |
| Gründlich *(Standard)* | 4 Durchgänge, Gesang/Begleitung getrennt, Seitensignal | viele Varianten je Abschnitt | 3–6 Min. |
| Sehr gründlich | 8 Durchgänge | + Parametersuche, Nachbessern | 10–15 Min. |
| Ultra | 12 Durchgänge | große Suche, wiederholtes Nachbessern | bis ca. 30 Min. |

Die Zeiten sind Obergrenzen: Die Arbeit hört früher auf, wenn nichts mehr besser wird.
Beim Arrangieren schreibt NoteCode mehrere Fassungen mit verschiedenen Einstellungen, bewertet sie
(Spielbarkeit, Stimmführung, Reibungen, Parallelen, Wiedererkennung der Melodie) und nimmt die
beste; die schwächsten Abschnitte werden einzeln nachgebessert. Der Prüfbericht zeigt, was
verglichen wurde.

**Fortschritt**: jede Aufgabe (Dekodieren, Stimmen trennen, KI-Durchgänge, Takt/Form, Noten
setzen …) hat einen eigenen Balken mit eigener, weich nachgeführter Restzeit; die Zeitschätzung
lernt aus früheren Läufen auf dem Gerät. Jeder Vorgang hat einen **Abbrechen**-Knopf (nach ca. 0,5 s beendet, der bisherige Stand bleibt); Tab schließen, Bibliothek und Einstellungen funktionieren während der Arbeit immer. Die rechenintensiven Schritte laufen so, dass die Oberfläche bedienbar bleibt (KI in kleinen Schritten, Noten-Auswertung im Hintergrund-Worker).

### Überarbeiten (Rückmeldung)

Unter dem Titel des Ergebnisses steht *Nicht zufrieden? Überarbeiten lassen*. Dort kann man in
eigenen Worten schreiben, was nicht stimmt – z. B. „Die Melodie fehlt in der Strophe“, „Stimme 2
liegt zu hoch“, „Takt 17–24 klingt schief“, „zu schwer“, „Bass zu unruhig“, „Tempo zu schnell“.
Ein Klick auf *Überarbeiten* wertet das aus (Takte, Stimmen, Stichworte), hört die Aufnahme bei
Bedarf noch einmal genauer, und arrangiert mit mindestens „Sehr gründlich“ neu. **Leeres Feld =
alles gründlich überarbeiten.** *Rückgängig* stellt die vorige Fassung wieder her.
Die Auswertung läuft lokal auf dem Gerät. Optional kann in den Einstellungen ein eigener
Anthropic-Schlüssel eingetragen werden; dann übersetzt Claude freien Text in die gleichen
Änderungen (gesendet werden nur der Text und Titel, Tonart, Tempo, Besetzung; der Schlüssel
bleibt auf dem Gerät).

### Orchester / Konzertpartitur

Die Besetzung *Orchester* (Kammerorchester: Fl, Ob, Klar, Fg, Hn, Trp, Pos, Tuba, Vl, Vl, Va, Vc,
Kb; bis 15 Stimmen) setzt eine Konzertpartitur in Partiturordnung mit Klammern für Holz, Blech
und Streicher. Die erste Geige führt; Streicher tragen den Klangteppich, Holz antwortet und
verdoppelt im Refrain, Blech setzt Akzente und füllt im Tutti – in leisen Teilen schweigen
Instrumente (Tacet). Mit der Stufe *Ultra* ist das der Weg zur Konzertpartitur. Wie jedes
automatische Arrangement ist das ein sehr guter Entwurf, kein Ersatz für einen Orchestrator.

Das Ergebnis ist eine Annäherung – am besten bei klar hörbarer Melodie. Die Analyse wird in
der Bibliothek gespeichert (und synchronisiert), die Aufnahme selbst bleibt auf dem Gerät.

## Was NoteCode schreibt

**Formplan** (Beispiel Funk, Standardlänge):
Intro (Bass-Riff → Stabs → Hook aus dem Song → Tutti-Build-up) · alle Formteile des Liedes in
Originalreihenfolge · Solo statt eines Mittelteils (erst nur Bass/Groove, dann Backgrounds) ·
letzter Refrain als Shout Chorus · Schlussakkord.

**Wie in Verlagsarrangements** (Vergleich gedruckter Noten mit den Original-Aufnahmen):
- **Stimme 1 = Lead**, die Melodie liegt immer oben; bei der ersten Vorstellung jedes Formteils
  exakt wie im Original. Begleitstimmen überschneiden die Melodie nur gelegentlich, wenn es sich
  anbietet (Antwort auf einen gehaltenen Ton), nie dauerhaft.
- **Dichte-Dramaturgie**: Strophe dünn (Melodie, Bass-Groove, Einwürfe/Call & Response),
  Pre-Chorus aufbauend (Liegeklänge mit Vorhalten, Gegenstimme in Gegenbewegung), Refrain voll
  mit breiten Akkorden und eine Stufe lauter (*f*), letzter Refrain Tutti. Der Refrain ist der
  häufigste gesungene Formteil.
- **Guide-Tones**: Terz (und Septime) jedes Akkords liegen in den Mittelstimmen.
- **2–8 Stimmen**: Lead, zwei Mittelstimmen und Bass werden nach Lage auf die Instrumente
  verteilt; weitere Stimmen verdoppeln im Refrain die Melodie (Oktave/Terz darunter) oder
  ergänzen den Satz, in der Strophe pausieren sie. Duo: Melodie + Bass bzw. Gegenstimme.
- **Gesangslinie lesbar**: Silbenwiederholungen werden zu längeren Tönen mit Tenuto, spätestens
  nach 4 Takten gibt es eine Atempause (mindestens eine Achtel); Gitarren-Kreuztonarten (E, H,
  Fis …) werden in Bläser-Tonarten (F, B, Es, As …) gesetzt.
- **Notenbild**: 4 Takte pro System, Probebuchstaben an Formteilen, Synkopen über die Taktmitte
  gebunden, Taktzahlen an jedem System.

**Original übernehmen** (Mehrere): voller Satz wie in gedruckten Ausgaben – Melodie 1:1 in
Stimme 1, die Basslinie der Vorlage in der tiefsten Stimme (Lücken: Grundton im Rhythmus der Bass
Drum), die Mittelstimmen im Rhythmus der Begleitung: Parallelstimmen (Terzen/Sexten zur Melodie)
laufen Ton für Ton mit, Akkord-Einwürfe von Gitarre/Klavier werden als sauber geführte Akkordtöne
gesetzt. Form, Takte, Tempo und Lautstärken wie im Lied.

**Spielbare Stimmen** (alle Arten von Arrangements): zwischen zwei Tönen einer Stimme liegt
höchstens eine Oktave (zu große Sprünge werden mit möglichst wenigen Oktavversetzungen aufgelöst,
nach einer Pause von mehr als einem Takt beginnt eine neue Phrase). Die weiteren Mittelstimmen
tragen das Einwurf-Muster der Begleitung nicht mit, sondern halten (zweite Mittelstimme auf der
Takthälfte, dritte und weitere auf dem Taktanfang): jede Stimme hat ihren eigenen Rhythmus. Pausen,
in denen *alle* Stimmen länger als einen Schlag schweigen, überbrückt der Bass.

**Neu arrangieren** (Standard) bleibt zu rund 90 % beim Original: Melodie, Bass, Begleitung und
Groove der Vorlage stehen Takt für Takt wie im Lied. Verändert wird nur die Form, wie es ein
Arrangeur an einem bestehenden Stück tut:
- **Vorspann** (2–4 Takte nur mit der Begleitung), wenn das Lied sofort mit der Melodie beginnt,
- bei **vielen gleichen Strophen/Teilen** fallen einzelne Wiederholungen weg (der erste und der
  letzte Teil bleiben, höchstens ein Viertel der Takte),
- ein kurzer **Anhang** (die letzten 2 Takte noch einmal) als Schluss.
Das steht im Prüfbericht. Mit der Anpassung „Frei“ (Erweitert) schreibt NoteCode den ganzen Satz im
gewählten Stil neu: Melodie-Solos für andere Stimmen, Antworten in den Melodiepausen, im Refrain
die zweite Stimme in Terzen/Sexten, Shout Chorus am lautesten Teil, Solo als ausgezierte Melodie.
Lieder ohne Begleit-Vorlage (nur Melodie und Akkorde, z. B. ABC) werden ebenfalls frei gesetzt.

**Satztechnik**
- Kein Parallel-Block-Satz: Gegenstimmen bewegen sich, wenn die Melodie hält oder pausiert
  (Läufe, Motiv-Imitation, Arpeggien, Funk-Riffs); die Einhaltung wird geprüft.
- Gegenbewegung von Bass und Melodie, Quint-/Oktavparallelen werden erkannt und korrigiert
  (Klassik: in allen Stimmpaaren).
- Homophonie nur an Höhepunkten (Shout Chorus, Hits, Schluss).
- Der Solist bekommt einen Formteil als Solo.
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
npm run serve     # als Web-App im Browser: http://localhost:8000 (Node, kein Python nötig)
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
