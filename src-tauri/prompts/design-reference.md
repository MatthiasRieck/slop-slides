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

## Hero Morphs

A hero morph carries one element (a product shot, a logo, a chart) across consecutive slides:
on each click it glides and resizes from its place on one slide to its place on the next,
while the rest of the slide crossfades. Use it for a sequence that builds on one subject, such as
introduce → explain → zoom in, not for unrelated slides. Two to five steps read well.

Each step is a full slide that repeats the hero with the same `data-morph` name and the same
`src`. One base rule places it, and a layout class on the slide moves and resizes it, so the
morph comes from the layout change:

```html
<style>
.hero { position: absolute; left: 1110px; top: 190px; width: 660px; height: 660px; }
.detail .hero { left: 120px; top: 170px; width: 740px; height: 740px; }  /* left and larger */
.detail .copy { margin-left: 920px; }                                     /* text makes room */
.focus .hero { left: 560px; top: 90px; width: 900px; height: 900px; }    /* center stage */
</style>
<section class="slide" id="orbit-intro">
  <div class="copy"><h1>Meet Orbit.</h1></div>
  <img class="hero" data-morph="orbit" src="assets/orbit.png" alt="Orbit">
</section>
<section class="slide detail" id="orbit-detail">
  <div class="copy"><h1>Make room for the story.</h1><p>…</p></div>
  <img class="hero" data-morph="orbit" src="assets/orbit.png" alt="Orbit">
</section>
<section class="slide focus" id="orbit-focus">
  <img class="hero" data-morph="orbit" src="assets/orbit.png" alt="Orbit">
</section>
```

- Change position, size, and rotation between steps; keep the element's look the same. Its
  two snapshots crossfade during the move, so a different image or recolor shows as a blend,
  and a different aspect ratio stretches it.
- Morph whole elements: images, shapes, a card, a heading whose text is unchanged. Text that
  changes size reflows and stretches while it moves. Changing copy belongs outside the hero
  and simply crossfades.
- Several elements can morph at once, each with its own name (`data-morph="logo"`,
  `data-morph="price"`). Use each name once per slide and do not nest morphing elements.
- A staged reveal without movement is the same pattern: repeat the slide and add one
  element per step; what stays the same stays put.
- Leave `reveal` off morphing elements; other elements on the slide can still use it.
- The runtime sets the timing (about half a second, ease-out), and going back plays the move in
  reverse. Editor thumbnails and reduced motion show each step without movement.

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
