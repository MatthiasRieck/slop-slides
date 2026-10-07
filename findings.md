# Findings: SlopSlide on a phone or tablet crashes Safari

Status: the editor runs on real iPhones and iPads in view mode. Edit mode and pinch-zoom inside
edit mode still crash, and the desktop layout is the wrong UI for a phone anyway. This branch is a
starting point, not something to merge as is.

## Symptom

Opening a deck on a real device (iPhone 15 Pro Max, iOS 26.6.2, and an iPad) shows it for a moment,
then jumps back to the deck overview. After a few tries Safari shows "A problem repeatedly occurred
on …". The simulator never crashes.

## What it is

Safari kills the page's process (WebContent) because it uses too much memory, and then reloads the
page, which lands on the overview. Evidence:

- The Web Inspector console shows no JavaScript error; the page simply goes away.
- The iPhone has no JetsamEvent or WebContent crash report. WebKit enforces its own per-page
  memory limit and kills the process without writing a report.
- The simulator runs the page with no memory limit (`tasklimit=0` in its log), so it can't reproduce
  this. A real device is required.
- `deck/<id>/deck.html` opened directly on the phone works fine: the deck itself is not too heavy.

## The cause

Every slide is shown in a sandboxed iframe (`SlideFrame`, `sandbox="allow-scripts"`). In the
desktop window that iframe is a 1920×1080 page shrunk with `transform: scale(...)`. On iOS the
frame's page appears to be drawn at its own size, at the device's pixel density, however small it
is shown. Roughly 1920 × 1080 × 3² × 4 B ≈ 75 MB per slide page on an iPhone. Pinch-zoom multiplies
that by zoom². This is an estimate that fits every observation below; it was not measured on the
device (Instruments' Activity Monitor recording kept failing with "Device disconnected").

| Situation | Slide pages | Approx. cost | Result |
| --- | --- | --- | --- |
| Deck with 12 slides: 12 rail thumbnails + stage | 13 × 1920×1080 | ~1 GB | crash |
| Stage pasteboard around a squeezed slide (phone portrait) | tens of thousands of px across | many GB | crash, even with one empty slide |
| Pasteboard capped at 3× the slide | 5760×3240 | ~670 MB, ×2 while a slide swaps in | crash on slide change |
| Stage without pasteboard, 1920×1080 | 1, 2 while swapping | 75–150 MB | works |
| Same, pinch-zoomed ~3× | 1 | ~670 MB | crash |
| Stage page sized to its on-screen size | 1 | a few MB, grows with zoom from there | works, zoom works |
| Edit mode (editor needs the 1920×1080 page) + zoom | 1 | as above | crash |

Why the stage's page got so big on a phone: the editor's panels need about 810 px of width
(rail ≥150, stage ≥360, chat ≥300), so on a 430 px phone the stage gets squeezed and the slide in
it is a few dozen px wide. The pasteboard page spans the stage area in slide pixels
(`arena / scale`), which explodes as `scale` approaches 0.

## What this branch changes (on top of the remote-device feature)

All of it only applies on a device (`isRemote`); the desktop window is unchanged, apart from the
pasteboard cap, which only matters for tiny slides.

- `SlideFrame`: thumbnails are gray placeholders on a device (no iframe).
- `SlideFrame`: the pasteboard is capped at `MAX_ARENA_SLIDES` (3) slides in each direction.
- `Stage`: no pasteboard (`arena`) on a device; the stage preview is just the slide.
- `SlideFrame`: on a device, a non-pasteboard preview's iframe is the size it is shown, with no
  transform; the deck's player (`runtime.js` `fit()`) scales the slide into it. Edit mode still uses
  the full-size 1920×1080 page, because `pasteboard.js` and `editor.js` work in slide pixels.

## Still broken

- Edit mode on a device crashes when zoomed (full-size page, see above).
- Pinch-zoom and scrolling move the whole app UI, not just the slide.
- The three-panel desktop layout does not fit a phone at all.

## The device slide view (`DeviceDeck`)

A first version of the proposed direction below. On a device, an open deck shows `DeviceDeck`
instead of the editor:

- Only the current slide, full screen, as one page sized to the fit slide (`SlideFrame`'s device
  path). Bars float over it (deck list, chat, sketch tools, prev/next, slide list) and a tap
  hides them. Swipe left/right or the arrow keys change slides.
- Zoom and pan are the app's own (`src/lib/deviceView.ts`): pinch, double tap, one-finger pan when
  zoomed. Safari's page zoom is blocked (`lockPageZoom`: viewport `maximum-scale=1` plus cancelled
  `gesturestart`/`gesturechange`, `touch-action: none` on the slide). While pinching the page is
  scaled with CSS; once the fingers lift it is redrawn at the zoomed size, capped at 1920 CSS px
  wide (`MAX_PAGE_WIDTH`, the size that is known to work), and scaled up beyond that.
- Pen, highlighter, eraser, undo and clear draw review marks, as in the editor; a second finger
  turns a stroke into a pinch and drops it. Marks go to the agent from the chat sheet, through
  `capture_remote_sketch` as before.
- The slide list is a sheet with numbers and ids, no thumbnails.
- Not on the device: edit mode, the HTML view, the presenter, lint. Edit mode still needs the
  editor to work in a page that is not 1920×1080 (see below).

None of this has been run on a real device yet; the memory estimates above say one page at most
1920 px wide should stay well under the limit.

## Proposed direction: a device-only "slide" UI

Instead of shipping the desktop editor to the device, give devices a dedicated view that shows
only the active slide, full screen, with no rail or chat panels:

- One slide page at a time, sized to the screen. Prev/next as overlay buttons or swipes.
- Drawing/annotation (pen, highlighter, eraser, undo) as a small floating toolbar; strokes still go
  to the desktop via `capture_remote_sketch` / `remote-capture` as now.
- Zoom and pan handled by the app, not by Safari's page zoom: block page zoom
  (`touch-action: none` on the slide area plus a `viewport` meta with `maximum-scale=1`) and
  implement pinch/pan ourselves, as `pasteboard.js` does on the desktop. When zoomed, don't scale up
  a small page. Resize the iframe (or re-render at the zoomed size, capped at roughly the screen size
  × device pixel ratio) so the drawn page never gets much larger than the screen.
- Edit mode needs the editor to work in a page that is not 1920×1080: either teach
  `pasteboard.js`/`editor.js` a "fit" scale (`home()` currently uses `s = 1` outside a show), or
  make the device's editor page the screen's size and let the pasteboard fit the slide to it, as it
  already does for `?show`.
- Possibly bring back real thumbnails (sized to their on-screen size they should be cheap), or a
  slide picker sheet instead of a permanent rail.

## How to debug on a device

- Mac Safari ▸ Settings ▸ Advanced ▸ "Show features for web developers"; on the device Settings ▸
  Apps ▸ Safari ▸ Advanced ▸ Web Inspector. Connected by cable, the device appears in the Develop
  menu. A memory kill shows up only as the inspector losing the page, with no console error.
- Crash and memory reports: `xcrun devicectl device info files --device <id> --domain-type
  systemCrashLogs` (needs `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`). WebKit's own
  memory kills leave nothing here.
- Memory over time: `xcrun xctrace record --template "Activity Monitor" --device <udid>
  --all-processes --time-limit 180s --output x.trace`, then export the
  `activity-monitor-process-live` table and look at `com.apple.WebKit.WebContent` footprints. The
  connection dropped after ~1 s in our attempts; a stable cable/Wi-Fi pairing might fix it.
- The simulator is useful for layout and JS errors but never shows memory kills.
