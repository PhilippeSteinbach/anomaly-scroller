# The Anomaly Scroller

A minimalist browser-based observation-horror / puzzle game.  
Scroll through liminal-space environments, spot subtle anomalies, and reverse direction before the loop resets.

---

## Concept

The player scrolls horizontally through a series of atmospheric corridor sections (subway platforms, maintenance tunnels, hospital hallways). Each section either contains a hidden **anomaly** or is completely normal. The player must:

- **No anomaly** → scroll all the way to the end of the section to advance.
- **Anomaly present** → spot the change, immediately **reverse** direction, and return to the start to clear the section.
- **Wrong decision** (miss the anomaly *or* reverse when nothing is wrong) → the loop resets and the player returns to Section 00.

A **Staring mechanic** rewards patience: standing still for 3 seconds at certain positions causes a hidden anomaly to slowly manifest.

---

## Genre & Platform

| | |
|---|---|
| **Genre** | Observation Horror · Puzzle · Point & Click |
| **Platform** | Web Browser (Desktop & Mobile) |
| **Controls** | Mouse-wheel / Touch-swipe (primary) · Arrow keys · ↩ Reverse button |

---

## Gameplay Mechanics

### Parallax Scrolling
The environment is built from three horizontally-scrolling layers at different speeds, creating an illusion of depth without 3-D rendering:

| Layer | Parallax rate | Content |
|---|---|---|
| Background | 0.15× | Far tile-wall grid, ambient light pools |
| Midground  | 0.45× | Main wall tiles, ceiling panels, posters, doors, exit signs |
| Foreground | 0.90× | Structural pillars, overhead cables, floor hazard stripes |

### Loop Logic
```
Section start (pos = 0) ───────────────────────────► Section end (pos = length)
                                    ▲
                           Anomaly window
                       [triggerPos ± lead/trail]
```

- Player enters the **anomaly window** → anomaly activates (poster changes, figure appears, speed slows, shadow moves wrong).
- Player **reverses** inside the window → enters RETURNING state; must reach pos ≤ 100 to clear.
- Player **reaches end** without reversing on an anomaly level → FAIL.
- Player **reverses** on a no-anomaly level → FAIL (false alarm).

### Staring Feature
If the player stops scrolling for **3 seconds** while inside an anomaly window of type `stare_figure`, a dark silhouette gradually fades in on the back wall. The player must then reverse to clear the section.

---

## Anomaly Types

| ID | Name | Description |
|---|---|---|
| `visual_poster` | Changed poster | A wall poster's text changes to something disturbing at the trigger position. |
| `stare_figure` | Background figure | A human silhouette appears on the far wall only after the player stops for 3 s. |
| `temporal_slow` | Temporal drag | The scroll speed drops to ~12 % of normal inside the anomaly window. |
| `visual_shadow` | Wrong shadow | A human-shaped shadow on the wall slowly drifts in the opposite direction to the light source. |

---

## Level Plan

| # | Name | Length | Anomaly |
|---|---|---|---|
| 0 | SECTION 00 | 3 000 | — (tutorial, learn controls) |
| 1 | SECTION 01 | 3 500 | `visual_poster` at 40 % |
| 2 | SECTION 02 | 3 200 | — |
| 3 | SECTION 03 | 4 000 | `stare_figure` at 55 % |
| 4 | SECTION 04 | 3 500 | `temporal_slow` at 48 % |
| 5 | SECTION 05 | 4 200 | `visual_shadow` at 38 % |
| 6 | SECTION 06 | 4 500 | — (final section) |

---

## Technical Stack

| Concern | Choice | Reason |
|---|---|---|
| Rendering | Single `<canvas>` + Canvas 2D API | Frame-accurate per-layer drawing; no external dependencies |
| Parallax | Manual offset per layer each frame | Full control; GPU-composited via browser |
| Audio | Web Audio API | Procedural sounds — no asset files required |
| Assets | Zero external files | Everything drawn procedurally (tiles, posters, pillars) |
| Build | None (plain HTML/CSS/JS) | Open directly in any browser |

---

## Art Style

**Liminal Spaces** — desaturated institutional palette (subway stations, empty corridors, hospital hallways).

- Near-black backgrounds (`#050508`)
- Dim fluorescent tube light (`#9090a8`)
- Institutional tile walls in alternating muted greys
- Scanline overlay for a slight CRT texture
- Glitch effect (pixel-strip shift + colour aberration) on anomaly events

---

## File Structure

```
anomaly-scroller/
├── index.html          ← Game shell: canvas, HUD, four screens
├── css/
│   └── style.css       ← Liminal aesthetic, HUD, screen transitions, glitch title
└── js/
    └── game.js         ← Complete game logic (single IIFE, ~750 lines)
                           ├── AudioSystem      (Web Audio: drone, steps, sting, chords)
                           ├── Renderer         (procedural canvas drawing, 3 layers)
                           ├── InputController  (wheel, touch, keyboard)
                           ├── StareDetector    (3-second idle timer)
                           ├── AnomalySystem    (visibility window, per-type state)
                           └── Game             (state machine: menu→playing→returning→clear/fail)
```

---

## Running the Game

No build step needed — open `index.html` directly in a modern browser, or serve the folder with any static file server:

```bash
npx serve .
# or
python3 -m http.server
```

Then navigate to `http://localhost:3000` (or the port shown).

---

## Planned Additions (future work)

- [ ] Additional anomaly types: `meta_glitch` (fake browser UI corruption), `acoustic` (scroll sound changes)
- [ ] Randomised level order beyond Section 06
- [ ] High-score / completion timer
- [ ] Mobile haptic feedback on anomaly events
- [ ] Accessibility: reduced-motion mode, screen-reader announcements
