# Region-based tiling on a super-ultrawide: research (2026-10-08)

Goal: split the 7680x2160 super-ultrawide into ~3 regions (left / center / right). Each region tiles
on its own, and each region can hold zero, one, or many windows.

> **Outcome (2026-10-08):** GNOME is a hard requirement. That rules out KDE/PlasmaZones, Hyprland,
> sway, niri and river, although PlasmaZones' "virtual screens" are still the best reference for the
> model. The plan is to write our own GNOME Shell extension, borrowing ideas from Forge and Tiling
> Shell. Requirements are in [requirements.md](requirements.md). The survey below is unchanged.
>
> Upstream status (GitHub API, 2026-10-08):
> - Forge: GPL-3.0, not archived, last push 2026-10-01, latest release `v49-89` (2025-12-16).
> - Tiling Shell: GPL-3.0, last push 2026-09-19, latest tagged release 17.3 (2026-01-31).
>
> Both are GPL-3.0, so borrowing code from either means this project is GPL-3.0 too.

## Draft requirements

**Must have**
- **R1 Regions.** Each monitor has a fixed set of N regions (default 3) with boundaries you can
  resize. Boundaries are stored as fractions, e.g. 25/50/25.
- **R2 Empty is a valid state.** A region can be empty. The other regions do not grow into its
  space. This is the main difference from i3/Forge-style "true tiling".
- **R3 Tiling inside a region.** A region with more than one window lays them out by itself, using
  split, stack, or monocle/tabbed.
- **R4 Maximize fills the region.** Fullscreen still covers the whole physical monitor, which games
  and video need.
- **R5 Keyboard control.** Move focus to the region left or right, move a window to another region,
  and cycle through the windows inside a region. Dragging with the mouse into a region should also
  work.
- **R6 Floating exceptions.** Dialogs, transient windows, PiP, and per-app rules float.
- **R7 Platform constraints.**
  - Wayland
  - 125% fractional scaling at 7680x2160, high refresh rate
  - fullscreen HDR games keep working
- **R8 Maintained.** It must survive distro and desktop upgrades without someone else's
  abandoned extension breaking.

**Open decisions at the time**
- **D1 Where new windows go:** the focused region, the region nearest the cursor, or per-app
  rules (e.g. terminal on the left, browser in the center)?
- **D2 How windows tile inside a region:** automatic (master/stack, columns, rows), or manual
  i3-style splits where you pick the split direction?
- **D3 What a region does with many windows:** split them all, or show one with the rest
  stacked or tabbed?
- **D4 How regions relate to workspaces:** does switching workspace switch all three regions
  together, or can each region switch on its own (e.g. keep the center and swap the left side)?
- **D5 Whether GNOME is a hard requirement,** or whether switching to KDE Plasma is acceptable if it
  fits much better.

## Options found

### 1. KDE Plasma 6.7 + PlasmaZones: closest fit
Repo: https://github.com/fuddlesworth/PlasmaZones. Docs: https://phosphor-works.github.io/plasmazones/

Versions at the time: Arch had `plasma-desktop`/`kwin` 6.7.5, and the AUR had `plasmazones` 3.4.18
(last modified 2026-09-12). The project is very active, with about 9k commits and frequent releases.

What is verified from the docs:
- **Virtual screens** (added in v3.0.0, 2026-05-16, "for ultrawide monitors"). They split one
  physical monitor into 2–10 logical screens with boundaries you drag to resize. Each virtual screen
  gets "its own mode, its own layout, and its own window set". Layout assignments, settings
  overrides, and rules treat each one as its own screen.
- **Modes per screen:**
  - zone snapping (FancyZones-like)
  - autotile, with 27 algorithms (master-stack, BSP, columns, monocle, deck, ...) plus custom
    Luau scripts
  - scrolling columns
- **Shortcuts:**
  - focus or move a window to the adjacent zone
  - push a window to the nearest empty zone
  - swap or rotate whole virtual screens
- Requires Plasma 6.7 on Wayland.

Not verified, so test these:
- Does an empty virtual screen stay empty, with nothing reflowing into it? (R2)
- Does maximize stay inside the virtual screen? Does fullscreen cover the whole monitor? (R4)
- Is there a shortcut to focus or move a window to the next *virtual screen*? The shortcuts page
  lists zone-level moves and screen swaps, but no per-window "move to next virtual screen".
- Do Plasma 6.7's per-screen virtual desktops apply to PlasmaZones virtual screens? (D4) Probably
  not, because those are KWin outputs.
- **The blocker:** HDR gaming. Leaving GNOME changes the whole HDR path, and HDR games have to
  look correct under KWin, or this option fails.

### 2. GNOME + Tiling Shell: stopgap that stays on GNOME
Repo: https://github.com/domferr/tilingshell
- Static layouts made of tiles, with a layout editor. Tiles can be empty. Layouts can be set per
  workspace and per monitor. Super+arrows moves windows between tiles. Optional auto-tile puts new
  windows in the best empty tile.
- Gaps: one window per tile, and no tiling inside a tile. This fails R3. You can work around it by
  keeping several layouts, such as "center solo" and "center split 2", and switching between them.
- GNOME 51 support is only in v18 (RC or recent release) on GitHub. extensions.gnome.org still
  ships 17.3. ([news](https://www.linuxcompatible.org/story/tiling-shell-v180-second-release-candidate-with-gnome-51-support-bug-fixes-and-more/))

### 3. Build it on GNOME
- The approach is to fork Forge, or write a new extension, so that the tree root is a fixed 3-way
  split that never collapses. Each child is either an empty placeholder or an ordinary tiling
  subtree. Maximize is intercepted and redirected to the region's rectangle.
- That is technically feasible, and an MVP is a moderate amount of work. The real cost is
  maintenance: GNOME changes extension APIs every 6 months, which is exactly why Forge rotted. Forge
  was archived in 2024, then unarchived with a "needs a new maintainer" note.
  ([EGO](https://extensions.gnome.org/review/47026), [Fedora GNOME 50 bug](https://bugzilla.redhat.com/show_bug.cgi?id=2442865))
- There is no GNOME extension that splits one monitor into virtual monitors.
  [VScreens](https://extensions.gnome.org/extension/11058/vscreens/) is per-monitor workspaces, not
  a split.

### 4. Rejected
- **Hyprland + hy3, or sway/i3.**
  - Empty containers collapse, which fails R2.
  - The request to split a monitor into virtual outputs was closed as not planned
    ([#3575](https://github.com/hyprwm/Hyprland/issues/3575)).
  - The `xrandr --setmonitor` trick only works on X11.
  - Hyprland HDR works but regressed in 0.55/0.56
    ([forum](https://forum.hypr.land/t/hdr-in-mpv-has-limited-dynamic-range-when-render-cm-enabled-true/2079)).
- **niri.** Scrolling tiling, which suits an ultrawide well, but it has no HDR
  ([discussion](https://github.com/niri-wm/niri/discussions/2685)). Fails R7.
- **river 0.4.** It now has a pluggable window-manager protocol, so you could write a WM that
  implements this exact model in any language. But it means a niche compositor and losing the
  desktop environment. ([linuxiac](https://linuxiac.com/river-0-4-wayland-compositor-debuts-pluggable-window-managers/))
