/* SlopSlide slide editor. The app adds it to the stage's slide preview in edit mode (see
   src-tauri/src/protocol.rs); it is never part of deck.html or an export. It is one script, kept
   in the files of src-tauri/assets/editor/, which run in the order of their names as one closure
   (src-tauri/build.rs joins them): this one opens it and the last one closes it.

   Click selects an element, drag (or arrow keys) moves it. Its corner and edge handles
   resize its box while the opposite side stays put (Shift keeps the aspect ratio, Alt resizes
   from the center); the round handle above it rotates it and the diamond next to it tilts it
   in depth, in 3D with perspective (Shift snaps to 15°). Double-click a handle to reset.
   Resize keeps text and borders at their size; drawings spread their points, and a group spreads
   what it holds. The toolbar can switch to Stretch, which scales the contents too, and lock the
   aspect ratio ({ type: "slop:edit-keep-ratio", on }), so resizes keep it without Shift (and
   Shift frees it). A figure with proportions (see FIGURES) shows a yellow handle on the spot they
   change (a chevron's point, a bubble's tail), which drags them; double-click resets them. On the first box resize, an in-flow
   element leaves an invisible placeholder in its original slot so its siblings stay put.
   A line or arrow has no box: it is picked only on (or just off) its stroke and heads, so a line
   in another's box stays clickable, and glows when hovered instead of being outlined; a handle at each end and on each point it bends at moves that
   point (snapping like a resize; Shift snaps to 45° from the point before it, ⌘ / Ctrl moves
   freely), dragging the small + handle on a stretch of the line adds a point there, which curves
   it, and double-clicking a point in between removes it. A connector (see "Lines") has handles
   on its ends only: it routes itself between them.
   An end dropped on an element (or dragged out from one) sticks to it, like a connector: the
   line keeps `data-from` / `data-to` with the element's id (one is given to it if it has none)
   and `data-from-at` / `data-to-at`, the spot on its box as percentages ("50% 100%", in its own
   turned frame). Whenever that element moves, resizes or turns, the end goes with it. Dropped
   close to the element's outline (its box, rounded corners, ellipse, `clip-path` shape or, for
   a drawing, its own strokes), which shows highlighted, the end sticks to its edge instead:
   the spot on the outline is kept with " edge" ("0% 0% edge"), and the end goes where the line
   toward that spot first meets the outline, so as the element turns the end slides along its
   edge while the line still points at the spot. Close to the middle of a side (a connection
   site, shown as dots while an end is near), the end goes right onto it, a spot kept without
   " edge". Dragging the end off it, or the line on its own, lets go; so does deleting the
   element.
   Double-click (or Enter) edits its text, Escape selects the parent (see "Editing text" below).
   A list is selected and edited whole, from any of its items: the text element it was made
   from when the list is all that element holds, otherwise the outermost list.
   A text box or shape the user added is one text, whatever it holds: its lines, lists and the
   inline <span>s of its formatting are never picked on their own. Its text sits in one block,
   `<div data-text-body>`, the box's only child: the box is a flex column (which is what aligns
   its text top, middle or bottom), and a flex box would lay out each formatted run of text
   directly in it as an item, on a line of its own. The editor makes the body when the text is
   edited or formatted (also in boxes saved without one, and in any other flex or grid box whose
   own text it formats), and keeps everything typed or pasted in it.
   Dragging and resizing snap to the slide's edges and center and to other elements' edges and
   centers, with guide lines (hold ⌘ / Ctrl to move freely, or with snapping turned off, to snap;
   Shift-resizes, and turned elements' resizes, do not snap), and a readout by the pointer shows the position and size. Shift keeps a
   move straight across or straight up and down. Nudges never snap.
   Shift- or ⌘-click adds to the selection or takes out of it, and dragging from empty space on
   the slide (or from a see-through wrapper that is not selected) draws a marquee around what to
   select (with Shift or ⌘, adding to the selection). ⌘A selects everything on the slide and Tab
   / Shift+Tab go through its elements. Several selected elements move, nudge, restyle, restack,
   delete, copy and duplicate together; their handles make way for a frame around each.
   ⌘D (or { type: "slop:edit-duplicate" } from the app) duplicates the selection, offset so the
   copy shows; Alt-drag leaves the original and drags a copy.
   ⌘G (or { type: "slop:edit-group" }) puts the selection in a group: a `<div data-group>` at the
   slide's top level, absolutely positioned around what it holds, which sits in it absolutely
   positioned (an element that was in the layout leaves its placeholder slot behind). A click on
   what it holds selects the group, which moves, resizes, turns, copies and restyles (what it
   holds) as one; a double-click goes into it, to select what it holds, until something outside it
   is picked. ⇧⌘G (or { type: "slop:edit-ungroup" }) takes it apart, everything staying where it
   shows. { type: "slop:edit-lock", locked, path } locks (`data-lock`) or unlocks the selection, or
   the element at `path`: a locked element (and what it holds) is out of the way on the slide: a
   press picks what is under it, and the marquee, ⌘A and Tab pass it by. A click where nothing
   else is to pick selects it (as the Layers panel does), and it then shows its frame without
   handles and is not moved, aligned or deleted. The editor reports the slide's layers, the
   top-most first, whenever they change: { type: "slop:edit-layers", slide, layers: [{ path, name,
   group, locked, held, selected, depth }] }, `held` when something it is in is locked, `depth` how
   many groups in it is.
   With ⌘ / Ctrl: ] and [ bring the selection forward and send it backward (with Shift, to the
   front and the back); Shift+L / E / R / J align its text left, center, right or justified and
   Shift+. / Shift+, make it larger or smaller (while typing too); Shift+H / Shift+V flip it;
   Alt+L locks or unlocks it; Alt+C copies its look and Alt+V pastes the copied one (the app keeps
   it, and is asked for it with { type: "slop:edit-request", slide, what: "paste-style" }); K asks
   the app for its Link popover ({ type: "slop:edit-request", slide, what: "link" }).
   Delete (or Backspace, or
   { type: "slop:edit-delete" } from the app) removes it; an in-flow element leaves an invisible
   `data-delete-placeholder` in its slot (or takes over its resize placeholder) so the rest of
   the layout stays put.
   Every change is posted to the app as the slide's new markup:
   { type: "slop:edit-commit", slide, markup, select, also, group }; `select` and `also` are the
   paths of the selection's primary element and of the others, which the app selects again after
   the reload with { type: "slop:edit-select", path, also }. `group` is there only for a save of
   arrow-key nudges, which save once they pause: "nudge:" and the paths of the elements nudged
   ("nudge:0.1,2"), the same for every such save of a run of nudges, so the app can keep them as
   one step to undo.

   What follows the pointer is done once a frame, however many events a frame brings: placing
   the handles, picking what is hovered, the readout, the reports of the selection and its
   geometry, a figure's redrawing. What takes measuring the whole slide (what overflows, the
   layers) waits until a drag, a marquee or the typing is over. Where the slide is on screen and
   how far it is zoomed comes from the pasteboard (`scale()`, `origin()`), not from measuring it.

   A selected SVG drawing (an <svg> on the slide) shows an "Edit SVG" button at its top right
   (not a line or arrow drawn with the line tools, which has its own handles and toolbar controls),
   which hands it to the app's SVG editor: { type: "slop:edit-open-svg", slide, path, markup,
   width, height, color, vars, css, fonts, ancestors } with its markup (without the editor's
   marks), its size in slide pixels, its text color, the CSS variables it can see, the deck's
   style rules (`fonts` its @font-face rules and imports of the stylesheets it cannot read,
   `css` the rest, relative urls made absolute) and the elements it sits in ({ tag, attrs }, outermost first), so it looks the same
   outside the slide. The app's context menu asks for the same with { type: "slop:edit-open-svg" }. The SVG
   editor saves its changes into the deck itself.

   A right-click selects what is under it and asks the app for its menu: { type: "slop:edit-menu",
   slide, x, y, element: { path, markup, name, added } | null, elements, editable, locked }, with
   (x, y) in the preview's pixels, `elements` every selected element (as `element`), `editable`
   whether the one selected element holds text to edit, and `locked` whether anything on the slide
   is locked. With a tool in hand, the tool goes back to Select first. Where nothing unlocked is
   under the pointer, the locked element there is selected, so the menu can unlock it.

   Images dropped on the slide come from the app (which saved them as assets) as
   { type: "slop:edit-insert-images", images: [{ src, w, h }], x, y }: each is placed on top,
   centered on the drop point (x, y in this window's pixels), and marked `data-dropped` until
   the agent gives it a place in the layout.
   ⌘C / ⌘X (or { type: "slop:edit-copy", cut } from the app) copy / cut the selection: it is
   posted as { type: "slop:edit-copied", slide, html, text } for the app to put on the system
   clipboard, `html` being its markup behind a header saying where it came from (for several
   elements, the header's `group` lists each one's). ⌘V goes to the
   app, which reads the clipboard and sends back what to paste. Whatever is pasted goes on top
   of the slide, absolutely positioned so the layout stays put. Each message may give a point
   (x, y in this window's pixels: where the context menu was opened), which the paste is then
   centered on:
   - { type: "slop:edit-paste", html, x, y } an element copied here, sized and looking as it did,
     at the coordinates it had on the slide it came from: on another slide in the same place, on
     its own slide a step down and right of the original while that still sits there (and of
     every copy already at the spot, so each copy shows);
   - { type: "slop:edit-paste-text", text, style, x, y } a text box with `text`, centered on the
     pointer when it is over the slide and otherwise in the middle of the view;
   - { type: "slop:edit-paste-images", images: [{ src, w, h }], x, y } images, as dropped ones,
     placed like pasted text.

   The app's edit toolbar drives the rest with messages:
   - { type: "slop:edit-tool", tool, style } picks a tool: "select", "text" (click or drag out a
     text box), "rect" / "rounded" / "ellipse" (drag out a shape, Shift keeps it even), "triangle" /
     "star" / "bubble" / "diamond" / "chevron" / "block-arrow" / "double-arrow" / "hexagon" /
     "octagon" / "pentagon" / "parallelogram" / "trapezoid" / "plus" / "cylinder" / "document" /
     "heart" (a figure: a box with `data-shape` whose shape, fill and border an SVG in its
     `background-image` draws at its size, so it holds text, takes a border, dashes, a shadow
     (around the shape, not on its text: a second SVG in its `border-image`) and flips, and keeps
     its text inside the shape with a padding fitted to its size; its proportions are in
     `data-adjust`; an old `clip-path` cut-out becomes one when it is restyled or resized),
     "bracket" / "brace" (an open outline: a drawing, `data-outline`, with one stroke through the
     box), "draw" (freehand), "line" / "arrow" (drag out a straight line, Shift snaps to 45°),
     "elbow" / "curve" (a connector, see "Lines") or "paint" (the format painter: takes the
     selection's look and gives it to the next element clicked). `style` is what new elements get.
     Added elements are absolutely positioned on the slide with inline styles and carry
     `data-added` ("text", "shape" or "drawing", which lines are too: a stroke <path>, `M L` when
     straight and `M C C …` through its points when curved, and a <path> for each head with
     `data-head`; arrows from earlier versions keep their head in the stroke, a last `M L L`).
     After a text box, shape, line or painted element the tool goes back to
     "select", and Escape puts any tool away; the editor tells the app with
     { type: "slop:edit-tool", slide, tool }.
   - { type: "slop:edit-style", style } restyles the selection: text color, size, font, bold,
     italic, underline, strikethrough, superscript / subscript (`script`), letter spacing, line
     height, alignment (vertical only in flex boxes, which added text boxes and shapes are),
     fill and border (a drawing's fill and stroke), and `autofit`: "shrink" (data-autofit, the
     runtime shrinks the text until it fits the box), "grow" (the box's height becomes a
     min-height, so it grows with its text) or null (overflow is only reported). Any element also
     takes `opacity` (0.05 to 1, so it stays clickable), `shadow` (blur in pixels, 0 for none; SVG
     gets a drop-shadow filter) and `radius` (corner radius in pixels), and an image `fit`
     ("contain", "cover" or "fill"), `fitPosition` ("50% 0%") and `alt`. Lines, borders and
     figures take `dash` ("solid", "dashed" or "dotted"), lines `headStart` / `headEnd` (see HEADS,
     or null) and `route` ("straight", "elbow" or "curved"), figures with proportions `adjust`.
     Images, figures and drawings take `flipX` and `flipY` (an inline `transform`, after any tilt;
     a figure mirrors its shape, not its text; a line is mirrored through its points, each time,
     and its ends stick to what they land on). A group's restyle goes to what it holds. With
     `preview: true` (a slider being dragged) the restyle shows but is not saved, until the same
     message without it applies it for good, as one change; { type: "slop:edit-style-cancel" }
     puts the elements back as they were. Text alignment is "left", "center", "right" or "justify".
   - { type: "slop:edit-flip", axis: "x" | "y" } mirrors every selected element that can flip,
     each in its own place; what is in a group too.
   - { type: "slop:edit-font-step", step: 1 | -1 } takes the selection's text a size up or down.
   - { type: "slop:edit-clear-formatting" } takes the inline formatting off the selected text
     (while typing) or off all the text of the selection; links stay.
   - { type: "slop:edit-copy-style" } hands the selection's look to the app, as the format
     painter takes it: { type: "slop:edit-style-copied", slide, style }; the app gives it to the
     selection of any slide with { type: "slop:edit-paste-style", style }.
   - { type: "slop:edit-unlock-all" } unlocks everything locked on the slide, and
     { type: "slop:edit-edit-text" } starts typing in the selected element.
   - { type: "slop:edit-snap", on } turns snapping to the guides on or off; ⌘ / Ctrl held while
     dragging does the opposite of what is set.
   - { type: "slop:edit-replace-image", src } points the selected image at another `assets/…`
     file, keeping its box (and cropping to it with `object-fit: cover`, unless it has a fit).
   - { type: "slop:edit-background", color } sets the slide's own background, or with null, goes
     back to the deck's. The editor reports it, on load and when it changes, the same way:
     { type: "slop:edit-background", slide, color }.
   - { type: "slop:edit-list", list: "ul" | "ol" } turns lines into a bulleted or numbered list
     (one item per line), switches their kind, or with the same kind turns them back into lines:
     while typing, the lines the text selection (or caret) is in, so a text can hold plain lines
     next to lists; otherwise all of them. Items next to each other share a list. Blank lines
     between the lines stay blank.
   - { type: "slop:edit-link", href } links it (wrapping its text, or an element without text,
     in an <a>; `#slide-id` links go to another slide) or with a null href removes its link.
   - { type: "slop:edit-finish" } ends text editing (the app sends it on a click outside its
     edit toolbar).
   - { type: "slop:edit-order", to, path, any } moves it "front", "forward", "backward" or "back"
     among the elements it overlaps, with an inline z-index; with `path` (from the Layers panel),
     the element there, and with `any`, past the next layer whether or not they overlap.
   - { type: "slop:edit-size-mode", mode: "resize" | "stretch" } sets how handles change size.
   - { type: "slop:edit-delete" } removes it.
   - { type: "slop:edit-select-all" } selects everything on the slide, like ⌘A.
   - { type: "slop:edit-align", to, target } lines the selection up: "left", "center", "right",
     "top", "middle" or "bottom", with the slide (`target` "slide", each element on its own) or
     with the bounds of several (`target` "selection"). Without a target, one element goes by
     the slide and several by their bounds.
   - { type: "slop:edit-match", axis: "w" | "h" } gives the other selected elements the primary
     one's width or height.
   - { type: "slop:edit-distribute", axis: "h" | "v" } evens out the gaps between three or more.
   - { type: "slop:edit-geometry", x, y, w, h, rotation } sets any of them, in slide pixels from
     the slide's top left. Several elements only take x and y, which move them together.
   - { type: "slop:edit-tilt", x, y } tilts the selection that many degrees further around its
     horizontal (x) and vertical (y) axis, or with { reset: true } flat again. Quick steps save
     together, like nudges.
   Whenever the selection or its place changes, it reports { type: "slop:edit-geometry", slide,
   geometry: { count, x, y, w, h, rotation } } (null when nothing is selected): the unturned box
   of one element, or the bounds of several, with a null rotation.
   Whenever the selection changes it reports whether anything is selected and what the toolbar
   shows for it: { type: "slop:edit-selection", slide, selected, selection }. A color that is not
   one plain color (a gradient, an image, `currentColor`), or that several selected elements do
   not share, is null with `colorOther` / `fillOther` / `strokeOther` set, to tell it from none. It reports the
   fonts the deck uses once: { type: "slop:edit-fonts", slide, fonts: [{ name, stack }] }, and
   the colors in its CSS variables: { type: "slop:edit-colors", slide, colors: [{ name, value }] }.

   Editing text: while typing, the toolbar's text styles, ⌘B / ⌘I / ⌘U and links apply to the
   selected text (wrapped in inline <span> styles, <sup> / <sub> or <a>); with only a caret, to
   the whole element. Editing survives a click on the app's toolbar (the text selection is kept
   and put back), and ends with Escape, Enter, a click elsewhere or { type: "slop:edit-finish" }.
   In a list, Enter starts a new item (Enter on an empty item, or Backspace at the start of one,
   outdents it or makes it a plain line again), Tab / Shift+Tab indent and outdent the item, and
   Shift+Enter breaks the line. Centered or right-aligned text keeps its bullets and numbers next
   to the text (`list-style-position: inside`) instead of at the box's left edge. A bullet or
   number shows in the color of its text: an item whose text is all one color takes that color
   itself (an inline `color` on the <li>) in place of <span>s around the text, and a new item
   goes on in the color and formatting the caret was in. ⌘V pastes
   with the formatting (bold, italic, underline, strikethrough, color, links and line breaks;
   fonts and sizes are dropped), ⌘⇧V as plain text: the editor asks the app for the clipboard's
   text with { type: "slop:edit-paste-request", slide, plain: true } and the app answers with
   { type: "slop:edit-insert-text", text }.

   It runs on the pasteboard (pasteboard.js), which pans and zooms the view; dragging the empty
   space around the slide pans too (on the slide, Space+drag or the middle button). The slide no longer clips, so content that runs past its edge stays visible (dimmed
   outside the slide, in the color of the panel around it), and the slide's frame turns into the
   app's accent color. Content moved far away can always be panned to and dragged back.
   Anything that runs past the slide's edge or is cut off by its own box is outlined with a red
   dashed wire and reported as { type: "slop:edit-overflow", slide, items } so the app can offer
   to tidy the layout. */
(function () {
