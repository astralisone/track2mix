---
name: Track2Mix
description: The event display. One track in, five tracks out, drawn as a collision in a detector.
colors:
  vacuum: "#01020f"
  surface: "#0a0d1f"
  ring: "#243247"
  ring-strong: "#3a5375"
  ink: "#e6e6ea"
  muted: "#a9b0bf"
  gold: "#f5b71c"
  gold-lit: "#ffd156"
  gold-ink: "#01020f"
  iris: "#7c7ee5"
  cyan: "#4fd1e0"
  key-chip-text: "#c4c6f3"
  iris-tint: "rgba(124, 126, 229, 0.16)"
  iris-tint-strong: "rgba(87, 90, 208, 0.18)"
  gold-tint: "rgba(245, 183, 28, 0.16)"
  meter-track: "rgba(255, 255, 255, 0.07)"
typography:
  display:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.75rem, 2rem + 3.6vw, 5.25rem)"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.75rem, 1.2rem + 2vw, 2.75rem)"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  title:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.25rem, 1.05rem + 0.8vw, 1.5rem)"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.0625rem, 1rem + 0.25vw, 1.1875rem)"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  figures:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: "0"
  chip: "4px"
  clip: "5px"
  fragment: "6px"
  pill: "999px"
spacing:
  xs: "0.5rem"
  sm: "1rem"
  md: "1.5rem"
  lg: "2.5rem"
  margin: "clamp(1.25rem, 3vw, 3rem)"
  section: "clamp(96px, 11vw, 160px)"
components:
  button-primary:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.gold-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "1rem 1.6rem"
  button-primary-hover:
    backgroundColor: "{colors.gold-lit}"
    textColor: "{colors.gold-ink}"
  button-small:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.gold-ink}"
    rounded: "{rounded.none}"
    padding: "0.7rem 1.1rem"
  input-text:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0.75rem 0.9rem"
  panel:
    backgroundColor: "{colors.vacuum}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "clamp(20px, 3vw, 32px)"
  keychip:
    textColor: "#c4c6f3"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    padding: "2px 6px"
---

# Design System: Track2Mix

## Overview

**Creative North Star: "The Event Display"**

The track you are playing is a collision at the centre of a detector. Every candidate in the library is a particle track flying outward through three rings, key, tempo and energy, and most of them stop at the ring that rejected them. Five make it out. The site draws exactly that, with the app's own figures, in the app's own colours, and everything else on the page sits on a ring, a track or a beamline rather than in a card.

The ground is a near-black navy vacuum, not grey and not black. Light on it is sparse and means something: gold is energy and the single action a visitor can take, iris is a key one step around the Camelot wheel, cyan is the relative major or minor, and a dim dashed steel line is a track that did not make it. Text is one humanist sans at generous sizes, set with tabular figures wherever a number appears. There are no photographs, no gradients, no glass, no glows and no cards. The interface fragments that show the app are hand-built and labelled illustrative.

Density is editorial, not dashboard: wide margins, one idea per section, running text at 50 to 62 characters. The one authored motion moment is the tracks drawing outward from the collision on load.

**Key Characteristics:**
- One dark ground with a lit mechanism on it; the drawing is the hero, not a screenshot.
- Four named colours, each with a fixed meaning taken from the app.
- One typeface for everything a human reads, a monospace only for figures inside interface fragments.
- Sharp rectangles; the only radii live inside the interface fragments.
- Concentric geometry as the compositional law: rings, tracks, beamlines, readouts.

## Colors

A dark detector palette: a navy vacuum, steel-blue rings, and three signal colours whose meaning never changes.

### Primary
- **Energy Gold** (#f5b71c): the energy calorimeter bars, the same-key tracks, the focus ring, text selection, and the single call to action. It appears on less than five percent of any screen; its rarity is the point. On hover the button lifts to a lighter gold (#ffd156), which is also the colour of lit figures inside fragments.

### Secondary
- **Key Iris** (#7c7ee5): tracks one step around the Camelot wheel, the key chips, the anchor row tint in the shortlist, the Compose clips. The app's own key colour.
- **Relative Cyan** (#4fd1e0): the relative major or minor track and its legend entry. Nothing else.

### Neutral
- **Vacuum** (#01020f): the page ground and the fill of every label plate on the display.
- **Surface** (#0a0d1f): alternating section ground, the inside of interface fragments and inputs, the fill of an isolated track's label.
- **Ring** (#243247): detector rings, ticks, table rules, fragment borders, beamline.
- **Ring Strong** (#3a5375): label plate strokes, input borders, the dim rejected tracks, the resting underline on links.
- **Ink** (#e6e6ea): headings and body text, the anchor dot at the centre of the event.
- **Muted** (#a9b0bf): secondary text, labels, legend text, readout terms. Still passes 4.5:1 on both grounds.

### Fragment tints (inside `data-ui` only)
- **Key chip text** (#c4c6f3) on an **iris tint** (rgba(124, 126, 229, 0.16)) with a stronger **iris tint** (rgba(87, 90, 208, 0.18)) for Compose clips, a **gold tint** (rgba(245, 183, 28, 0.16)) for a matching key, and a **meter track** (rgba(255, 255, 255, 0.07)) under the energy pill. These are the app's own surfaces and never leave the fragments.

### Named Rules
**The One Action Rule.** Gold fills exactly one rectangle per viewport, the download button. Everything else gold is a line or a bar that carries data.
**The Fixed Meaning Rule.** Gold, iris and cyan mean energy, key step and relative key. They are never decorative and never swapped for emphasis.
**The Two Grounds Rule.** Sections alternate between Vacuum and Surface. No third ground, no borders between sections, no shadows.

## Typography

**Display Font:** DM Sans (with ui-sans-serif, system-ui)
**Body Font:** DM Sans
**Figures Font:** JetBrains Mono, only inside `data-ui` interface fragments and code blocks

**Character:** One geometric-humanist sans carrying every size, set tight at display size and loose in running text. The monospace never appears in marketing copy; it is what the app's own screens use for numbers, so it shows only where a fragment of the app is drawn.

### Hierarchy
- **Display** (500, clamp(2.75rem, 2rem + 3.6vw, 5.25rem), line-height 1, tracking -0.03em): the hero headline only, always two lines ("One track in. Five tracks out.").
- **Headline** (500, clamp(1.75rem, 1.2rem + 2vw, 2.75rem), line-height 1.08, tracking -0.025em): one per section, a short sentence ending in a full stop.
- **Title** (500, clamp(1.25rem, 1.05rem + 0.8vw, 1.5rem), line-height 1.2): section sub-heads, the questions in the Q&A, the lede under the hero headline.
- **Body** (400, clamp(1.0625rem, 1rem + 0.25vw, 1.1875rem), line-height 1.6): running text, 50 to 62 characters wide, in Muted when it follows a heading in Ink.
- **Label** (400, 0.875rem): readout terms, table cells, legend entries, the phone-size file names. Uppercase with 0.06 to 0.08em tracking only inside interface fragments.
- **Figures** (400 to 500, 11 to 15px, tabular): numbers inside fragments and the SVG display labels (13px with a 12px sub-line).

### Named Rules
**The Full Stop Rule.** Every headline is a sentence and ends with a full stop. No eyebrows, no kickers, no numbering unless it is a real sequence of steps.
**The Tabular Rule.** Any element that shows a number sets `font-variant-numeric: tabular-nums`.

## Layout

A single centred column up to 1360px wide with a fluid side margin (clamp(1.25rem, 3vw, 3rem)) applied by each section, and a vertical rhythm of half a section unit (clamp(96px, 11vw, 160px) / 2) above and below. The hero is a 5/7 grid: copy left, the event display right at full column height. Two-column sections (narrow, readouts, get, Q&A) use `minmax(0, 1fr)` columns with a clamp gap and collapse to one column under 60em. The capability index is three columns, collapsing under 48em. The beamline steps are a row with a horizontal rule behind their station dots, stacking under 48em.

Under 37.49em the event display drops its label plates, enlarges the SVG text with a vacuum paint-order stroke, hides the rejected tracks and shifts the right-hand labels inward; code blocks wrap instead of scrolling. The sticky header is 64px tall on a 90 percent vacuum.

## Elevation & Depth

Flat. There are no shadows anywhere on the page. Depth is conveyed by the two grounds (Vacuum under Surface), by one-pixel Ring strokes, and by opacity: isolating a track on the display dims every other track to 18 percent. The only inset shadow is the two-pixel iris bar that marks the anchor row inside the shortlist fragment, which is a stroke, not a lift.

### Named Rules
**The No Glow Rule.** Signal colours are lines and fills at full opacity. Nothing blurs, nothing glows, nothing is glass.

## Shapes

Hard rectangles everywhere a human reads: the button, the inputs, the form, the tables. Circles belong to the detector (rings, ticks, the barrel, station dots, the anchor). The only radii are the 3-unit corners of the SVG label plates and the inside of interface fragments, where the app's own chips are 4px, its Compose clips 5px, its panels 6px and its meters pills, because those draw the app as it is. Rejected tracks are dashed (4 6). Borders are one pixel in Ring or Ring Strong; nothing is outlined twice.

## Components

### Buttons
- **Shape:** sharp rectangle (0 radius)
- **Primary:** Energy Gold ground, Vacuum text, 500 weight, 1rem by 1.6rem padding; the header variant is 0.7rem by 1.1rem at 0.9375rem; the form variant is full width with a 54px minimum height.
- **Hover / Focus:** ground lifts to #ffd156 on hover-capable pointers; press scales to 0.97 over 140ms; focus is a 2px gold outline offset 3px.
- **Secondary:** none. Every other link is text with a Ring Strong underline that turns to the text colour on hover.

### Cards / Containers
- **Corner Style:** square
- **Background:** the signup panel is Vacuum on a Surface section; interface fragments are Surface with a one-pixel Ring border.
- **Shadow Strategy:** none
- **Internal Padding:** clamp(20px, 3vw, 32px) on the panel; 9 to 14px rows inside fragments.

### Inputs / Fields
- **Style:** one-pixel Ring Strong border, Surface ground, Ink text, 0.75rem by 0.9rem padding, gold caret, square corners, label above in Muted at 0.875rem.
- **Focus:** 2px gold outline offset 2px.
- **Error:** messages in a `data-state="error"` line beneath the form; the input itself does not change colour.

### Navigation
- Sticky 64px bar on 90 percent Vacuum; wordmark left (the app's logo mark plus "Track2Mix" at 500), three Muted text links that turn Ink on hover, and the small gold download button. On phones the links hide and the button stays.

### Tables
- Full width, collapsed borders, one-pixel Ring rule above each row, 0.7rem vertical padding, Ink in the first column and Muted in the rest, last column right-aligned and tabular. A `gap` row adds 2.5rem above itself to group.

### The Event Display (signature)
An inline SVG on a -520 to 520 viewBox: four rings at radii 120, 230, 340 and 440 in Ring, 72 ticks and a 60-segment calorimeter barrel just outside the outer ring, an Ink anchor dot at the centre with an Ink leader to its label plate, and eight curved 2.5px tracks coloured by key relation. The five surviving tracks end on the outer ring, where a stack of gold blocks counts their energy (one block per point); the three rejected tracks stop, dashed, at the ring that rejected them. Every label is a Vacuum-filled plate in 17-unit DM Sans with a 15.5-unit Muted sub-line, tied to its track end by a one-pixel Ring Strong leader. Each track is a focusable button: pointer, focus or tap isolates it (others fade to 0.18 opacity, its plate fills Surface); Enter or Space holds the isolation, Escape releases it. On load the tracks draw outward once from the centre using stroke-dashoffset and the plates, stacks and leaders appear after; under reduced motion the finished event is shown. On wide screens the legend keys sit in the figure's bottom-right corner and the illustrative note in its bottom-left; on phones the plates, sub-lines, ring labels and rejected tracks are hidden and the figures are set at 34 units over a stroke of ground.

### Interface fragments (`data-ui`)
Surface panels with a Ring border, 12px Muted title bar, grid rows at 11 to 13px, iris key chips (4px radius, #c4c6f3 text, iris tint and border) that turn gold when they match the anchor, gold pill meters for energy, and Compose lanes drawn with SVG data-URI beat grids and waveform tiles. They are labelled illustrative wherever they appear.

## Do's and Don'ts

### Do:
- **Do** set the one action as a solid gold rectangle (#f5b71c on #01020f) and keep every other gold element a line or a bar that carries data.
- **Do** put every section on a ring, a track, a beamline or a readout; the concentric geometry is the compositional law.
- **Do** alternate section grounds between #01020f and #0a0d1f with no rules or shadows between them.
- **Do** set every number in tabular figures, and use JetBrains Mono only inside `data-ui` fragments and code.
- **Do** end headlines with a full stop and keep them to one short sentence.
- **Do** keep functional text at 11px or larger inside fragments and at 0.875rem or larger everywhere else; Muted (#a9b0bf) is the lightest text colour allowed.
- **Do** ship the finished state under reduced motion; the only authored motion is the tracks drawing outward on load and the 240ms isolate fade.

### Don't:
- **Don't** add eyebrows, kickers, numbered 01/02/03 labels, gradient text, glass, glows, drop shadows or icon cards.
- **Don't** use photographs or stock imagery; the mechanism is drawn, not pictured.
- **Don't** reassign gold, iris or cyan to anything other than energy, key step and relative key.
- **Don't** round the corners of anything a human reads; radii exist only inside interface fragments that draw the app as it is.
- **Don't** mention tablet, Android or iOS; the site markets the desktop app only.
- **Don't** point a download link anywhere but https://downloads.track2mix.com.
