# SlopSlide

A desktop slide editor you drive by chatting. Describe a presentation, and an agent writes
the slides. Keep talking to it to restyle, rewrite, split, or add slides while you watch them change.

- **View and Edit:** View changes nothing in the deck but its review (marks and comments):
  it shows the slides, plays them on the timeline and takes your comments. Edit changes the
  deck: the slide on the stage, the slides and sections in the list on the left, and the
  timing on the timeline. A deck opens in the mode decks were last in (Edit, until you pick
  View); a double-click on the slide in View opens it in Edit.
- **Left:** live thumbnails. The list works the same in View and in Edit: drag to reorder
  (several picked slides go together, or Space on a thumbnail picks it up for the arrow keys);
  hover to lock, hide, duplicate or delete (a small thumbnail folds these into one "…" button that
  opens the slide's menu), for all the picked slides when it is one of them. `+`, "New slide…" in
  a menu and ⇧⌘N all open the layouts, Blank first (Enter adds it). A right-click on a slide opens
  everything that can be done with it (edit it, present from it, new slide, duplicate, copy, cut,
  paste after, delete, hide, lock, move, start a section), for all the picked slides when it is one
  of them; a right-click on a section's heading, or its "…", renames it, adds a slide to it, moves
  it up or down, folds, selects its slides, removes it (its slides stay) or deletes it with its
  slides. In the list ⌘A picks every slide, ⇧↑ / ⇧↓ pick the slides on the way, ⌘D duplicates, ⌘X
  cuts, ⌘V pastes after the selected slide and Delete deletes the picked ones, and Home and End go
  to the first and last slide. While several are picked, what can be done to them takes the
  place of the list's heading. Deleting slides or a section says so with an Undo. Under each
  slide's number, beside the picture, small marks say what there is to know: problems the deck
  check found, content running past the slide (known once the slide was edited), locked, hidden,
  comments, search matches, speaker notes and narration; the tooltip names the slide. A locked
  slide can be changed by neither you nor the agent: it cannot be edited on the stage, deleted,
  or saved changed from the code view, and if the agent changes it anyway the app puts it back
  after the turn. Unlock it to change it. Sections group slides under a heading in this column
  (never in the presentation), with how many slides each holds: the section button starts one at
  the selected slide; double-click a heading to rename it, drag it to move the whole section
  (every section folds to its heading while you do, and slides before the first section stay
  put). Which sections are folded is remembered per deck. Drag a slide across a heading to move
  the boundary. ⌘C copies the picked slides (after a press in the slide list).
- **All slides:** the grid button over the slide list, or G, shows every slide as a grid in the
  place of the stage, to see and restructure the whole deck: the same picking, menus, keys and
  dragging as the list, sections as headed groups, a slider for the thumbnail size (remembered),
  ↑ / ↓ a row up and down. Double-click a slide or press Enter to open it on the stage; Escape
  or G goes back.
- **Middle:** the current slide on a fixed stage (1920×1080 unless the deck has another slide
  size), scaled to fit. Arrow keys navigate through every slide, and the position under the
  slide ("3 / 20") is a field: click it, type a number, Enter. The row under the slide keeps
  the arrows in its middle whatever else shows: on the left **Find** and what is special about
  the slide (**Overflow**, which lists what runs past it, selects one and offers **Tidy
  layout…**; **Hidden** and **Locked**, toggles that turn the state off, with Undo), on the
  right the deck check and the zoom.
- **Speaker notes** sit under the slide, in View and in Edit: folded they are one line with how
  the notes begin; open, a Markdown field whose top edge drags to resize (arrow keys too,
  double-click for the usual height), with the slide's planned time beside them. Open or folded
  and the height are remembered; the notes save by themselves ("Saving… / Saved").
  The zoom is next to it: out, in (⌘- / ⌘+), and a menu with Fit (⌘0 or 0), 50%, 100% (⇧0) and 200%;
  ⇧2 zooms to the selection in Edit. Pinch or ⌘-scroll zooms; the mouse wheel scrolls (⇧: sideways)
  as far as the zoomed-in slide reaches, and with the whole slide in view moves nothing.
  A hidden or locked slide says so there, and the chip shows or unlocks it.
  The move button below it turns on edit mode: click an element to select it, drag it (or
  use the arrow keys, also with the focus in the app around the slide) to move it, double-click
  (or press Enter, or just start typing) to edit its text (Enter starts a new line, Escape or
  ⌘Enter finishes; ⌘Z while typing undoes the typing and its formatting step by step first). A
  double-click edits the text under the pointer, never a whole card around several texts, and on
  an image replaces it, Escape to select nothing (⇧Enter selects the
  parent; Escape never leaves edit mode, and in the middle of a drag it cancels the drag), Delete (or the trash button in the edit bar) to remove
  it, ⌘C / ⌘X / ⌘V to copy, cut and paste elements (also between slides), and ⌘Z / Ctrl+Z
  to undo (the deck's one history; see How it works). ⌘V also pastes images and text copied in other apps, like a browser. Pastes go
  on top of the slide without moving the layout: an element lands where it was copied from (on
  its own slide a step away from the original, so the copy shows), images and text under the
  pointer (or in the middle of the view), and Paste from the right-click menu where you clicked.
  Right-click an element for these actions, its stacking order, editing its text, copying and
  pasting its style, flipping, grouping and locking it, to ask the agent about it (about all of
  them, with several selected), or to have the agent tidy just an element you added; the menu
  shows only what applies. Right-click an empty spot to paste there, select everything, unlock
  what is locked or set the slide's background, and a locked element to unlock it (or click
  the lock at its corner). Every menu also lists what lies under the pointer and the
  selection's parent, to select instead. Shift-click adds to the selection; ⌘-click selects
  what lies under it, one deeper with each click. Dragging from an empty spot, on the slide or
  around it, selects what the box touches (with Alt, only what lies fully inside). A layout that
  fills the whole slide with a background of its own counts as the slide's background: clicks
  and drags on it work as on the empty slide, and ⌘-click, the menu or the Layers list select
  it. Several selected elements get one frame whose handles resize them together (Shift keeps
  the proportions, Alt resizes from the middle) or turn them together. Handles, frames and
  guides keep their size on screen at any zoom; besides edges and centers, moves snap to even
  spacing between elements.
  With ⌘ / Ctrl: ] and [ bring the selection forward and send it backward (with Shift, to the
  front and back), Alt+Shift+H / Alt+Shift+V flip it, Alt+L locks or unlocks it, Alt+C / Alt+V copy and
  paste its style, D duplicates it (after moving the copy, the next one goes as far again).
  Alt while dragging drags a copy instead, pressed or let go at any time.
  Lines and arrows have a point at each end instead of a box: drag one to move that end,
  drag the small handle on the line to add a point that curves it, and double-click a point
  in between to remove it.
  The edit ribbon above the slide groups its tools in captioned sections (Insert, Text,
  Paragraph, Style, Slide, Arrange, Timeline, and the canvas's options at its end), which
  collapse to their icon and caption, opening as a flyout, when the window gets narrow. With
  something selected the insert tools collapse first and the formatting stays open; with nothing
  selected the insert tools stay. A control that waits for a selection says in its tooltip what
  to select, tooltips name the keys that do the same, and a small caret marks a button that
  opens a panel or a menu. Insert is compact: Select, Text, a Shapes gallery, a Lines gallery
  (lines, arrows, freehand, elbow and curved connectors), an image from a file, and requests to
  the agent for a table, a chart or an icon (marked with a sparkle; the chat gets the start of
  the request, with the slide, for you to finish). A tool goes back to Select after adding one
  element; double-click it (or the format painter) to keep it for several, until Escape or V.
  Dragging out a shape or text box shows its size and snaps to the guides (Shift: even, Alt: from
  the center), a line shows its length and angle; the Text tool on text that is there types in it,
  and a new text box starts empty. On a dark slide new text and lines take white instead of the
  default black.
  The painter's look is the copied look too (⌥⌘C / ⌥⌘V paste it, on any slide). Style has fill,
  border or line color, a border width to type or pick, the dash drawn as samples, Effects
  (opacity, shadow, corner radius) and one slot for what is selected: Image (replace, fit,
  position, description), Line (heads drawn as samples, Swap ends, route) or Shape (corner
  radius, proportions). Arrange has Align (one element with the slide, several with each other,
  distribute, match sizes), Order, Rotate and flip (⌥⌘R turns 90°), "Position and size" (exact
  numbers, ↑ / ↓ step a number, with Shift by ten; 3D rotate folded away), Group / Ungroup, Lock,
  Duplicate and Layers. Canvas options hold Snap to guides (hold ⌘ / Ctrl while dragging for
  the opposite) and Stretch contents when resizing. With several elements selected, a value
  they do not share shows as mixed. The color wells stay open while you try colors, show the
  color under the pointer on the slide, offer the deck's colors with a lighter and a darker
  row, remember the colors picked last between launches, take a hex value, pick from the screen
  where the system allows, and tell no color from a mixed or gradient one. The slide's
  background well says when the slide has a gradient or image (a pick replaces it) and gives
  every slide the same background with "Apply to all slides" (one step to undo). It styles text:
  font (the deck's fonts and system fonts), weight (the weights the deck's font comes in), size
  (type one, pick one or "Deck default"; ⌘⇧. / ⌘⇧, step each text from its own size), color
  (or the deck's default), highlight, bold / italic / underline (⌘B / ⌘I / ⌘U), and in the
  text menu strikethrough (⌘⇧X), superscript, subscript and case, alignment (left, center, right, justified:
  ⌘⇧L / E / R / J), clearing the formatting, line height, letter spacing and the space before
  and after paragraphs (any value, or one of the usual ones), indents, bulleted and numbered
  lists and their bullet style (Enter starts a new item, Tab / Shift+Tab indent and outdent, Backspace at
  the start of an item or Enter on an empty one takes its bullet away), and links (⌘K) to
  web pages, email addresses or other slides. While typing, these apply to the selected words
  (a list, to the lines the selection is in, so plain lines and lists mix in one text);
  otherwise to the whole element. A text box or shape stays one element whatever its text
  holds: it is selected, moved and resized whole. A text box can shrink its text or grow to fit instead of
  overflowing. Pasting into text keeps bold, italic, links and line breaks (⌘⇧V pastes plain
  text, and on the slide makes a text box of it). **Find** (⌘F, or the Find button under the slide) is one bar over the top of the stage,
  the same in View and in Edit. It searches the text of all slides and their notes as you type:
  the slide list marks the slides that contain it and keeps every slide, the slide you pick
  highlights it, and its arrows (or Enter and ⇧Enter) go through the matches, from the last back
  to the first; a match in a slide's notes opens the notes under the slide. What is searched for
  stays when you switch between View and Edit. The button next to it replaces them (this match,
  those on this slide, or all: Enter and ⌘Enter in its field), leaving locked slides alone. Moved
  elements keep a temporary offset; **Tidy layout…** (in the ribbon's Slide section, beside
  **Change layout…**, both marked as asking the agent) then puts a request with a screenshot in
  the chat so the agent rebuilds the slide's layout around where you put things.
- **Changes:** for a deck kept with Git (in a git repository), the Changes tab shows what
  changed since the last saved version (the last commit), named and dated over the slide
  ("Since “First draft”, 2d ago"). Without a repository, or without `git` installed, there is no
  Changes tab. The slide list marks each slide with an icon in a corner of its thumbnail: a green
  plus for new, an orange pen for changed, a red trash can for removed and a blue arrow for moved
  (with the number it used to have). A slide that was edited and moved shows both, and removed
  slides stay in the list where they used to be (the filter button leaves out the slides that
  did not change). Click a changed slide to compare its two versions: **Split** shows both,
  labelled Before and After, **Before** and **After** one of them. In the split view, drag
  across the slide to move the divider and drag its round handle to rotate it (Shift for steps
  of 15°; a double click puts it back). Hold Space, or press and hold the slide or the flip
  button, to see the other version in place. Under the slide, **Text changes** lists each text
  that changed, on the slide, in its speaker notes and in its narration, before and after, with
  the changed words struck out and highlighted. Slides show the images of their own version.
  A checkbox in the corner of each changed thumbnail, **Include in this version**, picks that
  change for the next version (git stages it); with nothing ticked a version takes everything.
  The slide picked has its actions beside its caption: the same checkbox, and a button that puts
  it back as the last version had it, named by what that does: **Discard changes**, **Discard new
  slide**, **Bring back** (a removed slide) or **Undo move**, so a slide's edit and its move go
  separately. A change to the deck's shared styles (CSS, fonts, anything outside the slides) gets
  a row of its own at the top of the list, and its actions are above the slide. A discard says
  what it did, with **Undo** in the message (and ⌘Z); images it put back with it are named, as
  undo does not bring files back. Over the list, the message of the next version starts as a
  suggestion made from what changed ("Change 3 slides, add 1"), selected so typing replaces it;
  **Save version** never waits for one. **Include All / None** tick or clear everything, and
  **Discard all…** puts the whole deck back as in the last version, after asking. The branch is
  shown small under the button ("Not on a branch" warns when none is checked out). With nothing
  changed there is just "No changes since the last version". A deck with no saved version yet
  shows its slides plain, with one explanation and **Save first version**.
- **Right:** chat with the agent. Every deck has a chat of its own, which comes on show with
  the deck; with no deck open, the chat is the folder's own (say, to have a deck made, which
  that chat then moves to). The agent works in the open folder either way, so it can read the
  other decks and files in it. Past chats lists the chats of every deck in the folder, those
  about the open deck first: picking a deck's opens that deck, and picking any other goes on
  with it here; each can be renamed (pencil) or deleted (trash, after asking; not the chat on
  show), and the header names the chat on show. What you are writing stays with its chat: a new
  chat, a past chat or another deck does not throw it away. Leaving a deck while
  the agent works on it asks whether to stop the agent first. It knows which slide you're on (or
  which slides you picked in the rail), `@` in the message box refers to another slide or a file
  of the folder, and you can attach images and other files (paperclip, paste, or drop files
  anywhere on the window); removing an attachment before sending deletes the file it saved,
  unless a deck uses it. A message sent while one is still being saved waits for it, and a sent
  message shows its images, which open larger. An empty chat suggests what to ask. While the
  agent replies, the steps it finished fold into one line ("Edited 3 slides, read 2 files") and
  the last line says what it is doing ("Editing deck.html…") and for how long; unfolded, a step
  that edited a file shows a before and after. A finished reply says which slides its turn
  changed, added or removed, each a link to the slide, and the newest offers **Undo changes**
  while they are the deck's newest change. An error says what happened and what to do (Retry,
  Compact the chat, sign in, choose another model), the agent's own words behind Details. The
  pencil under a message of yours edits it: it comes back into the message box with its slide
  and attachments, and sending it takes the chat (and the agent's conversation) back to before
  it, undoing its turn's deck changes when they are the newest. Effort and context window say
  what each choice trades; how full the chat is shows from 60% on, with Compact, and that menu
  also gives the chat's cost at API prices (not a bill on a subscription plan). Links in replies
  open in your browser, in the app for a file of the folder, or go to the slide for `#slide-id`. ⌘L goes to
  the message box from anywhere, the up arrow in the empty box brings back the last message, and
  Esc there stops the agent. When the agent needs an approval or finishes while you are in
  another app, the app asks for your attention (the Dock icon bounces, the taskbar button
  lights up). The microphone button dictates: click to
  start, and what you say shows up at the cursor as you speak; click again to keep it (Esc
  discards it). On macOS the first use asks for microphone access (when running from a
  terminal or editor, macOS asks for that app instead). Speech is
  transcribed on your computer with [Whisper](https://github.com/ggml-org/whisper.cpp) (small,
  multilingual); its model (190 MB) is downloaded on first use to `~/.slopslides/models`.
- **Folders:** the start screen starts a deck in the library from what it is about (that
  text becomes the first message to the agent, and names the deck unless a title is typed; the
  style is picked from pictures or left to the agent), opens a deck (⌘O) or a folder (⇧⌘O), or
  imports a PowerPoint file; a folder, a deck or a PowerPoint file dropped on it opens the same
  way. A deck opened by itself opens in the library when it is one of its decks, in a folder
  opened before that holds it, or else in the folder around its own (`<name>/deck.html`), so
  new decks never land among its assets. **Your decks** shows the library's decks and the ones
  opened before as pictures of their first slides, the newest first, with a field to find one
  once there are many; a card's menu (its **…** or a right-click) opens, renames, duplicates,
  reveals it, takes it off the recent ones or moves it to the system's Trash (after asking; it
  can be put back from there). **Recent folders** lists the folders opened before. On a first
  start it says whether an agent CLI is installed (and how to get one), and offers **Open an
  example deck**. The app's settings and the shortcuts are at its top right. In a folder, the
  menu on the deck's title at the top left (a double-click on the title renames it in place)
  starts, opens or imports a deck and opens a new window, has what is done to the deck
  (**Rename…**, **Deck settings…**, **Duplicate deck**, **Reveal in sidebar**, **Show in
  Finder**, **Move deck to Trash…**, **Close deck**) and to the folder (**Close folder**, back
  to the start screen). The top bar says **Saved** (or **Saving…** while a write takes its
  time); ⌘S says that everything is saved. Short of room, it drops its labels first, then the
  folder over the title and the mode tabs' names, and the title shortens: nothing overlaps. The Files tab of the sidebar is the folder as a tree: a deck's folder is one row
  named by the deck's title (a click opens the deck, its arrow shows the deck's own files), the
  arrow keys go through it, F2 renames a row in place, and the field above it finds files by
  name and decks by title anywhere in the folder. A right-click on a row opens it, adds it to
  the chat's next message, renames it, makes a folder in it, reveals it, copies its path or
  moves it to the system's Trash (after asking; it can be put back from there), and imports a
  PowerPoint file. Its header starts a deck or a folder. Images, PDFs and text files open as a
  preview; anything else opens in its own app (**Open in default app**). Nothing is renamed or
  trashed outside the folder, nor while a window has that deck open.
- **Windows:** File › New Window (⌘N; Ctrl+N on Windows and Linux) opens another window,
  each with a folder and a deck of its own. Two windows can have the same folder open, each
  with another of its decks, and the agent can work on both decks at once; a deck is open in
  one window at a time, and so is a folder with no deck open. On macOS, a double-click on the app in
  Finder or New Window in its Dock menu (right-click the icon) opens another window too, while
  a click on the Dock icon only brings the app back. A folder
  dropped on the app's icon or opened with it from Finder (Open With) opens in a window: one
  on the start screen, else a new one. A folder already open without a deck in one window is
  brought to the front instead of opening twice. Elements and whole slides copied in one
  window paste into another; the images they show are copied into the receiving deck's
  `assets/`. A pasted element keeps its size and text look, but styles that come from the
  other deck's CSS (its classes, its theme) do not come along.
  A window is named after what is open in it (the deck and its folder), and asks before it
  closes over unsaved code edits (**Save**, **Don't save** or **Cancel**, as when the deck
  closes), a drawing with changes not accepted, or the agent's running turn.
- **Keyboard:** `?` (or ⌘/, Ctrl+/ on Windows and Linux) lists every shortcut, by where it works:
  the slides, View, Edit, text, the chat, presenting, the code and drawing editors, those of the
  mode the deck is in first; its search field finds a shortcut by key or by what it does. Tooltips
  show after a moment under the pointer, at once when moving along a toolbar or tabbing to a
  button, and go away on a press, a key or scrolling. They name a
  button's shortcut as the system writes it (⌘Z on macOS, Ctrl+Z elsewhere), also on a button
  that is off, where the tooltip says what it waits for. Escape closes what opened last, one
  thing at a time: a menu, a popover, a dialog, then a message; in a field it first does what
  the field does with it. That holds with the focus in the slide too, and a press in the slide
  closes what is open in the app. Menus take the arrow keys, Home and End, and so do tabs;
  a dialog keeps Tab and the keys inside it and gives the focus back when it closes.
  ⌘1, ⌘2 and ⌘3 go to View, Edit and Changes; ⌘\ shows or hides the sidebar and ⇧⌘\ the slide
  list; ⌘, opens the app's settings; ⌘W closes the deck (with nothing open, the window) and ⇧⌘W
  the window (Ctrl on Windows and Linux). The keyboard button at the bottom of the sidebar (at
  the top bar's right end while the sidebar is hidden) opens the list too.
- **Command palette:** ⇧⌘P (Ctrl+Shift+P on Windows and Linux) finds any command by part of its
  name or its menu's ("zoom", "arrange group"), with its keys, those used last first; Enter runs
  it. A command that cannot run just now is greyed, saying why ("Select something on the slide
  first"). A number goes to that slide.
- **Menu bar:** every command is in the menu bar too, under File, Edit, View, Insert, Format,
  Arrange, Slide, Present, Window and Help (on macOS after the app's menu, with About, Settings…
  ⌘, , Hide and Quit; on Windows and Linux each window has the menus, with Settings… and Exit at
  the end of File and About in Help). Its items are greyed while they cannot run and checked
  while on (the sidebar, the slide list, a hidden slide), as the window with the focus has it.
  Edit › Undo and Redo undo the deck's last change, or the typing in a text field while one has
  the focus; Cut, Copy, Paste and Select All are the system's. Help › Command palette… and
  Keyboard shortcuts… open the two lists. The menu bar, the palette and the shortcut list are
  made from one table of the app's commands (`src/lib/commands.json`), so they always agree. A
  key works the same with the focus anywhere, and runs its command once: the menu bar on macOS
  shows the keys, and Windows and Linux write them beside each item.
- **Settings:** **App settings…** (the gear at the bottom of the sidebar, or at the top bar's
  right end while the sidebar is hidden, ⌘,) open in a dialog and are the app's, for every deck:
  its appearance and interface text size (Small, Default, Large), what undoing an agent's
  changes does to the chat, where the library is, and the app's version. **Deck settings…** (the file menu) are the open deck's,
  in a dialog over it: its title and style take effect at once, the slide size with **Apply**;
  closing with a size not applied asks whether to apply it.
- **Sidebar:** its tabs are a fixed set of panels: Chat and Files always, Narration and Code
  (the deck's HTML and CSS) while a deck is open, and Drawing while a drawing from a slide is
  edited, which closes with its × or a middle click. When their names do not all fit, the tab
  showing keeps its name and the others show their icon. Its toggle (⌘\) carries a mark while
  the chat is out of sight and the agent works (a spinner) or waits for an approval (a dot),
  and so does the Chat tab.
- **Messages:** what goes wrong shows at the bottom centre of the slide's area, clear of the
  sidebar, and stays until dismissed. It says what was being done and what happened ("Could not
  open the library: …"), with Retry where trying again can help; a service's raw answer is never
  the message itself but waits behind **Details**, with **Copy details**. What is only worth
  knowing (what an import changed, a file the agent made, with a button to open it) goes away
  after a few seconds, unless the pointer is on it. Up to three show at once. During a slide
  show only messages about the show appear; the rest wait for it to end.
- **Questions:** what cannot be undone is asked about in the app's own dialog (the safe answer
  has the focus when the other deletes something); what the deck's history can undo is done,
  with Undo in a message. Unsaved changes in the HTML tab are asked about in the system's order:
  on macOS Don't save at the left, Cancel and Save at the right.
- **When something breaks:** a part of the window that fails to show (the slide list, the slide,
  the sidebar, the top bar) says so in its place, with **Reload this part** and **Copy details**;
  the rest of the app keeps working.
- **Layout:** the widths given to the slide list and the sidebar are remembered for the next
  launch; double-clicking the line beside one gives it its first width back.
- **Appearance:** the app follows the system's light or dark appearance, native controls and
  scrollbars included, unless App settings › Appearance says Light or Dark, and its request for reduced motion: nothing in the app then slides,
  fades or spins, and lists jump instead of scrolling. A slide's own animations are the deck's.
- **Styles and layouts:** decks can follow a template, a deck of example layouts (title,
  section, bullets, split, stats, quote, closing) in one style, with its own entrance animation. 31 come
  with the app (Claymorphism, Swiss Design, Synthwave, Terminal Green, Wabi-Sabi, …); add your own as folders in
  `~/.slopslides/templates/<name>/deck.html`. Pick a style when creating a deck or in the
  deck's settings (it puts a restyle request in the chat, and says so; an empty deck
  takes it at once); the same page has **Save deck as template**, which copies the deck there
  with its text replaced by placeholder words. The rail's `+` shows a blank slide and every
  layout of the deck's style as thumbnails and adds the one you click; **Layout** below the
  slide asks the agent to rebuild the current slide on a layout.
- **Slide size:** the deck's settings set every slide's canvas: landscape,
  portrait or square, a width and height in px, in or cm (96 px per inch), or a common size
  (16:9, 4:3, 4:5, 9:16, A4, US Letter). It is stored in deck.html as
  `<meta name="slopslide-size" content="1080x1350">`; for a deck with slides it puts a
  message in the chat asking the agent to lay them out again for the new size.
- **Present:** full-screen slideshow from the selected slide (⌘↵ / Ctrl+Enter) or, from the
  menu beside the button, from the beginning (⇧⌘↵ / Ctrl+Shift+Enter). **Present in windows** in
  that menu is a choice that stays on until unticked: both starts and both keys then put the
  slides in this window (to share in a call) and the presenter view in a window of its own. The
  keys are the player's (see Export), plus the tools': `L` laser, `P` pen, `H` highlighter, `E`
  eraser (each again puts it away), `C` clears the slide's ink and ⌘Z / ⇧⌘Z undo and redo any
  change to it, clearing and erasing included; `0` fits the slide again, `G` shows all slides to
  go to one, `K` plays or pauses, `N` opens the presenter view, `[` / `]` scroll its notes, `?`
  lists the keys, and `Esc` steps back one thing at a time: the tool, the zoom, a blank screen,
  then the show. A number typed is shown with where it goes, numbered as the slide list numbers
  the slides (a hidden one stands for the next one shown). After the last slide the screen says
  **End of show**; going on from there ends it. One bar at the bottom holds the tools (undo,
  redo and clear only while there is ink or a tool that makes it), previous and next around the
  slide's number (which opens all slides), Play and **End show**; it comes with any move of the
  pointer and goes, with the cursor, after it rests, a picked tool or not (a small mark then
  shows the pen, highlighter or eraser). Small labels over the slide say when the screen is
  blank and when the show plays by itself. A web link on a slide opens in the browser while the
  show goes on; the editor behind the show is out of reach of Tab, the display does not go to
  sleep during a show, and a change to the deck meanwhile reloads nothing in front of the
  audience. With
  several screens attached, a picker shows them as they are arranged, each with a screenshot
  of what is on it (on macOS this needs the Screen Recording permission; without it the picker
  shows the arrangement alone, as it does on Linux), to choose where the slides and the
  presenter view go; each screen says what it shows, **Swap** exchanges the two, and the choice
  is remembered for those screens (the first time, the slides go on a screen that is not the
  main one). When such a show ends, the editor goes back to the screen and place it came from.
  The presenter view groups its controls under Timer, Slides, Narration and Notes. It shows the
  time since the show started (which starts on the first move on, or with its Start button;
  pause and resume it there), the time on the slide, both amber as they run short and red once
  over, the time of day, which slide is on screen (pressed, all slides), the notes at a size you
  pick and the next slide, which a press goes to; **Timer settings** holds the total time and
  the time per slide to count down against, and **Restart the timer**. In a window of its own it
  also has Previous, Next, **Black screen**, Play and End show, covers the slide on screen while
  the audience's is blank, shows all slides there (`G`), and the keys pressed there work as in
  the show. After a show that went through every slide, a message offers **Use these timings as
  slide times**, which sets each slide's planned time to the time it was on screen. Its clocks, the teleprompter and a recording go on while
  the panel beside the slide is closed; a pill over the slide then says the microphone is on.
  The teleprompter button in the presenter view (N) listens to you and follows you through the
  slide's narration, or its notes when it has none: what you said fades and the text scrolls
  along, even when you paraphrase or jump to another part. Words you jump over stay as they
  are. It moves the script only; you still change the slides. Speech stays on your computer,
  transcribed with the same Whisper model as dictation.
  Two more buttons there record the narration while you talk through the deck. **Record text** adds
  what you say to the narration of the slide on screen; **Record audio** starts after a 3-2-1
  countdown and makes your voice each slide's narration audio, in place of an earlier recording
  of that slide (coming back to a slide in the same recording adds to it), which then plays in
  place of the generated speech (in the show and in videos) until you delete it in the sidebar's
  Narration tab. Going back to a slide while recording text starts a new paragraph. The raw text
  keeps every stutter; **Polish wording…** in the Narration tab (for one slide, or all of them under
  Whole deck) puts a request in the chat for the agent to turn it into clean, fluent
  sentences. Text needs the Whisper model, and nothing is kept for locked slides. The
  microphone does one thing at a time: teleprompter, text or audio.
- **PowerPoint:** **Import PowerPoint…** turns a `.pptx` into a new deck: slides, layouts and
  themes, text, images, shapes, tables, speaker notes, sections and hidden slides. The deck is
  HTML from then on; the file itself is left as it is and never written back. Animations and
  transitions are dropped, charts arrive as tables of their data, and EMF/WMF images are left
  out. While it runs it says which slide it reads ("Reading slide 4 of 20"), from wherever it was
  started; then a report lists what did not come along as it was, by slide (a slide's number goes
  to it), with the fonts the file uses that this computer lacks. **View import report** in the
  toast after it brings it back while the deck is open. The **PowerPoint** export writes a new `.pptx` of native, editable
  shapes and text, with notes and sections. Transparency, linear gradients and shadows stay
  PowerPoint's own effects; an inline SVG (and a shape drawn with the editor) becomes a group of
  freeform shapes, lines with their arrowheads, and text boxes; backdrop blur is dropped;
  whatever PowerPoint cannot draw (filters, masks, 3D, canvases, an SVG that uses filters,
  masks, clips, patterns, radial gradients or pictures, or comes from an image file) becomes a
  transparent picture. Web fonts are not embedded, so install them
  where the file is opened. The toast that says it is saved has **Details**: what the file did
  not keep (pictures, fonts not stored in it, animations, narration audio), slide by slide.
- **Export:** the top bar's Export menu offers **PDF**, **PowerPoint**, **Web page (HTML)**,
  **Images** and **Video**. Each opens the same dialog: which slides (all, the current one, or a
  range by their numbers), **Include hidden slides** (off by default for every format), the
  format's own options and a line saying what will be saved; the choices are remembered per
  format. While an export runs the Export button shows how far it has got ("PDF 4/20"), and its
  menu lists each running export with Cancel, which leaves no file behind, above the formats, so
  another export can start meanwhile (one video at a time). The **web page** is one
  self-contained HTML file (attached images embedded) that plays in any browser: →/↓, Space, Page Down, Enter or `N` (or a click) for the next slide,
  ←/↑, Page Up, Backspace, Shift+Space or `P` for the previous one, Home/End, a number then
  Enter for that slide (shown as it is typed), `B` (or `.`) and `W` to blank the screen to black
  or white, `O` for all slides at once, `K` to play by itself or pause, `F` for full screen, `R`
  for review marks and `?` for the list of keys (with a button to print or save as PDF); none of
  them with ⌘, Ctrl or Alt held, which stay the browser's. A click goes on; on a touch screen a
  sideways swipe does too and a tap in the left quarter goes back, while a pinch or a second
  finger changes nothing. A small strip of controls (previous, "3 / 12", next, all slides, full
  screen, keys; larger on a touch screen) shows while the pointer moves, after a touch or on
  Tab. `?autoplay` in the address plays the deck by itself, each slide for its timeline time
  (`data-duration`) or 5 seconds (`?autoplay=8` for 8), and `?loop` starts over after the last
  slide, for a kiosk or a booth screen. In full screen or while it plays, the display is kept
  awake where the browser allows. A screen reader hears "Slide 3 of 12" and the slide's heading
  as each slide shows, and the page's title names the slide. A phone held upright is told once
  that sideways shows more. `#slide-id` links, print to PDF. Speaker notes, narration scripts,
  review marks and comments stay out of the web page unless ticked (they are taken out of the
  exported copy; the deck file is never changed), and hidden slides it holds stay hidden. It has
  no narration audio: a video has. The app's own show never shows review marks. **Images** are a
  PNG or JPEG of each slide at the slide size or twice it, several in a new folder named after
  the deck, one slide to a file of its own; they are captured in a hidden window, so the app
  stays usable. Every export ends with a message that the file is saved, with a button to show
  it in its folder. The PDF has one page per slide, or with **Speaker notes** a page of notes
  after each slide that has them, sized to the slide canvas, each slide as
  it looks once its animations finish, with real, selectable text: the system webview prints
  the deck straight to the file. On Windows and Linux everything in it is vector. macOS
  WebKit cannot print transparency, so there each slide's decor (backgrounds, shapes, images)
  goes in as one image under the text. A **video** export saves an MP4 (AV1 video and Opus
  audio, royalty-free; the dialog says where it plays) at the slide size, 720p, 1080p or 4K, 24, 30
  or 60 fps, with each slide on screen for a set
  number of seconds. Entrance animations, slide fades and hero morphs play as they do when presenting,
  or each slide can be a still of its final frame. The deck plays in a hidden window whose
  animations follow the video's clock, so every frame is exact however long capturing it takes.
  With **Speak narration**, each slide's narration is said over it (an Opus audio track) after
  a short pause, and the slide stays until the narration and a pause after it end; the set
  seconds become the least a slide is shown. Slides timed on the narration timeline keep to
  that instead. The times are the deck's own (see **Timing** on the timeline), shown in the dialog
  with a button to change them; narration still to be spoken is said first, which the dialog says on
  a line of its own with how many characters go to the service. **Captions** writes the narration
  as subtitles beside the video (`.srt` or `.vtt`), timed by its words where they are synced.
  While the video is made, the Export menu says about how long it still takes.
- **View ribbon:** View mode's tools sit in a ribbon like the edit tools', in sections that
  collapse to an icon when the window gets narrow: Mark up, Review, Animations, Slide and Timeline. Under
  Animations, a choice of **Animated** (slides play their animations whenever they are shown)
  or **Final state** (every slide as it ends up, as the slide list shows it), and **Replay
  animations** plays the current slide's animations again.
- **Marks and comments:** the View ribbon has a pen, a highlighter and an eraser for
  marking up the slide, and the comment tool: click an element (or the slide) and write what
  should change. In Edit, **Add comment…** in the slide's right-click menu does the same where
  you clicked. Comments show as numbered pins that follow their element; click a pin to change
  or delete it. **Comments** in the ribbon lists every comment of the deck by slide: press one to
  go to it, tick which go out with your next message, delete one, and **Send N to the agent…**
  to write that message. Marks and comments are saved in the deck file and can be hidden together. The
  composer attaches the ticked comments to your next message, either this slide's or all slides'.
  Each goes out once: a sent comment stays on its slide with a hollow pin, marked **Sent** in the
  list, until you resolve it (one by one, or **Resolve all sent**); change it, or **Send again**,
  to send it once more.
- **Notes and narration in Markdown:** both are written in Markdown, with a preview in their
  panels; the presenter view shows them formatted and narration is spoken without the marks.
- **Narration:** the sidebar's Narration tab holds what is said over each slide. It is spoken
  by a hosted text-to-speech service, OpenAI (the default) or ElevenLabs, with your own API key
  (entered under Voice in the tab, or `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` in the environment), in the
  voice, one of ten languages, a pace (slower, normal, faster) and, for OpenAI, a style note chosen
  per deck, summed up in one line under **Whole deck** with **Change** to open them; the speaker
  button beside a voice plays a short sample, said once with your key and kept in
  `~/.slopslides/voice-previews`. Each slide's audio is
  `narration/<slide id>.wav` next to the deck; a slide whose narration, voice, language, pace or
  style changed is marked "Script or voice changed" with **Update audio**, the rest are never spoken again.
  **Record** beside Generate records your own voice for the slide after a countdown, with a level
  meter and the time; **Record again** replaces the take, **Delete recording** brings the generated
  voice back. A slide without a script but with speaker notes offers **Use speaker notes as
  script**, and the whole deck **Use speaker notes for N empty scripts**. **Generate all** says
  first how many slides, characters and about how much audio it sends. **Every slide** lists each
  slide's script and audio state, a press going to the slide. The tab shows the slide's audio as a waveform above its text, with each word where it is said once the words are synced to the audio (**Sync words to audio**, which offers the speech model's download with its size first, shows its progress and can be cancelled): press it to play from there; Play pauses and plays on. When presenting, the play button in the
  bar runs the show by itself, always speaking each slide's narration, on the timeline's
  timing. The timeline under the slide (Timeline in the ribbon, in View and in Edit) shows the slides above the audio. In Edit, drag the end of a
  slide to change how long it shows, and the slides after it follow, each narration keeping
  its place in its slide. Drag a narration to move it, up to the narration on either side, so
  it can run over into the next slide, with the slide changing mid-sentence; video
  exports and the self-running show follow it, and the slide keeps its timing in the deck
  (`data-duration`, `data-narration-start`). Drags snap to where narration ends, where slides
  change and to the playhead, a line showing where (Alt: no snapping); a slide timed by hand has a
  pin, and double-clicking its handle (or Delete on it) lets it follow its narration again.
  **Timing…** in its bar sets how long a slide without narration shows and the pauses around narration, kept with the deck in `narration/manifest.json` (a deck that never set them starts from this computer's last ones), the same times a video export and the show's Play use. Back to start, play, pause, the step buttons (a tenth of a second; a second with Shift) and the playback speed (1×, 1.5×, 2×) are in the middle of its bar; with the focus in the timeline Space, ←/→, Home/End and J/K/L (back a second, pause, play and faster) do the same, and Space plays and pauses from anywhere but a field, a button or the slide. The zoom readout between Zoom timeline out and in fits the timeline again; ⌘/Ctrl-scroll and pinch zoom around the pointer. The timeline's top edge drags it taller or lower, remembered. Pressing a slide moves the playhead to where it starts; pressing a narration goes to its slide and start, and double-clicking it opens its script. Paused, stepped or with the playhead moved on the ruler, the slide is frozen as it is at that moment, its animations that far in (in View; in Edit the slide stays the editor's, and only playing takes it). A comment made in View while the slide is held so is about that moment: it is marked on the timeline's ruler, where pressing the mark goes back to it, and the agent is told how many seconds into the slide it is.

Built with Tauri 2 (Rust) and React. It runs on macOS, Windows, and Linux.

## Requirements

- An installed, signed-in agent CLI: [Claude Code](https://claude.com/claude-code),
  [OpenAI Codex](https://developers.openai.com/codex/cli), or GitHub Copilot. Select its
  model in the chat composer. To use a binary outside your PATH, set
  `SLOPSLIDE_CLAUDE_PATH`, `SLOPSLIDE_CODEX_PATH`, or `SLOPSLIDE_COPILOT_PATH`.
- For development: Node 22+, pnpm, Rust (stable), CMake (to build whisper.cpp and libopus),
  and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS; on
  Linux also `libasound2-dev` for the microphone.

## Development

On **Windows x64**, install the [Windows prerequisites](docs/windows-build.md)
once, then use PowerShell from the checkout:

```powershell
./start.ps1                 # set up native dependencies, then start dev mode
./start.ps1 -Mode release   # build and launch an optimized executable
./start.ps1 -Mode build     # build Windows installers
```

The launcher detects Visual Studio/LLVM/CMake and Rust;
`-Mode browser` previews the UI without native tools. Setup runs in the current
process and does not install system tools or change your permanent PATH.

On **macOS/Linux**, or in an already configured build environment:

```sh
pnpm install
pnpm app:dev        # desktop app with hot reload
pnpm app:build      # installers for the current OS → src-tauri/target/release/bundle
```

`pnpm dev` alone serves the UI at http://localhost:1420 in a plain browser, with mocked IPC
and read-only access to your deck library (`dev/browserPreview.ts`). This is handy for
UI work. Chat and editing need the desktop app.

Run `./check.sh` for Biome linting/formatting, typechecking, frontend tests/build, Rust
formatting, clippy, Rust tests, and dependency audits (`pnpm audit`, `cargo audit`); run
`./check.sh --fix` to format and autofix first. Every tool comes from `package.json` or
`src-tauri/Cargo.toml`, except `cargo-audit`, which the script installs on first run. CI runs this same script on macOS, Linux, and Windows, including approval
routing and cancellation tests against a mock Codex app-server built into the Rust test
binary. The full chat approval flow is tested through events, the store, UI, IPC
responses, and transcript persistence.

Biome enables the recommended accessibility rules and `noNoninteractiveElementInteractions`.
`noAutofocus` is disabled because desktop dialogs, rename fields, and model pickers
intentionally focus their input when opened. Scoped suppressions explain supplemental
mouse shortcuts and iframe load handlers.

The Rust tests also validate every request and approval response we send to Codex against
protocol schemas pinned from Codex **0.147.0** (the tested baseline) in
`fixtures/codex-schemas/`. This catches protocol drift, including changes to MCP approval
shapes, without an account, credentials, or model inference. To check a newer Codex
release, run `scripts/update-codex-schemas.sh <version>` and then `./check.sh`. Live
behavior tests below remain opt-in; schema validation cannot detect every behavioral
change in an external CLI.

The row under the slide checks the open deck file (its HTML lint) and says **No problems** (a
click checks again and says what came of it) or how many problems there are; clicking that lists
them by slide number: a row goes to its slide, and its code button opens the line in the
sidebar's code. **Fix the problems…** puts fix instructions into the chat composer (the agent
then fixes the issues and re-checks with its `lint_deck` tool), and **Check again**. A check
that could not run says so and is tried again with a click.

## Permissions

The composer shows a permissions picker for every agent. Each agent remembers its own mode:

- **Ask for approval** (default): the agent reads and edits files in the workspace, fetches
  web pages, and uses SlopSlide's own tools (`lint_deck`, `open_file`, `render_slide`) without
  asking.
  Shell commands, files outside the workspace, and other tools ask first. (Codex runs
  commands inside its workspace sandbox and asks for anything beyond it.)
- **Approve for me** (Codex only): the same workspace boundary, with Codex's automatic
  reviewer handling eligible approval requests. Automatic reviews can consume additional
  subscription usage.
- **Full access**: no sandbox or approval prompts. Selecting it requires confirmation.
- **Custom** (Codex only): use the current Codex configuration, including sandbox, approval
  policy, and reviewer.

SlopSlide's own MCP tools never ask in any mode. The selection is remembered locally and
can change while the agent works: Claude Code and GitHub Copilot apply it to the requests that
follow, and switching to Full access also allows the requests waiting in chat. Codex fixes its
sandbox and approval policy when a turn starts, so it applies a change from the next message.
It is reapplied when resuming a conversation and never modifies
the agent's own configuration (`~/.codex/config.toml`, Claude Code settings). Codex modes
unavailable in the installed CLI or disallowed by managed requirements are omitted; Codex
remains responsible for enforcing the effective policy.

Requests appear in chat with the command, proposed file changes, network destination, or
requested permissions; scrolled away from one, the button that jumps down says **Approval
needed**. Choose **Allow once** or **Deny** (Esc on the card), or **Stop** to end the turn;
**Always allow in this chat** is shown when the agent offers it, with a line saying what it
covers (Claude Code's session rules are kept for the session only, never saved to settings).
Answered, a request folds to one line that says how ("Allowed once: Run a command"), also when
the chat is opened again. Codex's additional permission grants are limited to the current
turn. Automatic reviews show their status and rationale. Requests close when their turn ends.
Leaving a deck stops its active turn and saves the interrupted transcript, so an approval
cannot remain waiting in a hidden deck.
Codex MCP tool approval confirmations use the same cards. Structured input forms, URL
authentication, and device verification are not supported yet and receive an explicit error
instead of being automatically approved.

Codex chat uses `codex app-server` with your existing CLI login. ChatGPT sign-in uses your
subscription; API-key sign-in uses API billing. Update an older CLI with `codex update` if
permission discovery fails. Claude and Copilot retain their existing permission behavior.

Checks include an offline mock app-server. An optional live test makes two tiny inference
requests, verifies streaming and resume, and requests no file changes:

```sh
cargo test --manifest-path src-tauri/Cargo.toml real_codex_smoke_test -- --ignored
```

To inspect the installed server's effective permission presets without model inference:

```sh
cargo test --manifest-path src-tauri/Cargo.toml real_codex_permission_modes_test -- --ignored
```

The live MCP regression test approves only `slopslide/lint_deck` on a temporary deck
and makes one model request:

```sh
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml real_codex_lint_approval_test -- --ignored
```

## Releases

Push a tag such as `v0.1.0`. `.github/workflows/release.yml` then builds macOS (Apple
Silicon), Windows (MSI/NSIS), and Linux (AppImage/deb/rpm) installers into a
draft GitHub release. Code signing and notarization secrets are listed in the workflow.

To build a signed and notarized macOS app and DMG locally, copy
`scripts/signing.env.example` to `.signing.env` (git-ignored), fill in your certificate and
notarization credentials, then run `scripts/build-signed.sh` (`--no-notarize` to only sign,
`--check` to validate the settings without building). Signing uses the hardened runtime with `src-tauri/Entitlements.plist`, which grants
the microphone for dictation.

## How it works

```
src/                    React UI (Zustand store, Tailwind)
src-tauri/src/
  deck.rs               deck folders: load/normalize, slide operations, export
  history.rs            each deck's undo history: whole-file versions of every change
                        (edits, rail, review, narration, code view, agent, other apps)
  rewind.rs             takes an agent's conversation back to before a message
  sessions.rs           chat sessions in `~/.slopslides/sessions`, each tied to one deck (or folder)
  html.rs               finds the slide <section>s in deck.html and rewrites them;
                        installs the player runtime (assets/runtime.{css,js})
  size.rs               the deck's slide size (`slopslide-size` meta) and the stage CSS for it
  templates.rs          built-in and user templates (`~/.slopslides/templates`): listing,
                        new decks in a template's style, saving a deck as a template
  comments.rs           the user's comments on slide elements, in a managed block in deck.html
  find.rs               find and replace in the text on a deck's slides (never markup)
  lint.rs               HTML lint for deck.html: well-formed markup plus the deck format
                        rules; shown as the status button in the row under the slide
  mcp.rs                stdio MCP server (`slopslide --lint-mcp [workspace] [session]`) exposing the
                        linter to the agent as its `lint_deck` tool, and `render_slide`
  render.rs             renders slides in a hidden window for `render_slide`, answering
                        the MCP server through the session folder
  agent.rs              manages turns; normalizes provider events for the UI
  extensions.rs         the user's MCP servers, skills, plugins and AGENTS.md, passed to
                        every provider (see below)
  codex.rs              Codex app-server transport, permissions, and approval responses
  protocol.rs           `slop://` scheme serving deck files to the slide iframes;
                        adds the slide editor (assets/editor/) for edit mode
  video.rs              MP4 export: plays the deck frame by frame in a hidden window
                        (assets/video.js) and encodes it as AV1 with rav1e
  export_scope.rs       which slides an export holds, and the web page without the author's
                        notes, narration scripts and review marks (on the exported copy only)
  export_job.rs         an export's progress ("slide 4 of 20") and its Cancel
  slide_images.rs       PNG or JPEG slide images, captured in a hidden window
  mp4.rs                the MP4 file video.rs writes: one AV1 track, held frames stored
                        once, and an Opus track for narration
  narration/            spoken narration: each deck's audio (`narration/` next to it) and
                        when it is out of date; cloud.rs has OpenAI or ElevenLabs say it
  watcher.rs            file watcher → `deck-changed` events, so edits stream into the UI
src-tauri/prompts/      the agent's system prompt and design references, compiled into the
                        app and injected into every session
src-tauri/templates/    the built-in templates, one deck.html each (served with the runtime)
```

Each deck is a plain folder under `~/Documents/SlopSlide/<deck>/`:

```
deck.html        the whole presentation: <section class="slide" id="…"> per slide,
                 optional <div class="deck-section" data-title="…"> markers between them
                 that start a section, shared styles, the embedded player runtime, and
                 optionally <meta name="slopslide-template" content="…"> naming its template
assets/          attached images and media (inlined on export)
```

Nothing else, so a deck folder can be shared or committed as it is. The app keeps
everything else in `~/.slopslides/`:

```
templates/<name>/          user templates
history/<key>/             one deck's undo history: journal.json and each version
                           of its HTML (assets are not kept), the newest 100
sessions/<session id>/     one chat about a deck, or about a folder: meta.json (the
                           deck file or the folder), chat.json, each provider's session id,
                           rewind.json, sketches/, templates staged for the agent,
                           and Claude Code's generated mcp.json and claude-plugins/
thumbnails/<key>.png       pictures of slides for the lists of slides (derived from the
                           decks, kept to 256 MB; safe to delete)
recent-workspaces.json     the folders opened last, for the start screen
recent-decks.json          the decks opened last, each with the folder it was open in
system-prompt.md           the system prompt file Claude Code reads
mcp.json                   your MCP servers, for every agent (see Extensions)
skills/<name>/SKILL.md     your skills
plugins/<name>/            your plugins
AGENTS.md                  your instructions, appended to the system prompt
```

A deck's newest session is its current chat (a folder's, the chat with no deck open); New chat
starts another and keeps the old one. `system-prompt.md` and the session's Claude Code files are rewritten by the app when
they change.

### Extensions

Every agent gets the same MCP servers, skills, plugins and instructions, from
`~/.slopslides` and from the workspace:

| | `~/.slopslides` | workspace |
|---|---|---|
| MCP servers | `mcp.json` | `.mcp.json` |
| skills | `skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| plugins | `plugins/<name>/` | `.agents/plugins/<name>/` |
| instructions | `AGENTS.md` | `AGENTS.md` |

MCP files use Claude Code's `.mcp.json` format (`{"mcpServers": {"name": {"command": …}}}`
or `{"url": …, "headers": …}`); the workspace's servers win over yours of the same name, and
`slopslide` is reserved for the app. Plugins use the Claude Code plugin layout
(`.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/`, `.mcp.json`). Each agent gets
them its own way:

| | Claude Code | Codex | Copilot |
|---|---|---|---|
| MCP servers | session `mcp.json`, with plugins' servers | `-c mcp_servers.<name>=…` | `mcpServers` |
| skills | a generated `slopslides` plugin | `skills/extraRoots/set` (finds `.agents/skills` itself) | `skillDirectories` |
| plugins | `--plugin-dir` | skills and MCP servers only | `pluginDirectories` |
| `~/.slopslides/AGENTS.md` | appended to the system prompt | `developerInstructions` | `systemMessage` |

Every agent reads the workspace's `AGENTS.md` itself. MCP tools other than the app's ask
for approval as the permission mode says; loading a skill never asks. The agents' own setup
(`~/.claude`, `~/.codex`, `~/.copilot`) is mostly left out: Copilot loads none of it,
Claude Code none of its MCP servers, but Claude Code and Codex still load their own skills
and plugins, and Codex its MCP servers.

`deck.html` already plays standalone in a browser. The editor renders individual slides of
it in sandboxed iframes (`deck.html?embed&slide=<id>`), so the thumbnails, stage, and
exported file all use the same player. The lists of slides (the slide list, the grid of all
slides, the start screen's decks, the layout pickers, the Changes list) show pictures of those
previews rather than a document each: the app makes each picture once, in a hidden window, and
keeps it in `~/.slopslides/thumbnails` (derived, safe to delete), named by what the slide's
page and its assets are, so a slide that changes gets a new picture and one that comes back is
found again. The slides of one deck waiting for pictures are made from one page, each once its
fonts and images are in; until a slide in view has its picture, its live preview stands in.

Every change to a deck goes into its undo history, whatever made it: one entry per edit
gesture, rail change, find and replace, code view save, setting, and agent turn (each deck
the turn changed gets one entry, labeled with the message); typing notes or narration and
drawing review marks close together make one entry. A change made in another app is noticed
the next time the app looks (opening the deck, a reload, before an undo) and becomes an
"Outside change" entry. ⌘Z / ⇧⌘Z and the top bar's buttons step through it, in any mode,
except while the agent works; a new change drops what could be redone. The arrow beside Undo
lists the versions kept (what made each, you or the agent, and when); choosing one goes back
to it as one change, which Undo takes back. Undoing an agent
turn asks whether the chat goes back too: the message returns to the composer, and the
provider's conversation is cut back when the next turn starts (Claude Code resumes with
`--resume-session-at`, Codex reverts the thread, Copilot truncates its history), or, where
it cannot be, the next prompt says what was undone. Keeping the chat marks the message and
tells the agent with the next one.
The turn of a deck's chat answers for that deck alone (its locked slides, its history entry):
the chats of other decks in the folder may be at work beside it. The turn of a folder's own
chat answers for every deck in the folder, so it does not run beside theirs. Its safety scan
skips dot folders and is bounded to 10,000 entries and 64 MiB of HTML;
turns refuse to start if those limits are exceeded. Chats saved for a folder before decks had
their own stay the folder's, and are listed under Past chats.

Claude receives file tools (Read/Write/Edit/Glob/Grep plus web search/fetch), skills, the
app's `lint_deck`, `open_file` and `render_slide` tools and the MCP servers from Extensions. Codex uses its
configured tools and MCP servers, plus `lint_deck`, `open_file`, `render_slide` and the extensions, under the
selected permission mode. Copilot uses its
workspace-scoped read/write permission handler. You can also edit `deck.html` by hand in any
editor; the app picks up the changes.

The design guidance in the agent's prompt draws on
[frontend-slides](https://github.com/zarazhangrui/frontend-slides) (MIT). See
`src-tauri/prompts/THIRD_PARTY_NOTICES.md`.

## License

[MIT](LICENSE) © 2026 Matthias Rieck. Third-party notices are in
`src-tauri/prompts/THIRD_PARTY_NOTICES.md`.
