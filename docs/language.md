# Presto

Presto is a small language with Python's look. A program builds a score. The score is engraved as sheet music and played. `c4` is the pitch C in octave 4, not a quarter note. A quarter note is the default length. Bars are real: the notes between `|` barlines have to add up to the time signature.

```python
title("First Notes")
tempo(96)
time("4/4")
key("C")
clef("treble")

notes("""
c4 e4 g4 b4 |
c5/2 r/2 |
""")
```

`c4 e4 g4 b4` is four quarters. `c5/2` is a half note. `r/2` is a half rest. Staff numbers and measure numbers start at 1.

## Notes inside a string

Pitches are `c4`, `d#4`, `eb4`, `f#5`. A rest is `r`. Whitespace separates events. `|` starts a new bar. Durations are `/1`, `/2`, `/4`, `/8`, and `/16`, with an optional dot: `c4/8.`. After a duration is written, later notes keep it.

A bare letter uses the previous octave: `c4 d e` is C4 D4 E4. The first note needs an octave. A lone `f` is the dynamic forte, so the pitch F is written `f4` or `fn`.

A chord is `<c4 e4 g4>/2`. A tie is `c4~ c4`. A triplet is `(3 c4 e4 g4)`, three notes in the time of two. A slur is `c4( e4 g4)`. A lyric is `c4 "lo"`.

Words `ppp pp p mp mf f ff fff` are dynamics and stick until the next one. `staccato`, `accent`, and `tenuto` mark the note beside them.

`pickup("1/4")` lets the first bar be one quarter long on purpose.

## What the language is

Indentation marks a block, the way Python does. `#` starts a comment. Strings use quotes or triple quotes. You can assign names, call functions, pass keyword arguments, and build lists. `def`, `return`, `for`, `if`, `else`, `elif`, and `with` are the control forms. There is no `import`, no classes, and no `while`. A program that runs too long stops with a step limit of 100000 or a note limit of 20000.

`for` unrolls into real measures. `repeat(2):` prints a repeat sign and plays the passage twice. `ending(1):` and `ending(2):` are first and second endings. They are not unrolled on the page.

`sound("piano")` and `gain(0.7)` change playback only. Dynamics, articulations, slurs, and tempo marks change the sheet and the sound.

## Layout

```python
layout(
    page="A4",
    margin=12,
    music_top=10,
    music_bottom=10,
    staff_distance=8,
    grand_staff_distance=10,
    min_system_distance=12,
    max_system_distance=24,
)
```

`break_system()` and `break_page()` start the next bar on a new system or page. Numbers are engraver units: one unit is the space between two staff lines.

OpenSheetMusicDisplay honors page size (in the print view), page margin, music top margin, music bottom margin, staff distance, grand-staff distance, and minimum system distance. It does not have a separate maximum system distance. Presto stores `max_system_distance`, and the engraver keeps at least the minimum, then spreads systems down the page. Verovio is not bundled. It would not add that missing maximum without a layout engine of our own.

`tempo()`, `time()`, and `key()` take effect at the next bar.

## Prelude

The prelude is ordinary Presto, not a hidden compiler feature. Insert it from the examples list. `scale("c4", "major")` returns eight eighth notes, one 4/4 bar. `chord("c4", "major")` returns `<c4 e4 g4>`. `transpose` keeps spelling: C up a minor third is E-flat, not D-sharp.

## Builtin `title`

Sets the title printed above the sheet.

## Builtin `composer`

Sets the composer credit.

## Builtin `tempo`

Sets the tempo in quarter notes per minute. The first call is the opening tempo. A later call prints a metronome mark on the next bar and changes playback from there. The Listen slider in the studio does not rewrite this.

## Builtin `time`

Sets the time signature, written like `"4/4"` or `"6/8"`. Later bars are checked against it.

## Builtin `key`

Sets the key signature. `key("G")` puts F-sharp on the staff. A written `f#4` does not get a second sharp. A written `f4` gets a natural. Spelling stays as written: `eb4` is E-flat.

## Builtin `clef`

Sets the clef for the current staff: `treble`, `bass`, `alto`, or `tenor`.

## Builtin `notes`

Writes music into the current part, staff, and voice. The argument is text in the notes language, or text returned from a function.

## Builtin `part`

Starts a part. `part("Piano", staves=2, sound="piano")` makes a grand staff. Use it with `with` so the indented lines belong to that part.

## Builtin `staff`

Selects a staff. Numbers start at 1. `staff(1).clef("treble")` and `staff(2).notes("c3 e3 g3 |")` write on that staff.

## Builtin `voice`

Selects a voice on the current staff. Numbers start at 1. Each voice is checked against the time signature on its own.

## Builtin `pickup`

Allows the first bar to be short. `pickup("1/4")` expects one quarter in that bar.

## Builtin `sound`

Chooses the playback instrument for the current part, such as `"piano"`, `"violin"`, or `"flute"`. It does not print a staff mark.

## Builtin `gain`

Sets the written loudness of the current part, from 0 to 1. Mixer faders are separate and are not saved in the piece.

## Builtin `dynamic`

Attaches a dynamic to the next note: `ppp`, `pp`, `p`, `mp`, `mf`, `f`, `ff`, or `fff`. The same words work inside a notes string.

## Builtin `articulation`

Attaches `staccato`, `accent`, or `tenuto` to the next note. Staccato plays shorter. Accent plays stronger.

## Builtin `lyric`

Attaches one syllable to the next note. Lyrics can also be written in quotes after a pitch.

## Builtin `layout`

Sets page size and spacing. See Layout above.

## Builtin `break_system`

The next bar starts a new system.

## Builtin `break_page`

The next bar starts a new page.

## Builtin `crescendo`

Starts a hairpin that grows louder, on the sheet and in playback, until `diminuendo()`, `wedge_stop()`, or a new dynamic.

## Builtin `diminuendo`

Starts a hairpin that grows softer.

## Builtin `wedge_stop`

Ends the open hairpin.

## Builtin `slur_start`

Starts a slur on the next note. Inside a notes string, `c4( e4 g4)` is the same idea.

## Builtin `slur_end`

Ends the slur on the latest note.

## Builtin `transpose`

Transposes pitches in a notes string by an interval such as `"m3"`, `"M3"`, or `"P5"`. A leading minus transposes down. Letter names stay honest: C up a minor third is `eb4`.

## Builtin `range`

`range(4)` is the numbers 0, 1, 2, 3. `range(1, 4)` starts at 1. Use it with `for`. A long range stops at the step limit instead of freezing the tab.
