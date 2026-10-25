# ViniPlay design system

Direction: editorial, dense and quiet. Surfaces are separated by hairlines and spacing instead of nested bordered cards; colour carries state, not decoration. Inter is used for all UI text and JetBrains Mono for technical text.

## Tokens (`public/css/tokens.css`)

- **Colour roles:** cyan = interactive and selected, pink = live and "now", amber = reminders and favourites, green = success, red = record and destructive. Light theme uses `#F6F7F9` background, white surfaces, `#151B2B` text and a `#076B76` accent (text contrast 5.8:1; white on the accent 6.2:1). `--ctl` is the control-border colour (3:1 or better).
- **Type scale:** page 30px, section 20px, card title 15px, body 14px, metadata 13px, technical 12px, nav label 11px. Weights 400, 500, 600. Times and numbers use tabular numerals.
- **Spacing:** 4px steps (`--sp-1` to `--sp-7`). **Radius:** 2/4/6/8/12px, controls and cards at 4-6px. **Elevation:** borders by default, shadows only on overlays.
- **Controls:** heights 28/36/44px, icons 16/20/24px, motion 120ms (hover) and 180ms (overlays), reduced-motion removes transitions.
- **Layout:** `--gutter` 16/24/32px by viewport. Pages fill the viewport; only prose and forms use `--measure`.

## Components

- **Shell:** 3.6em header; rail with an accent bar and tint for the active item (no pill), labels on desktop, icons only 768-1023px, bottom tab bar under 768px. Active item sets `aria-current="page"`.
- **Channel card** (`channelCardHTML` in `guide.js`): the card is a button that plays the channel; the star is a separate `aria-pressed` button, so it works on its own. The programme line is shown only when guide data exists; otherwise a quiet "No guide".
- **Coming up:** time, title (max two lines, full title in the tooltip), channel, reminder or recording status with an icon and text.
- **Tables:** cells wrap (`overflow-wrap`), times and numbers stay on one line (`.nw`), URLs and IDs break anywhere (`.brk`), actions share one compact cell (`.act`). Tables with `.stack` become one card per row under 768px; labels come from the header (`tablelabels.js`).

## Deliberate local scrolling

- Live TV guide timeline (two-dimensional comparison of channel by time).
- Settings section tabs on phones (a row of chips).

Everything else wraps or stacks.

## Checked

Overflow (document and nested scrollers) at 390, 768, 1280, 1440, 1920 and 3440px; axe-core WCAG 2.2 AA rules on Home, Live TV, Recordings, Activity and Settings in light and dark. Before and after screenshots are in `docs/redesign/`.
