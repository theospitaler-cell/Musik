// Test-Lieder (gemeinfrei bzw. eigene Komposition) im ABC-Format.
export const DEMOS = [
  {
    id: 'saints',
    title: 'When the Saints Go Marching In',
    info: 'Traditional · New-Orleans-Klassiker · F-Dur · mit Auftakt',
    abc: `X:1
T:When the Saints Go Marching In
C:Traditional
M:4/4
L:1/4
Q:1/4=104
K:F
"F"F A B|"F"c4-|c F A B|"F"c4-|c F A B|"F"c2 A2|"F"F2 A2|"C7"G4-|G G F E|"F"F3 F|"F7"A2 c2|"Bb"c B3-|B A B c|"F"A2 F2|"C7"G2 G2|"F"F3|]`,
  },
  {
    id: 'groove',
    title: 'NoteCode Groove',
    info: 'Eigene Komposition · Funk-Blues in B · 16 Takte A/B',
    abc: `X:3
T:NoteCode Groove
C:NoteCode (Demo)
M:4/4
L:1/8
Q:1/4=100
R:funk
K:Bb
P:A
"Bb7"z2 B,D F2 _A2|"Bb7"G F D F- F4|"Eb7"z2 E G B2 _d2|"Bb7"c B G B- B4|
"Bb7"z2 B,D F2 _A2|"Bb7"G F D F- F2 z2|"F7"A2 c2 "Eb7"B2 G2|"Bb7"F8|
P:B
"Eb7"z G B _d c B G2|"Eb7"G2 B2 c4|"Bb7"z F _A B c B F2|"Bb7"F2 _A2 B4|
"C7"z =E G B c2 B2|"F7"A2 F2 E2 C2|"Bb7"D F B,D F2 _A2|"Bb7"B8|]`,
  },
  {
    id: 'ode',
    title: 'Ode an die Freude',
    info: 'L. v. Beethoven · D-Dur · Form A B',
    abc: `X:2
T:Ode an die Freude
C:Ludwig van Beethoven
M:4/4
L:1/4
Q:1/4=100
K:D
P:A
"D"F F G A|"D"A G F E|"D"D D E F|"A7"F3/2 E/ E2|"D"F F G A|"D"A G F E|"D"D D E F|"A7"E3/2 D/ "D"D2|
P:B
"A"E E F D|"A"E F/G/ F D|"A"E F/G/ F E|"D"D E "A"A,2|"D"F F G A|"D"A G F E|"D"D D E F|"A7"E3/2 D/ "D"D2|]`,
  },
  {
    id: 'grace',
    title: 'Amazing Grace',
    info: 'Traditional · G-Dur · 3/4-Takt · mit Auftakt',
    abc: `X:4
T:Amazing Grace
C:Traditional
M:3/4
L:1/4
Q:1/4=80
K:G
D|"G"G2 B/G/|"G"B2 A|"C"G2 E|"G"D2 D|"G"G2 B/G/|"G"B2 A/B/|"D"d3-|"D"d2 B|
"G"d2 B/G/|"G"B2 A|"C"G2 E|"G"D2 D|"G"G2 B/G/|"D7"B2 A|"G"G3-|"G"G2|]`,
  },
];
