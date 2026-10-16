# Triptych: requirements

Status: **draft**, started 2026-10-08. Background and the survey of alternatives are in
[research.md](research.md).

## Problem

The target is a 32:9 super-ultrawide: 7680x2160 with HDR, on GNOME at 125% fractional scaling, for
a logical desktop of 6144x1728. A screen that wide is too big to treat as one tiling area:
- Full-screen tiling stretches one window across the whole panel.
- A two-way split gives two windows that are each wider than a normal monitor.
- GNOME's built-in half-tiling has the same problem.

Forge is the obvious existing tool. It is i3-style "true tiling", meaning windows always fill the
whole monitor, so a part of the screen can't be left empty. It is also poorly maintained.

What's wanted is closer to three monitors side by side. The panel is divided into regions (by
default left, center and right). Each region tiles on its own, and any region may be empty.

## Who it's for

Triptych is **mouse-first**. Every everyday operation must be doable with the mouse:
- resizing regions and splits
- moving windows between regions
- seeing where things will land

Keyboard shortcuts are a nice extra, not the primary interface.

## Hard constraints

- **C1 GNOME Shell extension.** It runs in the stock GNOME session (Mutter, Wayland). No other
  compositor, window manager or desktop environment.
- **C2 Target versions.** GNOME 51 is the primary target. Supporting older versions is not a goal.
- **C3 Platform behaviour must keep working.** None of these may break:
  - 125% fractional scaling
  - 7680x2160 high refresh rate with HDR
  - VRR
  - XWayland apps
  - fullscreen HDR games
- **C4 Small enough to maintain alone.** Forge died because porting a large codebase to each
  new GNOME release was too much work. The code that touches Mutter/Shell APIs should be thin, and
  the layout model should be pure logic that can be tested without GNOME.

## Core model

- **R1 Regions.** A monitor is split into an ordered row of N regions. The default is 3 and the
  default widths are 25/50/25. The count and default widths are set in preferences.
  Widths are stored as fractions, so they survive resolution and scale changes. Rows of regions
  (horizontal splits of the monitor) are not needed for v1.
- **R2 Regions are per workspace.** Each workspace has its own region boundaries. A workspace
  starts with the configured default widths. Resizing regions on one workspace never affects
  another. Switching workspace switches the whole monitor, as GNOME normally does; regions do not
  switch workspaces on their own.
- **R3 Empty regions are first-class.** A region with no windows stays empty at its current width
  and the desktop shows through. Neighbouring regions never grow into its space. When the last
  window in a region closes, the region becomes empty and keeps its width.
- **R4 Automatic split tiling within a region.** Each region holds a tree of splits, in the style
  of bspwm, i3 or Forge.
  - One window in a region fills the whole region.
  - Adding a window splits an existing window's space in two.
  - Closing a window collapses its split, and its sibling takes over the space.
  - The direction of a new split is chosen automatically. The likely rule is to split along the
    longer side of the window being split, so tall, narrow side regions stack windows vertically.
    This needs confirming (Q2).
- **R5 No manual window geometry for tiled windows.** Tiled windows are never freely moved or
  resized. The only things the user sizes directly are region boundaries and split boundaries
  (R11). Tiled window edges always follow the boundaries. Floating windows (R8) move freely.
- **R6 Every managed window belongs to exactly one region.** Floating windows (R8) belong to no
  region.
- **R7 Maximize and fullscreen.**
  - Maximizing a managed window makes it fill its region, temporarily covering the region's other
    windows. Un-maximizing restores the split.
  - Focusing another window in the region ends the fill. Known limitation: grabbing the region
    edge can catch the invisible resize border of a hidden window (GTK apps have wide ones), which
    focuses it and ends the fill. An attempt to undo that at grab start didn't work (2026-10-09),
    and it's minor enough to live with.
  - True fullscreen (F11, games, video) covers the entire monitor and is never constrained to a
    region.
- **R8 Floating.** Floating windows keep normal GNOME behaviour.
  - Never tiled: dialogs, transient/modal windows, popups, splash screens, picture-in-picture,
    fixed-size (non-resizable) windows, the WM class prefixes in `FLOAT_CLASSES`, the WM class and
    title prefixes in `FLOAT_TITLES` (e.g. Firefox extension popups), and apps marked
    "Always Float <App>" in the window menu (a checkbox, stored in GSettings by WM class; unchecking
    it tiles the app's windows again).
  - The window menu (right-click the title bar, or Alt+Space) has "Float Window" or "Tile
    Window". Float leaves the window where it is. Tile puts it in the region under its center,
    or uses placement (R10) if that region is floating. With no room it stays floating.
  - **Floating regions.** Each region on each workspace is tiled or floating, switched in the
    Quick Settings menu. A region switched to floating floats its windows where they are.
    Placement skips floating regions. A window dropped into one floats where it's dropped.
    Switching a region back to tiled tiles the floating windows centered in it (including ones
    floated by hand), bottom of the stack first, as long as they fit.
  - **On/off toggle.** The Triptych toggle in Quick Settings turns tiling off (windows stay where
    they are) and back on (a fresh start: placement runs on every window). The on/off state
    survives a logout, and so do region widths and modes (R18).
- **R9 Games are hands-off.** Fullscreen windows are never moved or resized, and games must not be
  grabbed and tiled on launch. The mechanism is still to be decided: a fullscreen check, a rule
  list, or both.

## Placement of new windows

- **R10 Placement policy.** A new window opens where the pointer is. Launched from the overview
  (e.g. Super, type the app name, Enter), it uses where the pointer was when the overview
  opened, if the window appears while the overview is open or within `OVERVIEW_SECONDS` after
  it closes. The point is read when the window is created, not when the app was launched, so a
  slow app follows the pointer if it moved in between. Each rule applies only if the ones
  before it don't:
  1. **If the point is over a tiled pane** (or in a gap, the nearest pane in its region), that
     pane splits along its longer side (or across it, if the windows only fit that way). The new
     window takes the half the point is in. Panes are taken as shown: minimized windows take no
     space, and a region fill is ignored.
  2. **If the point is over an empty tiled region,** the new window fills it.
  3. **If that pane can't split,** the region's largest pane that can splits instead, new window
     after it (right or below).
  4. **Otherwise the usual placement applies:** when that region has no room, when the point is
     outside the work area (e.g. on the top bar or the hot corner), or when it's in a floating
     region (Mutter, not Triptych, would decide where a floating window opens).
     1. **If any region on the current workspace is empty,** the new window goes into the next
        available empty region and fills it, in empty-region order (Q1).
     2. **If no region is empty,** the new window splits the largest pane (by area) on the
        screen, along its longer side (or across it, if the windows only fit that way), and goes
        after it (right or below). Sizes are compared without gaps, so panes that are the same
        fraction of the screen tie. Ties go to the first pane in empty-region order (Q1), then
        in tree order.
     3. **If no pane can split** without the new window or the window it splits going under its
        minimum size, the new window floats. "Tile Window" in the window menu tries again. A
        window's minimum is the app's own minimum size, but never less than `MIN_SIZE`.
  5. **If there are no regions on this monitor** (other monitors, R14), GNOME's default
     placement applies.

  Windows that aren't new have no meaningful point and always use the usual placement: windows
  moved to another workspace (R17), "Tile Window", and every window when Triptych is turned on.

## Mouse interaction (primary)

- **R11 Resize boundaries by dragging.**
  - Dragging a region boundary resizes the two regions on either side. Every window in both
    regions reflows.
  - Dragging a split boundary inside a region resizes the two sides of that split.
  - Grabbing the window edge that sits on a boundary drags the boundary. A Mutter resize grab
    is redirected to move the boundary instead of the window.
  - No boundary can be dragged so far that a window ends up under its minimum size (the app's own
    minimum, never less than `MIN_SIZE`). That includes windows nested deeper in the split tree
    and windows in the neighboring region. The window being dragged stops at the limit too.
  - Boundaries have soft stops at multiples of 5% (`RESIZE_SNAP`): of the screen width for
    region boundaries, of the split for split boundaries. A boundary holds at a stop while the
    pointer is within `SNAP_DISTANCE` of it, then catches up smoothly, so it never jumps. A
    minimum size wins over the stops.
- **R12 Move windows by dragging.** Dragging a window by its title bar and dropping it moves it:
  - Dropping on another region inserts it there. If that region is empty, the window fills it.
  - Dropping onto a specific window in a region splits that window.
  - The window leaves its old region, and that region's tree collapses.
  - Floating windows (R8) have no drop zones: dragging one just moves it, and it stays floating.
    "Tile Window" in the window menu is the way back into tiling.
  - A drop that would put either window under its minimum size is refused, and the preview turns
    red. Nothing changes: a tiled window goes back to its slot, and a floating one stays floating.
  - Dropping a tiled window on the middle of another (`SWAP_ZONE`, the middle half each way)
    swaps the two, as in Forge. The preview covers the whole target. Refused if either window
    wouldn't fit the other's slot.
  - Dropping into a floating region floats the window where it's dropped.
  - A visual hint shows the drop target while dragging. Floating regions get no outline and no
    preview.
- **R13 Visual clarity.** Region boundaries must be visible when they matter: at least while
  dragging, and while the pointer hovers a boundary, a resize cursor and a highlight make it
  obvious it can be grabbed. Empty regions should be identifiable, for example by a faint outline
  on hover or during a drag. An always-on indicator is optional.
  - Region outlines show while moving a tiled window and while resizing (they follow the
    boundaries live).
  - While a boundary is dragged, a label on it next to the pointer shows the sizes on either side
    in percent (e.g. `25%  │  50%`): of the screen width for a region boundary, of the split for
    a split boundary. It sits above all windows but on the boundary, away from the window
    centers where apps such as Ghostty show their own size overlay.
  - "Reset Region Sizes" in the Quick Settings menu puts the current workspace back to the
    configured widths.

## Keyboard (secondary, optional)

- **R14 Shortcuts, all optional and rebindable.**
  - Focus or move the window to the region left or right.
  - Toggle floating.
  - Reset this workspace's regions to the defaults.

  None of these are required for v1 if mouse equivalents exist.

## GNOME integration

- **R15 GNOME features keep working.** These must not break:
  - the Activities overview
  - workspaces (including dynamic workspaces)
  - Alt+Tab
  - minimize, and restoring minimized windows into their previous region and split
  - screen lock and unlock
  - suspend and resume
  - the monitor being disconnected or switching inputs and coming back
- **R16 One monitor first.** A single super-ultrawide is the target. Other monitor setups must not crash or
  break, but polishing them is not required. Leaving other monitors unmanaged is acceptable.
- **R17 Moving a window to another workspace** (via the overview or a shortcut) places it in the
  target workspace using the R10 policy.

## Persistence and robustness

- **R18 Survives restarts.** Default widths and settings persist. Each workspace's region widths
  and tiled/floating modes are saved in GSettings by workspace number, and restored when its
  layout is created (login, or tiling switched back on). Which window was where is not restored. After a shell restart, a log out and back in, or the extension
  being disabled and re-enabled, windows return to their regions where that's practical.
  Q5 covers persistence across logins with dynamic workspaces.
- **R19 Fails safe.** If the extension throws or is disabled, windows stay where they are and
  stay usable. Nothing is left offscreen or unmovable.
- **R20 Settings UI (deferred, see the simplicity rule).** If one is ever added, a preferences window (GTK4/libadwaita) would cover:
  - region count and default widths
  - gaps
  - the float list
  - the empty-region order (Q1)
  - optional shortcuts

## Non-goals (v1)

- Being a general-purpose tiling WM. Manual split directions, scripting and multiple layout
  algorithms are out of scope.
- Free-floating placement of tiled windows (R5).
- Tabs or stacking within a region. This is a possible later feature (Q4).
- Rows of regions, or more than one row.
- Supporting X11 sessions, which were removed in GNOME 50 anyway.
- Publishing to extensions.gnome.org. This may happen later, but it isn't a requirement.

## Decisions log

- **2026-10-08 Stay on GNOME.** We'll write our own extension instead of switching desktop
  environments (see research.md).
- **2026-10-08 Placement (R10).** A new window goes to an empty region first and fills it.
  Otherwise it splits the most recently focused region that has a window in it. *Superseded on
  2026-10-09, see below.*
- **2026-10-09 Placement by largest pane (R10).** After the empty regions, a new window splits the
  largest pane on the screen, not the last-focused one. Following focus was too hard to control,
  and placement should spread windows as evenly as possible in a defined order. When no pane can
  split above `MIN_SIZE`, the new window floats, because a pane smaller than an app's own minimum
  size makes Mutter drop the move entirely. Sizes are compared without gaps, so equal fractions
  of the screen tie (otherwise the gaps make the center halves a few pixels smaller than the side
  regions, and the order looks arbitrary). Drops follow the same minimum (R12). *For new windows,
  superseded on 2026-10-16, see below. It's still the fallback.*
- **2026-10-08 Tiling (R4, R5).** Tiling is automatic split tiling (bspwm/i3/Forge style). There
  is no manual window placement or resizing; only region and split boundaries are dragged.
- **2026-10-08 Workspaces (R2).** Region boundaries are per workspace and start from the
  configured defaults. Workspaces switch the whole monitor.
- **2026-10-08 Interaction.** The design is mouse-first, and keyboard shortcuts are optional.
  Dragging windows between regions is required (R12).
- **2026-10-08 Q1 Empty-region order.** Center first, then outward, left before right. For 3
  regions the order is center, left, right.
- **2026-10-08 Q2 Split direction.** A new split runs along the longer side of the window being
  split. Since 2026-10-09 it falls back to the other direction when the two windows' minimum
  sizes only fit that way (Calculator, 616px tall, fits a side-by-side split but not a stacked
  one).
- **2026-10-08 Q3 Drop preview.** A Forge-style colored overlay shows where the window will land.
  Dropping onto a window splits it on the side nearest the pointer. Dropping onto an empty region
  fills it.
- **2026-10-08 Q4 Tabs.** Not in v1. The tree is a plain node tree, so a "tabs" node type can be
  added later without a rewrite.
- **2026-10-08 Q5 Persisting widths.** Remembering per-workspace widths across logins is wanted
  but **deferred**. The prototype keeps them in memory for the session.
- **2026-10-08 Q6 Gaps.** Gaps go between windows. There is a larger gap between regions so the
  regions read as separate. Gap sizes should be configurable, but see the simplicity rule below.
- **2026-10-08 Simplicity rule.** Keep it minimal, with as little configuration as possible. For
  now every tunable is a constant in `extension/config.js`. A preferences UI (R20) is only added if
  a constant actually needs changing often.
- **2026-10-08 Q7 Fresh codebase, not a fork.** Reasons:
  - Forge is ~8k lines of JS, and its 2.9k-line `window.js` monolith mixes the tree with Mutter
    calls. Its model is "true tiling" across the whole monitor, which is the thing we're removing.
  - Tiling Shell is ~15k lines of TypeScript with a build step. Its model is static zones with one
    window each, which doesn't fit R4.
  - A fresh extension can stay small: a pure layout model (`model.js`, unit-tested with
    `node --test`) plus thin glue code that talks to GNOME and Mutter. We borrow *patterns* from
    Forge, not code. These include grab-op handling, resize by edge, the drag preview overlay, and
    `session-modes: ["user", "unlock-dialog"]`.
- **2026-10-08 Robustness rules for the glue code:**
  - Lock/unlock, monitor hotplug, input switching and work-area changes only *re-lay out*. They
    never re-run placement or rebuild the tree.
  - Minimized and fullscreen windows keep their place in the tree. They are skipped when laying
    out, so they come back to the same slot.
  - v0 manages only the primary monitor (R16).
  - A window that is already maximized when it is first managed is unmaximized and tiled. Only a
    maximize *after* it is managed toggles region-fill (R7).

- **2026-10-09 Q8 Mutter edge-tiling.** Tested in the nested shell. Mutter's edge-snap preview
  shows alongside Triptych's, but Triptych's drop wins and Mutter's snap is never applied, even to
  a floating window. Triptych leaves `org.gnome.mutter edge-tiling` alone. Turn it off in
  Settings (Multitasking) to hide the duplicate preview.

- **2026-10-09 Per-app minimum sizes.** Placement, drops and boundary drags use each window's own
  minimum size, with `MIN_SIZE` as a floor. A fixed `MIN_SIZE` alone let apps with a bigger
  minimum (Ghostty ~263px, Calculator 616px tall) overflow their pane and overlap a neighbor.

- **2026-10-09 Floating regions, window float toggle, swap, on/off toggle.** Region modes are switched in a Quick Settings submenu, single windows in the window menu.
  New windows only go to tiled regions. The on/off state is stored in GSettings
  (`tiling-enabled`). Workspaces were tested in nested and work, each with its own layout.

- **2026-10-09 Always Float apps and layout persistence.** "Always Float <App>" in the window menu
  keeps an app out of tiling for good. Region widths and modes persist per workspace number,
  which is reliable with static workspaces; with dynamic ones, numbers shift when GNOME removes
  an empty workspace.

- **2026-10-11 Float by title (R8).** Wayland has no "floating" hint beyond window type, parent and
  fixed size, and Firefox extension popups (e.g. a password manager's unlock window) send none of
  them. `FLOAT_TITLES` matches WM class and title prefix (`firefox` + `Extension: (`). Apps set the
  final title after opening, so a matching title change within `FLOAT_TITLE_SECONDS` of opening
  floats a tiled window back at its opening size. Later title changes (switching tabs) never do.

- **2026-10-12 wl-copy's hidden window floats.** Mutter has no data-control protocol, so `wl-copy`
  maps a hidden 1x1 toplevel (`io.github.bugaevc.wl-clipboard`) to get keyboard focus, then
  closes it. Triptych tiled it like a new window: with every region occupied it split the largest
  pane for a moment, which showed as a flicker on each copy from CLI tools that shell out to
  `wl-copy`. It's in `FLOAT_CLASSES` now.

- **2026-10-12 Size label and snapping (R11, R13).** Custom region widths were hard to set
  precisely: nothing showed the size, and only Ghostty's own overlay (terminal columns × rows)
  appeared, and only for Ghostty. A label on the dragged boundary shows percents, which match
  how region widths are stored and configured and don't change with resolution, scale or gaps.
  Boundaries snap to nearby multiples of 5% (a first try snapped every whole percent, which
  made every drag step; snapping only near round sizes keeps free dragging in between). The
  snap is a soft stop rather than a jump into place, which felt harsh: the boundary holds near
  a stop and moves slightly faster than the pointer in between. The label shows whole
  percents. The label goes on the boundary, not in the region's
  center: outlines sit under windows, so a centered label would only show in empty regions,
  and a centered one above windows would collide with Ghostty's.
- **2026-10-16 Placement at the pointer (R10).** Placing by largest pane was predictable but
  rarely where the window was wanted. Most new windows are terminals opened with a keyboard
  shortcut while pointing at where they should go. The pointer, not focus, decides: with
  focus-follows-mouse the two usually agree, but the pointer can also point at an empty region,
  and it's a deliberate choice rather than a side effect of where the mouse passed (the reason
  focus-following was dropped on 2026-10-09). The new window takes the half the pointer is in,
  like a drop (R12). A launch from the overview uses the pointer from before the overview opened,
  since the overview covers the windows and the pointer may be on an app icon. Opening the
  overview with the hot corner or the Activities button leaves the pointer on the top bar,
  outside the work area, so the usual placement applies. Known limitation: a window opened by
  any means within `OVERVIEW_SECONDS` of closing the overview also uses that point. The largest-pane
  rule stays as the fallback, and for workspace moves, "Tile Window" and turning Triptych on,
  where the pointer means nothing.

## Open questions

- **Q9 Boundaries with no windows on either side.** A region boundary between two empty regions
  has no window edge to grab. Should there be a grab handle in the gap between regions? Deferred
  until it's actually annoying.

- **Q10 Windows with size limits.** Mutter's `allows_resize()` is only false when both sides are
  fixed (min == max). A window with any max size (or one fixed side) fits its slot when it opens,
  but can't follow a region that's widened later: it leaves a gap and fights the snap-back. Float
  every window with a finite max size (`get_max_size()`)? Check first what "no max" looks like at
  runtime (Wayland vs XWayland) in nested.

- **Q11 User-editable float rules.** `FLOAT_CLASSES` and `FLOAT_TITLES` are constants, so adding
  an exception means editing `config.js` and logging out. "Always Float <App>" covers whole apps
  from the window menu, but not a WM class + title prefix (e.g. one Firefox extension popup), nor
  windows that close too fast to right-click (e.g. `wl-copy`'s hidden window). Supporting both
  means typing text somewhere, which is close to a config UI. No good answer yet; editing
  `config.js` is fine for now.
