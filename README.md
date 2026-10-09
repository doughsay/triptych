# Triptych

A GNOME Shell extension for very wide monitors. It splits the screen into regions (by default
25/50/25: left, center, right). Each region tiles its own windows, and any region can be left
empty.

- [docs/requirements.md](docs/requirements.md): requirements, decisions log, and open questions
- [docs/research.md](docs/research.md): survey of existing options (2026-10-08)

Status: early prototype, targeting GNOME 51 on Wayland.

## How it works

- `extension/model.js`: the whole layout model as pure functions. It has no GNOME imports and is
  unit-tested with `node --test`. Each workspace has a row of regions, and each region holds a
  binary split tree of windows. The model covers:
  - placement of new windows
  - split direction
  - drop targets
  - resizing by dragging an edge
  - region-fill
- `extension/tiler.js`: thin glue to Mutter. It tracks windows, listens to signals, applies the
  rects the model computes, and draws the drag overlay.
- `extension/config.js`: every tunable: region sizes, gaps, the minimum size, and the float
  list.

## Using it

- **Windows go somewhere automatically.** A new window goes to an empty region, trying center,
  then left, then right. If no region is empty, it splits the largest pane on the screen, along
  its longer side. If nothing has room for it, it floats until you drag it in.
- **Drag a window by its title bar to move it.** A colored overlay shows where it will land: an
  empty region fills completely, and dropping on a window splits it on the side nearest the
  pointer. The overlay turns red where the window wouldn't fit, and dropping there does nothing.
- **Drag a window edge to resize.** This moves the split or region boundary under that edge, and
  the windows on the other side follow. Nothing shrinks below its app's minimum size.
- **Maximize fills the region instead of the whole screen.** Maximize again, or focus another
  window in that region, to restore the split.
- **Minimized and fullscreen windows keep their slot.** Their neighbours take over the space until
  they come back.

## Development

```sh
make test      # model unit tests (node)
make install   # symlink extension/ into ~/.local/share/gnome-shell/extensions
make nested    # run a nested GNOME Shell window with only Triptych enabled
```

`make nested` needs the `mutter-devkit` package. It runs the shell with a throwaway
`XDG_CONFIG_HOME`, so the real session's settings and extensions (such as Forge) don't get loaded
or changed. `SIZE=7680x2160 make nested` simulates the full panel. Open windows in it with
`WAYLAND_DISPLAY=wayland-1`; see CLAUDE.md for apps that need more than that.

Don't enable the extension in the real session while Forge is enabled; they would fight. On
Wayland, the real session only picks up code changes after you log out and back in.
