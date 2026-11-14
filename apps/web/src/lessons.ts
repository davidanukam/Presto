export type Lesson = {
  id: string;
  title: string;
  prose: string;
  source: string;
};

export const LESSONS: Lesson[] = [
  {
    id: "pitches",
    title: "1. Letter pitches",
    prose: "A letter with an octave is a pitch. c4 is middle C. e4 is the E above it. Four letters in 4/4 are four quarter notes. Press play and watch the staff.",
    source: `title("Letter pitches")
tempo(96)
time("4/4")
key("C")
clef("treble")

notes("""
c4 e4 g4 b4 |
""")
`,
  },
  {
    id: "durations",
    title: "2. Durations",
    prose: "c4 means the pitch C4, not a quarter note. A quarter is the default. /2 is a half note, /8 is an eighth. After you write a duration, the next notes keep it until you change it.",
    source: `title("Durations")
tempo(88)
time("4/4")
key("C")
clef("treble")

notes("""
c4/2 e4/4 g4/8 b4/8 |
""")
`,
  },
  {
    id: "bars",
    title: "3. Bars have to add up",
    prose: "The | is a barline. This bar is one quarter short of 4/4, so Presto refuses to draw a sheet that lies about the rhythm. Add a note, or a rest written r/4, until the bar is full.",
    source: `title("A short bar")
tempo(96)
time("4/4")
key("C")
clef("treble")

notes("""
c4 e4 g4 |
""")
`,
  },
  {
    id: "parts",
    title: "4. A second part",
    prose: "with part() starts a new instrument. Each part has its own clef and its own notes. Staff numbers start at 1.",
    source: `title("Two parts")
tempo(80)
time("4/4")
key("C")

with part("Violin", sound="violin"):
    clef("treble")
    notes("""
    e5/2 g5/2 |
    """)

with part("Cello", sound="cello"):
    clef("bass")
    notes("""
    c3/2 g3/2 |
    """)
`,
  },
  {
    id: "phrase",
    title: "5. Four bars",
    prose: "mf is mezzo-forte. It prints on the staff and plays a little louder. staccato shortens the note you put it on. This lesson is a finished four-bar melody.",
    source: `title("Four bars")
tempo(100)
time("4/4")
key("C")
clef("treble")

notes("""
mf c4 d4 e4 f4 |
staccato g4 a4 b4 c5 |
d5/2 c5/4 b4/4 |
c5/1 |
""")
`,
  },
];
