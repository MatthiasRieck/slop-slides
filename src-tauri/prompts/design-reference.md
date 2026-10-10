# Design Reference

General guidance for decks that follow no template, and for slides a template has no layout
for. A deck's template carries its own fonts, colors, decoration, and entrance animation;
keep those rather than reaching for the recipes here.

## Motion to Feeling

| Feeling | Entrance | Visual Cues |
|---------|----------|-------------|
| **Dramatic / Cinematic** | Slow fades (1–1.5s), large scale settles (`scale: 1.1` → 1) | Dark backgrounds, spotlight gradients, full-bleed images |
| **Techy / Futuristic** | Short glitches (jittering `translate`, flickering `opacity`), steps or clip-path wipes | Grid patterns, monospace accents, cyan/magenta/electric blue, neon glow (`box-shadow`) |
| **Playful / Friendly** | Bouncy easing (`cubic-bezier(0.34, 1.56, 0.64, 1)`), small overshoots and tilts | Rounded corners, pastel or bright colors, pill shapes |
| **Professional / Corporate** | Subtle, fast (200–400ms) rises | Navy/slate/charcoal, precise spacing, data in focus |
| **Calm / Minimal** | Very slow, gentle fades, a little blur | High whitespace, muted palette, serif type, generous padding |
| **Editorial / Magazine** | Staggered reveals sliding in from one side | Strong type hierarchy, pull quotes, serif headlines with sans body |

## Entrance Animations

Restyle the runtime's entrance by setting `animation` on `.slide.active .reveal`, with
`both` fill so elements stay hidden until their turn. The runtime keeps the
`reveal-delay-1` … `reveal-delay-4` stagger on top of it. Keyframes only say where an
element comes from: animate `opacity`, `translate`, `scale`, `rotate`, `filter`, or
`clip-path`, never `transform`, and leave everything but `opacity: 1` out of the last
frame. The element then lands on its own styles, including any rotation it has and the
user's hand edits. Editor thumbnails show the last frame, so it must be the finished slide.

```css
/* Fade and rise (most versatile) */
@keyframes deck-reveal {
  from { opacity: 0; translate: 0 30px; }
  to { opacity: 1; }
}
.slide.active .reveal { animation: deck-reveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) both; }

/* Other starting frames */
from { opacity: 0; scale: 0.9; }             /* scale in */
from { opacity: 0; translate: -50px 0; }     /* slide from the left */
from { opacity: 0; filter: blur(10px); }     /* blur in */
```

A `clip-path` wipe needs an explicit last frame (`to { opacity: 1; clip-path: inset(-20px); }`),
since `none` does not animate.

## Background Devices

```css
/* Gradient mesh: layered radial gradients for depth */
.slide {
  background:
    radial-gradient(ellipse at 20% 80%, rgba(120, 0, 255, 0.3) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 20%, rgba(0, 255, 200, 0.2) 0%, transparent 50%),
    var(--bg);
}

/* Grid pattern: subtle structural lines */
.slide {
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
  background-size: 50px 50px;
}
```

## Font Pairings (Google Fonts)

| Display | Body | Feel |
|---------|------|------|
| Archivo Black | Space Grotesk | Bold, high-impact |
| Manrope (800) | Manrope | Clean, professional |
| Syne | Space Mono | Creative, retro-modern |
| Cormorant | IBM Plex Sans | Elegant, premium |
| Bodoni Moda | DM Sans | Editorial, tactile |
| Plus Jakarta Sans | Plus Jakarta Sans | Friendly, approachable |
| Fraunces | Work Sans | Witty, personality-driven |
| JetBrains Mono | JetBrains Mono | Developer, terminal |

## Do Not Use (Generic AI Patterns)

**Fonts:** Inter, Roboto, Arial, system fonts as display

**Colors:** `#6366f1` (generic indigo), purple gradients on white

**Layouts:** Everything centered, generic hero sections, identical card grids

**Decorations:** Realistic illustrations, gratuitous glassmorphism, drop shadows without purpose

## CSS Gotchas

CSS does not allow a leading `-` before a function name; the browser silently drops the
whole declaration and the element lands in the wrong place. Negate with `calc()`:

```css
right: -max(28px, 2em);           /* WRONG: ignored */
right: calc(-1 * max(28px, 2em));  /* right */
```
