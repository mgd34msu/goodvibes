# Screen readers and accessibility in the terminal app

`goodvibes` is a full-screen terminal program: it redraws the screen in place,
with colours, boxes and a status line. This page says what works with a screen
reader, how focus and contrast are shown, and the switches that make the screen
calmer or plainer.

## With a screen reader

A screen reader reading the terminal reads what is painted, cell by cell, and a
full-screen program repaints rows as they change. Expect the conversation to be
readable but noisy: the status line, the composer and an answer being written
are repainted, so a reader that announces changes repeats them.

The route that reads well is the plain one: run GoodVibes headless and read its
output line by line.

```sh
goodvibes run 'What does this project do, and how do I run its tests?'
goodvibes run 'List the failing tests' --output json
goodvibes run 'Fix the failing test in src/dates.test.ts' --output stream-json
```

`goodvibes run` prints the answer as plain text and exits; `--output json`
prints one JSON object at the end, and `--output stream-json` one JSON line per
event; with `--answer-permissions` as well, a script answers the approvals the
run raises on stdin. Without it a call that needs your answer is refused. The flags and exit codes
are in [cli-flags.md](cli-flags.md) and in `docs/exit-codes.md` at the repository root.

The web UI (`goodvibes web` prints its address) is the other route for a screen
reader: it is an ordinary web page with headings, buttons and labels.

## Calmer and plainer screens

| What | How |
| --- | --- |
| Less motion | Turn on `display.reduceMotion` (`/settings`, Reduce motion): the working spinner becomes one still mark with no colour sweep, and running rows stop spinning; times still count. With `display.stream` off as well, each answer appears whole. |
| Select with the terminal | Turn off `display.mouseCapture` (`/settings`, Use the mouse in the terminal programs) and start the program again: the terminal keeps the mouse, so dragging selects text its own way. Copy (`Ctrl+Y` for a block) uses a clipboard program when one is installed (wl-copy, xclip, xsel, pbcopy, clip.exe) and says `Copied` only when it confirmed the copy; otherwise the text goes to the terminal as OSC 52 and the status line says `Sent to your terminal's clipboard`. |
| No colour at all | Set `NO_COLOR` to any value before starting (`NO_COLOR=1 goodvibes`). `TERM=dumb` does the same. Everything is still drawn; nothing depends on colour alone to be read (an ask that cannot be undone also says `This can't be undone.`). |
| Answers all at once, not word by word | `/settings`, `Show answers as they are written` off (`display.stream`). The answer is painted once, when it is complete. |
| Plain ASCII lines in the work tree | `/settings`, `Line style for the work tree`, `ascii` (`display.treeGlyphs`). |
| Light or dark | `/settings`, `Light or dark appearance` (`display.themeMode`): `auto` asks the terminal once at start; `dark` and `light` force one. |
| Long tool output folded | `/settings`, `Fold tool output longer than this many lines` (`display.collapseThreshold`). |

## Contrast

Every built-in theme (`display.theme`: goodvibes, goodvibes-neon, catppuccin,
tokyonight, dracula, nord, gruvbox, one-dark, rosepine, solarized, github) keeps
dim and secondary text at a contrast of at least 4.5:1 against the panels it is
drawn on, in both light and dark. A theme that draws on the terminal's own
background (a transparent one) depends on that background colour.

## Focus and keys

- The approval card, the model picker, the command palette and every other
  overlay take the keys while they are open; the keys they take are listed on
  their last row, and `Esc` closes the top one.
- On the approval card the chosen button is drawn highlighted, and Enter presses
  it. It opens on `No` for anything that cannot be undone or that weakens a
  protection, so Enter never allows those.
- `?` or `Ctrl+P` lists every command and key, searchable by words.
- `/help keys` shows the current key bindings; every key but `?` and `@` can be
  rebound, in the Keys place or in
  `~/.goodvibes/tui/keybindings.json`. Places, rows and tabs can also be
  clicked.
