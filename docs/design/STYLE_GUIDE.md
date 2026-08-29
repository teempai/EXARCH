# EXARCH Style Guide

The visual identity for both applications. This is the authority for typefaces,
colour, and marks; [Focus Flow](focus-flow.md) remains the authority for layout
and interaction.

The identity has one job: make an application whose entire purpose is *remote
authority over an agent* feel deliberate and legible at a glance, without ever
competing with the content it frames. Almost everything here is a rule about
restraint.

> **Status.** This guide describes the visual system implemented by
> `FocusFlowTheme`, `ExarchWordmark`, `AppearanceStore`, and the native UI tests.
> Normative language records current component invariants.

---

## 1. Name

**EXARCH**, always uppercase in the wordmark, capitalised as *Exarch* in running
prose and in accessibility labels.

A Byzantine exarch governed a distant province holding the emperor's full
delegated authority. That is the product: the laptop is the seat of authority,
the phone exercises it at a distance, and the approval signature is the proof of
delegation.

---

## 2. Typefaces

### 2.1 The rule

| Role | Face | Where |
|---|---|---|
| Wordmark | **Cinzel Bold** (`CinzelRoman-Bold`) | Three app-view placements, listed in §4.1 |
| Interface | **SF Pro** (the system font) | Everything else |
| Code and data | **SF Mono** (`.monospaced`) | Commands, paths, digests, diffs, policy detail |

Cinzel is a Roman inscriptional face descended from Trajan's column. It is
ceremonial by design, which is exactly why it is confined to the mark.

Everything else uses the system font. That is not a placeholder decision — it is
how both applications get Dynamic Type, optical sizing, correct localisation,
and accessibility text sizes for free. A bundled UI face would cost all of that
and buy a difference nobody notices inside a utility.

### 2.2 Using the wordmark in code

Never set `Text("EXARCH")` directly. Use the component, which owns the tracking
and accessibility label. Callers keep the documented 11pt size floor:

```swift
ExarchWordmark()                              // 15pt, toolbar and sidebar
ExarchWordmark(size: 28, relativeTo: .title)  // iOS privacy screen
```

### 2.3 The bundled face

Cinzel ships as a resource of the `ExarchUI` package
(`native/Sources/ExarchUI/Resources/Cinzel-Variable.ttf`) and is registered with
the process on first use. Both apps consume `ExarchUI` as a local package
product, so one declaration covers the iOS app, the Mac app, the test target,
and SwiftUI previews. Neither `Info.plist` declares a font.

It is version 2.000, licensed under the SIL Open Font License 1.1. `OFL.txt`
sits beside it in the same directory, which is what the licence requires — if
the font is ever moved, the licence moves with it.

**The PostScript name is `CinzelRoman-Bold`, and this is not negotiable.**
Cinzel ships only as a variable font whose `wght` axis runs 400–900, and it
declares exactly three named instances:

| Instance | PostScript name | `wght` |
|---|---|---|
| Regular | `Cinzel-Regular` | 400 |
| Bold | `CinzelRoman-Bold` | 700 |
| Black | `CinzelRoman-Black` | 900 |

There is **no SemiBold**, and applying a weighted font descriptor to the Regular
face silently resolves back to Regular rather than moving along the axis. An
earlier revision asked for `Cinzel-SemiBold`; it resolved to `nil`, and the
wordmark rendered in the fallback serif with nothing reporting it.
`ExarchUITests` now asserts the face registers and resolves, so that failure
cannot return quietly.

If the wordmark ever needs a different weight, take a real named instance from
the table above. Do not ask for one that is not there.

### 2.4 Type scale

The system scale, unmodified. Sizes below are the resolved values at the default
Dynamic Type setting, for reference only — never hardcode them.

| Style | Use |
|---|---|
| `.largeTitle` | Pairing and empty-state headlines |
| `.headline` | Navigation titles, approval sheet heading, thread titles |
| `.subheadline` | Harness label, policy label, sync status |
| `.body` | Message text, list rows |
| `.caption` / `.caption2` | Metadata, provider attribution, timestamps |
| `.system(.caption, design: .monospaced)` | Policy detail, patches, digests |

---

## 3. Colour

**Two appearances, both first class.** Neither is a variant of the other, and
neither is the "real" one. The user chooses, the choice is remembered, and it is
applied at the scene root so the surfaces the app does not draw — keyboard,
alerts, menus, share sheets — follow it too.

### 3.1 Palette

Defined once in [`FocusFlowTheme`](../../native/Sources/ExarchUI/FocusFlowTheme.swift),
where every token resolves against the surrounding scheme. A view never asks
which appearance it is in, and never writes a literal colour.

| Token | Light | Dark | Role |
|---|---|---|---|
| `canvas` | `#F3F3F5` | `#0B0D11` | The ground everything sits on |
| `surface` | `#FFFFFF` | `#15181F` | Cards, bars, the composer, circular controls |
| `raised` | `#E8E9EC` | `#1D212A` | A step from `surface`: inline code, secondary fills |
| `ink` | `#14171C` | `#ECE8E0` | Primary text |
| `secondaryInk` | `#5B6069` | `#8E949E` | Captions, metadata, disabled text |
| `border` | black 12% | white 10% | Hairlines, strokes on circular controls |
| **`accent`** | `#8A6832` | `#C7A46D` | **Brass.** Identity and action only |
| **`onAccent`** | `#FFFFFF` | `#0B0D11` | **Anything drawn on a saturated fill** |
| `accentSoft` | `#F2E9D9` | `#2A2113` | The accent at rest: user bubbles, selected chips |
| `attention` | `#9A5410` | `#E08A3C` | Warnings, such as applied redaction or a sync retry |
| `danger` | `#A8291C` | `#E5867A` | Destructive and failed states |
| `success` | `#1B6347` | `#74C4A8` | Healthy providers, verified chains, completed stages |
| `terminal` | `#07090C` | `#07090C` | The Mac live-activity pane |
| `terminalInk` | white 78% | white 78% | Text on `terminal` |

**Brass changes value between schemes, and that is the point.** The light brass
that carries a dark ground is about 1.9:1 on white — unusable. The light scheme
uses a darkened brass instead. The consequence is that *nothing on brass may use
a literal colour*, because the readable choice flips: white in light, near-black
in dark. That is what `onAccent` is for, and it serves any saturated fill —
`accent`, `success`, `danger` — not only brass.

`terminal` is the one deliberately scheme-independent surface. A terminal is
dark in a light application too, which is why it carries its own foreground
token rather than using `ink`.

### 3.2 Rules

**Brass is identity and action. It is never status.** It marks the primary
action, the active state, and the wordmark. A completed step, a settled sync, a
healthy provider, and an exhausted subscription are all statuses and take
`success`, `attention`, or `danger`. If a user cannot tell a warning from an
accent, the identity has broken the product.

**Never draw a literal colour on a fill.** Use `onAccent`. White on brass is
about 2:1 in the dark scheme and fails WCAG AA. This is also why
`.borderedProminent` is not used under a brass tint — the system chooses its own
label colour, which is white — and `ProminentBrassButtonStyle` exists instead.

**Use brass sparingly.** It may identify the wordmark and the screen's active or
primary controls, but never use it merely to decorate a container or report
status.

**Contrast floors, in both appearances.** Text on its background clears **4.5:1**;
`onAccent` on any fill it sits on clears **4.5:1**; accent and status colours
used as controls or glyphs clear **3:1**. These are asserted by
`ExarchUITests/ContrastTests`, computed from the tokens themselves, so changing
a hex value moves the test rather than the promise.

### 3.3 The appearance control

The user's choice lives in `AppearancePreference` and is persisted by
`AppearanceStore`.

- Three states: **system**, **light**, **dark**. A fresh install follows the
  device; an unreadable stored value falls back to the same.
- The control **cycles** rather than toggling. A two-way switch can never return
  to following the device once it has left.
- It sits in the Threads view on the same row as the sync status, which is
  compact and truncating to leave room for it.
- It draws at 30pt inside a **44pt** target, and its accessibility label names
  the current state rather than the icon — "Appearance: dark", not "moon".

## 4. Marks

### 4.1 Where the wordmark appears

Exactly three app-view placements. This list is the whole permission set for
the full wordmark:

1. The iOS thread-browser header
2. The iOS privacy-lock and lifecycle-concealment view
3. The Mac desktop sidebar

It is **not** a section heading, a button, or a label anywhere in either
application. The app icons use the single-letter mark from §4.3, and the system
launch screen is intentionally unbranded.

### 4.2 Setting it

- Always uppercase.
- Tracking **0.20em**, applied as a fraction of the size so it holds at every
  Dynamic Type setting. `ExarchWordmark` does this.
- Never below **11pt**. Cinzel's flared stems and fine serifs disintegrate
  first, and the classical proportions start to read as wobbly rather than
  carved.
- Cinzel has no italic and a narrow weight range. If a layout needs a weight or
  a slant the wordmark does not have, that layout wants the system font.

### 4.3 App mark

A single Cinzel **E** in `accent` on a vertical gradient, optically centred. The
letter is the mark; there is no symbol.

That is a deliberate choice, not an unfinished one. The obvious Norse and
imperial iconography — valknuts, runes, fasces, eagles — carries appropriated
and political associations that EXARCH avoids. The letterform carries the
identity without any of it.

**The artwork is generated, not drawn.** `scripts/generate-app-icons.swift`
renders every file in both asset catalogs from the bundled face. Change a value
here and in the script, rerun `swift scripts/generate-app-icons.swift`, and both
catalogs are rewritten identically. Do not hand-edit the PNGs.

| Property | Value |
|---|---|
| Gradient | `raised` `#1D212A` at the top to `canvas` `#0B0D11` at the bottom, vertical |
| Letter | `accent` `#C7A46D`, face `CinzelRoman-Bold` |
| Cap height | 46% of the tile at display sizes |
| Centring | on the glyph's **ink bounds**, not its typographic line box |
| macOS body | 824/1024 of the canvas, corner radius 185.4/824 |
| macOS hairline | `border` stroke on the rounded square, at 64px and above |

Centring matters more than it sounds. The typographic line box carries ascent
and descent that the letter E does not use, so centring on it leaves the mark
visibly low in the tile. The script measures the glyph's actual bounding rect.

**The small sizes are optically sized, not scaled.** A letterform reduced
linearly to 16px closes its counter and drops its serifs below a pixel. Below
64px the letter grows into the tile and the margin shrinks:

| Pixels | Cap height | macOS body |
|---|---|---|
| ≥96 | 0.46 | 824/1024 |
| 48–95 | 0.52 | 0.86 |
| 24–47 | 0.60 | 0.90 |
| <24 | 0.68 | 0.94 |

If the mark is ever redrawn, check 16px first. It is where it fails.

**Per-platform.** iOS supplies one 1024 tile per appearance — default, dark,
and tinted — because the system masks the corners and provides its own backdrop
for the latter two, so those are the letter alone on transparency, grayscale in
the tinted case. macOS supplies the full ladder and draws its own rounded
square, because Mac icons are not masked.

### 4.4 Clear space

Keep the wordmark clear of clipping and adjacent labels. Standard platform
toolbar and stack spacing is the minimum; do not compensate for its tracking in
individual call sites because `ExarchWordmark` already corrects the trailing
offset.

---

## 5. Controls

### 5.1 Circular icon buttons

`CircleIconButton` is a 30pt circle of `surface` with a `border` stroke and an
`accent` glyph, inside a 44pt hit area. It is used for navigation controls that
sit over scrolling conversation content, where a bare glyph loses contrast
against passing message bubbles.

Currently: the conversation back button. Keep the circle rare — it draws
attention, which is the point.

### 5.2 State-carrying controls

The composer's primary button sends while idle and stops while a turn is
running. A control whose only alternative is to sit disabled is available space:
prefer giving it the action the user actually wants in that moment over adding a
second control elsewhere.

Its label and accessibility label both change with the state. Its colour does
not — stopping a turn is the primary action of that moment, not a destructive
one, so it stays brass rather than becoming `danger`.

**A control the user reaches rarely does not get a permanent row.** Voice was
entered from a Text/Voice switch that occupied a full row above the composer
field at all times, for something used occasionally and left as soon as it has
produced a message. It is now a button inside the field, and the row went back
to the conversation. Weigh a control's frequency against the space it holds.

**A Stop control must stop everything the user can see running.** Voice mode has
its own Stop, and it reaches the laptop as well as the local speech loop
whenever a turn is in flight; otherwise a turn submitted by voice becomes
uninterruptible, since the text composer's stop button is not on screen. What
each control stops is decided by `ComposerStopScope`, and announced — VoiceOver
must not say "Stop" for two materially different outcomes.

### 5.3 Bars

The conversation view carries **one** 44pt bar holding back, title, harness, and
settings. Do not add a second bar to a content screen; if something does not fit
in the row, it belongs in the settings sheet.

### 5.4 Hit targets

44×44pt minimum, always. `CircleIconButton` draws at 30pt and pads to 44pt for
exactly this reason.

---

## 6. Voice and copy

Interface copy is plain, specific, and written from the user's side of the
screen. The product says *"Working on your laptop"*, not *"Executing remote
turn"*.

- Say **harness** for Codex, Claude Code, and Hermes. Not *provider*, which is
  the internal term, and not *model*, which is a different thing the user also
  chooses.
- Say **your Mac** and **your laptop**, not *the host* or *the daemon*.
- Approval copy states the action and what stays true regardless: *"Your
  laptop's existing policy remains authoritative."*
- Errors say what went wrong and what to do. No apologies.

---

## 7. Accessibility

- The wordmark carries `accessibilityLabel("Exarch")`, so it is never announced
  letter by letter.
- Every icon-only control has a label. `CircleIconButton` requires one.
- Everything except the wordmark scales with Dynamic Type. The wordmark scales
  too, via `relativeTo:`.
- The composer's primary button changes meaning with state — send while idle,
  stop while the laptop is working — so its accessibility label changes with it.
  A control that changes what it does must change what it announces.
- Colour is never the only signal. The sync row pairs its colour with an icon
  and text; provider health pairs it with a symbol.
- Verify at accessibility text sizes: the one-row conversation bar clips first
  because the title has the least room.
- Verify in **both appearances**. Contrast is asserted by test, but layout,
  shadows, and translucency are not.
- A screen that hides the system back button must restore the interactive
  swipe-to-pop gesture. Hiding the button disables it, and a conversation
  reachable only by tapping is a regression.

---

## 8. Checklist for a new screen

- [ ] Every colour comes from `FocusFlowTheme`; no literals, including on fills
- [ ] Anything drawn on a saturated fill uses `onAccent`
- [ ] **Checked in light and dark**, not one and assumed for the other
- [ ] **Contrast holds in both**: 4.5:1 for text and on-fill, 3:1 for controls
- [ ] **Status reads as status in both**: warnings and failures are still
      distinguishable from brass, and from each other
- [ ] No Cinzel outside `ExarchWordmark`, and no wordmark outside §4.1
- [ ] Brass is limited to identity and active or primary controls
- [ ] Status colours are `attention` / `danger` / `success`, never `accent`
- [ ] Monospace for anything a machine produced
- [ ] Icon-only controls have accessibility labels naming state, not icon
- [ ] Legible at the largest accessibility text size
- [ ] One bar
