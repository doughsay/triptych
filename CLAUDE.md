# CLAUDE.md

Triptych is a GNOME Shell extension that splits a super-ultrawide monitor into regions (by default
25/50/25), each with its own automatic split tiling. Any region can be left empty. Read
`docs/requirements.md` first. It has the requirements, the decisions log (with reasons) and the
open questions. `docs/research.md` explains why this is a new extension and not Forge, Tiling Shell
or KDE.

## Ground rules

- **Simplicity.** Keep it as simple as possible so maintenance stays easy. No preferences UI, and
  every tunable is a constant in `extension/config.js`. Triptych is mouse-first, so keyboard
  shortcuts are optional extras.
- **Pure model, thin glue.**
  - `extension/model.js` holds all layout decisions, has no GNOME imports, and is tested with
    `make test` (`node --test`).
  - `extension/tiler.js` only tracks windows, handles signals and applies rects.
  - New logic goes in the model, together with a test.
- **Target.** GNOME 51, Wayland only.
- **The screen.**
  - 32:9 super-ultrawide, 7680x2160 at 125% fractional scaling (6144x1728 logical).
  - Fullscreen HDR games must keep working, and must never be tiled (R9).

## Status (2026-10-09)

- 47 unit tests pass. Nested-session checks 1–6 pass, and workspaces work. Running in the real
  session since 2026-10-09: fullscreen HDR games stay untouched.
- The GitHub repo is `doughsay/triptych`. The extension ID `triptych@doughsay.github.io` is final.
- v1 feature set is done and verified in nested (2026-10-09): floating regions (Quick Settings
  submenu), Float/Tile in the window menu (floating windows have no drop zones), swap on center
  drop (green preview), Reset Region Sizes, the Quick Settings on/off toggle
  (`extension/indicator.js`, GSettings schema in `extension/schemas/`, compiled by
  `make install`), outlines under windows and the preview under the dragged window.
- Since then: "Always Float <App>" in the window menu (GSettings `float-classes`) and per-workspace
  persistence of region widths and modes (GSettings `workspace-layouts`, by workspace number).
  Verified in nested; the real session picks them up at the next login.
- 2026-10-11: `FLOAT_TITLES` floats windows by WM class + title prefix (Firefox extension
  popups), including a title change within `FLOAT_TITLE_SECONDS` of opening. Verified in nested
  with a stand-in Ghostty rule; untested with Firefox itself.
- 2026-10-12: dragged boundaries have soft stops at multiples of 5% (`RESIZE_SNAP`,
  `SNAP_DISTANCE`) and show a size label (R11, R13). Verified in nested.
- Dynamic workspaces are untested, and shift the saved workspace numbers.
- `make nested` (via `make install`) symlinks the extension into
  `~/.local/share/gnome-shell/extensions/` and compiles the schema, so the real session shares
  the same files (and loads them at its next login).
- Checks (1–6 in nested, 7 in the real session):
  1. new-window placement: **passes** (after the snap-back and largest-pane changes)
  2. dragging into side regions vs Mutter's edge-tiling (Q8): **passes**
  3. drag overlay and drop, including the red preview for refused drops: **passes**
  4. edge-resizing splits and region boundaries: **passes**
  5. maximize filling the region: **passes**
  6. apps that resize themselves after first frame (Firefox, Electron): **passes**
  7. lock and unlock leave the layout intact: **passes** (real session)
- `FLOAT_CLASSES` covers `steam*` and `wl-copy`'s hidden clipboard window. Games run through
  Wine's Wayland mode may report another WM class; add those to `FLOAT_CLASSES` (R9).

## Hard-won facts

- **`Meta.Window.set_unmaximize_flags()` segfaults gnome-shell on Mutter 51** (seen via Forge).
  Don't call it. `tiler.js` uses a plain `unmaximize()`, which works in nested.
- **Don't run Triptych and Forge together.** Both manage window geometry and would fight.
- **Isolate the nested session.** `scripts/nested.sh` uses a throwaway `XDG_CONFIG_HOME`, so the
  nested shell gets only Triptych and doesn't touch the real dconf. Keep it that way.
- **Real-session reloads.** On Wayland the real session only loads code changes after a logout.
- **Lock screen.** `session-modes` includes `unlock-dialog`, so locking doesn't disable and
  re-enable the extension and reshuffle windows. Lock, unlock, monitor hotplug and input switches
  must only re-lay out windows. They must never re-run placement.
- **Mutter places new windows after their first frame.** The first move from `first-frame` gets
  overwritten, so `tiler.js` snaps any window that moves or resizes outside a grab back to its
  slot. A pane smaller than an app's minimum size makes Mutter drop the position too, so
  placement never splits below `MIN_SIZE`.
- **Mutter 51 window API facts (checked in nested).**
  - `get_min_size()` is in buffer size, which includes client-side shadows (25px per side for
    GTK). Frame minimum = min − (buffer size − frame size). `tiler.js` `_minSize` does this.
    The buffer lags the frame while a window is being resized, so that difference is wrong
    mid-drag (windows "popped out" at the limit). `_minSize` caches each window's value at grab
    start and uses the cache during the grab.
  - During a resize, a window held at its minimum only *moves*, so live relayout must run on
    `position-changed` as well as `size-changed`.
  - `allows_resize()` is false while a window is maximized. Apps that open bigger than the screen
    get auto-maximized by Mutter (Console does this).
  - `Meta.ExternalConstraint` works from GJS. `SlotConstraint` holds the window being resized to
    its slot. `info.new_rect` is in frame coordinates. It makes no Mutter calls besides reads.
  - Don't derive the drag from `info.new_rect`. It's anchored at the window's *current* position
    (the layout moves it, so the resize ran ~2x too fast), and Mutter re-runs the constraint with
    our own result when the client acks (so using its size ran at half speed). `Model.grabFrame`
    uses the grab-start frame plus the pointer delta instead.
- **GNOME 51 UI hooks.** Read the shell's own source before patching:
  `gresource extract /usr/lib/gnome-shell/libshell-51.so /org/gnome/shell/ui/<file>.js`. The
  window menu is `WindowMenu.prototype._buildMenu` (patched via `InjectionManager`). A stock
  `PopupSwitchMenuItem` closes the whole Quick Settings menu when its row (not the switch) is
  clicked.
- **Nested-shell tips.**
  - Size comes from `--devkit-args "--monitor-size WxH"`. `--virtual-monitor` adds a second,
    invisible monitor.
  - Resizing the devkit window or its orange button closes the session.
  - Stop it by killing the `mutter-devkit` PID, never with a `pkill` pattern that could match the
    real `gnome-shell`.
  - JS logs and errors from the extension don't reach `nested.log`. To debug, write to a file
    under `$HOME` (e.g. `~/.cache/`): the nested shell can't see a sandboxed `/tmp`.
  - Wait ~10s after "GNOME Shell started" before launching clients, or they may not be tracked.
  - Clients reach it via `WAYLAND_DISPLAY=wayland-1`, e.g. `ghostty --gtk-single-instance=false`.
    For GApplication apps (Calculator, Nautilus, Console) also set `DBUS_SESSION_BUS_ADDRESS` to
    the nested bus (from the nested `gnome-shell`'s `/proc/<pid>/environ`), or they open in the
    real session. They still read the real session's dconf.
- **No shell modal dialogs from scripts.** Don't trigger GNOME Shell modal dialogs (e.g. the
  extension install prompt) from scripts or tools: an unanswered one can stay on top of the lock
  screen. Install extensions from files instead.
