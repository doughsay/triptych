// Glue between the pure layout model and Mutter. Keep this file thin: decisions
// belong in model.js, this file only tracks windows, listens to signals and
// applies rects.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {WindowMenu} from 'resource:///org/gnome/shell/ui/windowMenu.js';

import * as Model from './model.js';
import {
    FLOAT_CLASSES, FLOAT_TITLE_SECONDS, FLOAT_TITLES, GAPS, MIN_SIZE, OVERVIEW_SECONDS,
    REGION_SIZES,
} from './config.js';

// Direction bits of Meta.GrabOp resize values.
const EDGE_BITS = [[0x1000, 'w'], [0x2000, 'e'], [0x4000, 's'], [0x8000, 'n']];

// How far along the boundary from the pointer the size label sits, so the
// cursor doesn't cover it.
const LABEL_OFFSET = 32;

// Holds a window under a resize grab to its slot in the layout, from inside
// Mutter's own constraint pass. Without it the window follows the pointer past
// a boundary's limit, and its far edges lag until the grab ends. `rectFor`
// may only read from Mutter, never change anything.
const SlotConstraint = GObject.registerClass({
    Implements: [Meta.ExternalConstraint],
}, class SlotConstraint extends GObject.Object {
    constructor(rectFor) {
        super();
        this._rectFor = rectFor;
    }

    vfunc_constrain(win, info) {
        if (!(info.flags & Meta.ExternalConstraintFlags.RESIZE))
            return false;
        const r = this._rectFor();
        if (r)
            info.set_rect(new Mtk.Rectangle(r));
        return false;
    }
});

export class Tiler {
    constructor(settings) {
        this._settings = settings; // see schemas/: float-classes, workspace-layouts
        this._layouts = new Map(); // Meta.Workspace -> layout
        this._windows = new Map(); // Meta.Window -> {ws, ids}
        this._signals = []; // [object, handlerId]
        this._dirty = new Set(); // workspaces waiting for a relayout
        this._idleId = 0;
        this._grab = null; // {win, ws, kind: 'move' | 'resize', edges, start, constraint}
        this._overlay = null;
        this._labels = null; // size labels while a boundary is dragged
        this._pending = new Map(); // window actor -> first-frame handler id
        this._overviewPoint = null; // the pointer when the overview last opened
        this._overviewUntil = 0; // monotonic time until which new windows use it
    }

    enable() {
        const display = global.display;
        this._connect(display, 'window-created', (_d, win) => this._onWindowCreated(win));
        this._connect(display, 'grab-op-begin', (_d, win, op) => this._onGrabBegin(win, op));
        this._connect(display, 'grab-op-end', () => this._onGrabEnd());
        this._connect(display, 'notify::focus-window', () => this._onFocus());
        this._connect(display, 'workareas-changed', () => this._queueAll());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._queueAll());
        this._connect(global.workspace_manager, 'workspace-removed', () => this._pruneLayouts());
        this._connect(this._settings, 'changed::float-classes', () => this._resyncTracking());
        this._connect(Main.overview, 'showing', () => {
            const [x, y] = global.get_pointer();
            this._overviewPoint = {x, y};
        });
        this._connect(Main.overview, 'hidden', () => {
            this._overviewUntil = GLib.get_monotonic_time() + OVERVIEW_SECONDS * 1e6;
        });

        // "Float Window" / "Tile Window" in the window menu.
        const tiler = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(WindowMenu.prototype, '_buildMenu', original =>
            function (window) {
                original.call(this, window);
                tiler._addMenuItem(this, window);
            });

        const existing = global.get_window_actors().map(a => a.meta_window);
        for (const win of display.sort_windows_by_stacking(existing))
            this._track(win);
        this._onFocus();
        this._queueAll();
    }

    disable() {
        // Windows stay where they are (R19).
        this._injections?.clear();
        this._injections = null;
        this._hideOverlay();
        this._dropConstraint();
        if (this._idleId)
            GLib.source_remove(this._idleId);
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        for (const [actor, id] of this._pending)
            actor.disconnect(id);
        this._pending.clear();
        for (const win of [...this._windows.keys()])
            this._untrack(win, false);
        this._signals = [];
        this._layouts.clear();
        this._dirty.clear();
        this._grab = null;
    }

    _connect(obj, signal, handler) {
        this._signals.push([obj, obj.connect(signal, handler)]);
    }

    // --- Window tracking ------------------------------------------------

    _onWindowCreated(win) {
        // Wayland clients have no usable geometry until their first frame.
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        const point = this._launchPoint();
        const id = actor.connect('first-frame', () => {
            actor.disconnect(id);
            this._pending.delete(actor);
            this._track(win, true, point);
            this._onFocus();
        });
        this._pending.set(actor, id);
    }

    // Where a new window opens (R10): at the pointer, or, launched from the
    // overview, where the pointer was when the overview opened.
    _launchPoint() {
        if (Main.overview.visible || GLib.get_monotonic_time() < this._overviewUntil)
            return this._overviewPoint;
        const [x, y] = global.get_pointer();
        return {x, y};
    }

    // `ignoreAppRules`: leave out the "Always Float" apps (for the menu, which
    // must still offer to undo the rule).
    _isTileable(win, ignoreAppRules = false) {
        const wmClass = (win.get_wm_class() ?? '').toLowerCase();
        return win.get_window_type() === Meta.WindowType.NORMAL &&
            !win.get_transient_for() &&
            !win.is_attached_dialog() &&
            !win.is_skip_taskbar() &&
            !win.is_on_all_workspaces() &&
            !win.is_fullscreen() &&
            // allows_resize() is false while maximized, e.g. auto-maximized on open.
            (win.allows_resize() || win.get_maximize_flags() !== 0) &&
            win.get_monitor() === global.display.get_primary_monitor() &&
            !FLOAT_CLASSES.some(c => wmClass.startsWith(c)) &&
            (ignoreAppRules || !this._settings.get_strv('float-classes').includes(wmClass));
    }

    // After the "Always Float" list changes: windows of a newly listed app float
    // where they are; windows of an app taken off the list get placed.
    _resyncTracking() {
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            const tracked = this._windows.has(win);
            if (tracked && !this._isTileable(win))
                this._untrack(win, true);
            else if (!tracked && this._isTileable(win))
                this._track(win);
        }
    }

    // `opened`: the window has just opened, so a title change can still float
    // it for a few seconds (FLOAT_TITLES). `point`: where it opens (R10).
    _track(win, opened = false, point = null) {
        if (this._windows.has(win) || !this._isTileable(win) ||
            Model.matchesTitleRule(win.get_wm_class(), win.get_title(), FLOAT_TITLES))
            return;
        const state = {ws: null, ids: [], openRect: win.get_frame_rect(),
            titleUntil: opened ? GLib.get_monotonic_time() + FLOAT_TITLE_SECONDS * 1e6 : 0};
        this._windows.set(win, state);
        state.ids = [
            win.connect('notify::title', () => this._onTitleChanged(win)),
            win.connect('unmanaging', () => this._untrack(win, true)),
            win.connect('workspace-changed', () => this._syncWorkspace(win)),
            win.connect('notify::minimized', () => this._queue(state.ws)),
            win.connect('notify::fullscreen', () => this._queue(state.ws)),
            win.connect('notify::maximized-horizontally', () => this._onMaximize(win)),
            win.connect('notify::maximized-vertically', () => this._onMaximize(win)),
            win.connect('size-changed', () => this._onGeometryChanged(win)),
            win.connect('position-changed', () => this._onGeometryChanged(win)),
        ];
        // Windows that open maximized are tiled normally, not region-filled.
        if (win.get_maximize_flags())
            this._unmaximize(win);
        this._syncWorkspace(win, point);
    }

    _untrack(win, relayout) {
        const state = this._windows.get(win);
        if (!state)
            return;
        for (const id of state.ids)
            win.disconnect(id);
        this._windows.delete(win);
        if (this._grab?.win === win) {
            this._dropConstraint();
            this._grab = null;
            this._hideOverlay();
        }
        if (state.ws && relayout) {
            Model.removeWindow(this._layout(state.ws), win);
            this._queue(state.ws);
        }
    }

    // A window that gets a FLOAT_TITLES title just after opening floats, back
    // at the size it opened with, centered where it was tiled but on screen.
    _onTitleChanged(win) {
        const state = this._windows.get(win);
        if (GLib.get_monotonic_time() > state.titleUntil ||
            !Model.matchesTitleRule(win.get_wm_class(), win.get_title(), FLOAT_TITLES))
            return;
        this._untrack(win, true);
        const f = win.get_frame_rect(), a = win.get_work_area_current_monitor();
        const {width, height} = state.openRect;
        const clamp = (v, min, max) => Math.round(Math.max(min, Math.min(v, max)));
        win.move_resize_frame(true,
            clamp(f.x + (f.width - width) / 2, a.x, a.x + a.width - width),
            clamp(f.y + (f.height - height) / 2, a.y, a.y + a.height - height),
            width, height);
    }

    // Puts the window into its workspace's layout, running the placement
    // policy, at `point` if given. Only called when a window is tracked or
    // changes workspace.
    _syncWorkspace(win, point = null) {
        const state = this._windows.get(win);
        const ws = win.is_on_all_workspaces() ? null : win.get_workspace();
        if (!state || state.ws === ws)
            return;
        if (state.ws) {
            Model.removeWindow(this._layout(state.ws), win);
            this._queue(state.ws);
        }
        state.ws = ws;
        const area = ws && this._area(ws);
        // With no room, the window floats until it's dragged into a region.
        if (!area)
            return;
        const layout = this._layout(ws);
        const region = point
            ? Model.insertAt(layout, win, point, area, GAPS, this._minSize, this._visible)
            : Model.insertWindow(layout, win, area, GAPS, this._minSize);
        if (region !== null)
            this._queue(ws);
    }

    _layout(ws) {
        let layout = this._layouts.get(ws);
        if (!layout) {
            layout = Model.createLayout(REGION_SIZES);
            Model.restoreLayout(layout, this._savedLayouts()[ws.index()]);
            this._layouts.set(ws, layout);
        }
        return layout;
    }

    // Saved region widths and modes, by workspace number.
    _savedLayouts() {
        try {
            const saved = JSON.parse(this._settings.get_string('workspace-layouts'));
            return Array.isArray(saved) ? saved : [];
        } catch {
            return [];
        }
    }

    // Saves every workspace layout of this session, keeping saved entries for
    // workspaces not touched yet. Called after user changes, not on relayouts.
    _saveLayouts() {
        const saved = this._savedLayouts();
        for (const [ws, layout] of this._layouts)
            saved[ws.index()] = Model.saveLayout(layout);
        this._settings.set_string('workspace-layouts', JSON.stringify(saved));
    }

    _pruneLayouts() {
        const alive = new Set();
        const wm = global.workspace_manager;
        for (let i = 0; i < wm.get_n_workspaces(); i++)
            alive.add(wm.get_workspace_by_index(i));
        for (const ws of [...this._layouts.keys()]) {
            if (!alive.has(ws)) {
                this._layouts.delete(ws);
                this._dirty.delete(ws);
            }
        }
    }

    _area(ws) {
        const monitor = global.display.get_primary_monitor();
        if (monitor < 0 || global.display.get_n_monitors() === 0)
            return null;
        return ws.get_work_area_for_monitor(monitor);
    }

    _visible = win => !win.minimized && !win.is_fullscreen();

    // A window's smallest frame size, never under MIN_SIZE. get_min_size() is
    // in buffer size, which includes client-side shadows (or excludes a server-
    // side title bar), so correct by the buffer/frame difference. That
    // difference is only right once the client has caught up with its frame,
    // so during a grab, while windows are in flux, use the last idle value.
    _minSize = win => {
        const state = win && this._windows.get(win);
        if (this._grab && state?.min)
            return state.min;
        const min = {width: MIN_SIZE, height: MIN_SIZE};
        const [known, width, height] = win?.get_min_size() ?? [false];
        if (known) {
            const f = win.get_frame_rect(), b = win.get_buffer_rect();
            min.width = Math.max(min.width, width - (b.width - f.width));
            min.height = Math.max(min.height, height - (b.height - f.height));
        }
        if (state)
            state.min = min;
        return min;
    };

    // --- Floating -------------------------------------------------------------

    // Per region of the active workspace: whether it's floating.
    regionsFloating() {
        return this._layout(global.workspace_manager.get_active_workspace())
            .regions.map(r => r.floating);
    }

    // Switches a region of the active workspace. Its windows float where they
    // are; switching back tiles the floating windows centered in it, bottom of
    // the stack first, as long as they fit.
    setRegionFloating(i, floating) {
        const ws = global.workspace_manager.get_active_workspace();
        const layout = this._layout(ws);
        const area = this._area(ws);
        if (!area || layout.regions[i].floating === floating)
            return;
        Model.setRegionFloating(layout, i, floating);
        if (!floating) {
            const floaters = [...this._windows].filter(([w, st]) => st.ws === ws &&
                !w.minimized && !Model.findWindow(layout, w) &&
                Model.regionAt(layout, area, GAPS, this._center(w)) === i).map(([w]) => w);
            for (const w of global.display.sort_windows_by_stacking(floaters))
                Model.insertInto(layout, w, i, area, GAPS, this._minSize);
        }
        this._saveLayouts();
        this._queue(ws);
    }

    // Puts the active workspace's region widths back to REGION_SIZES.
    resetRegionSizes() {
        const ws = global.workspace_manager.get_active_workspace();
        Model.resetRegionSizes(this._layout(ws), REGION_SIZES);
        this._saveLayouts();
        this._queue(ws);
    }

    // Window menu: float a tiled window where it is, or tile a floating one
    // into the region under its center (or by the usual placement if that
    // region is floating). With no room it stays floating.
    _toggleFloating(win) {
        const state = this._windows.get(win);
        const area = state?.ws && this._area(state.ws);
        if (!area)
            return;
        const layout = this._layout(state.ws);
        if (Model.removeWindow(layout, win)) {
            win.raise();
        } else {
            const i = Model.regionAt(layout, area, GAPS, this._center(win));
            if (Model.insertInto(layout, win, i, area, GAPS, this._minSize) === null)
                Model.insertWindow(layout, win, area, GAPS, this._minSize);
        }
        this._queue(state.ws);
    }

    _addMenuItem(menu, win) {
        if (!this._isTileable(win, true))
            return; // never tiles anyway: dialogs, fixed-size windows, games
        // Before the separator and "Close" at the end.
        const add = item => menu.addMenuItem(item, Math.max(0, menu.numMenuItems - 2));
        const state = this._windows.get(win);
        if (state?.ws) {
            const tiled = !!Model.findWindow(this._layout(state.ws), win);
            const item = new PopupMenu.PopupMenuItem(tiled ? 'Float Window' : 'Tile Window');
            item.setOrnament(PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._toggleFloating(win));
            add(item);
        }
        const wmClass = (win.get_wm_class() ?? '').toLowerCase();
        if (!wmClass)
            return;
        const classes = this._settings.get_strv('float-classes');
        const always = classes.includes(wmClass);
        const name = Shell.WindowTracker.get_default().get_window_app(win)?.get_name() ?? wmClass;
        const item = new PopupMenu.PopupMenuItem(`Always Float ${name}`);
        item.setOrnament(always ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        item.connect('activate', () => this._settings.set_strv('float-classes', always
            ? classes.filter(c => c !== wmClass) : [...classes, wmClass]));
        add(item);
    }

    _center(win) {
        const f = win.get_frame_rect();
        return {x: f.x + f.width / 2, y: f.y + f.height / 2};
    }

    // --- Focus and maximize ------------------------------------------------

    _onFocus() {
        const win = global.display.focus_window;
        const state = win && this._windows.get(win);
        if (state?.ws && Model.setFocus(this._layout(state.ws), win))
            this._queue(state.ws);
    }

    // A maximize request on a managed window toggles "fill the region" (R7).
    _onMaximize(win) {
        if (!win.get_maximize_flags())
            return; // our own unmaximize, or a real unmaximize
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const state = this._windows.get(win);
            if (state?.ws && win.get_maximize_flags()) {
                const filled = win.is_maximized() &&
                    Model.toggleFill(this._layout(state.ws), win);
                this._unmaximize(win);
                if (filled)
                    win.raise();
                this._queue(state.ws);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _unmaximize(win) {
        // Don't call set_unmaximize_flags(): on Mutter 51 it segfaults
        // gnome-shell (seen via Forge).
        win.unmaximize();
    }

    // --- Layout ------------------------------------------------------------

    _queue(ws) {
        if (!ws)
            return;
        this._dirty.add(ws);
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            const dirty = [...this._dirty];
            this._dirty.clear();
            for (const w of dirty)
                this._relayout(w);
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueAll() {
        for (const ws of this._layouts.keys())
            this._queue(ws);
    }

    _relayout(ws, except = null) {
        const layout = this._layouts.get(ws);
        const area = layout && this._area(ws);
        if (!area)
            return;
        const {windows} = Model.computeLayout(layout, area, GAPS, this._visible, this._minSize);
        for (const [win, r] of windows) {
            if (win !== except)
                this._place(win, r);
        }
    }

    _place(win, r) {
        const f = win.get_frame_rect();
        if (f.x === r.x && f.y === r.y && f.width === r.width && f.height === r.height)
            return;
        if (win.get_maximize_flags())
            this._unmaximize(win);
        win.get_compositor_private()?.remove_all_transitions();
        win.move_resize_frame(true, r.x, r.y, r.width, r.height);
    }

    // --- Mouse: drag to move, drag edges to resize ----------------------------

    _onGrabBegin(win, op) {
        const state = win && this._windows.get(win);
        // Floating windows move and resize freely: no drop zones, no re-tiling.
        if (!state?.ws || !Model.findWindow(this._layout(state.ws), win))
            return;
        const edges = EDGE_BITS.filter(([bit]) => op & bit).map(([, e]) => e);
        if (edges.length) {
            for (const [w, st] of this._windows) {
                if (st.ws === state.ws)
                    this._minSize(w); // refresh the cache while everything is idle
            }
            const f = win.get_frame_rect();
            const start = {x: f.x, y: f.y, width: f.width, height: f.height};
            const grab = {win, ws: state.ws, kind: 'resize', edges, start,
                pointerStart: this._pointer()};
            grab.constraint = new SlotConstraint(() => this._constrainResize(grab));
            win.add_external_constraint(grab.constraint);
            this._grab = grab;
            this._showOverlay();
        } else if (op === Meta.GrabOp.MOVING || op === Meta.GrabOp.MOVING_UNCONSTRAINED ||
                   op === Meta.GrabOp.KEYBOARD_MOVING) {
            this._grab = {win, ws: state.ws, kind: 'move'};
            this._showOverlay();
        }
    }

    _onGrabEnd() {
        this._dropConstraint();
        const grab = this._grab;
        this._grab = null;
        if (!grab)
            return;
        const layout = this._layout(grab.ws);
        const area = this._area(grab.ws);
        this._hideOverlay();
        if (grab.kind === 'move') {
            if (area) {
                const target = Model.dropTarget(layout, area, GAPS, this._pointer(),
                    grab.win, this._minSize, this._visible);
                Model.moveWindow(layout, grab.win, target, area, GAPS);
            }
        } else {
            this._saveLayouts(); // region widths may have changed
        }
        // Let Mutter finish its own end-of-grab work before snapping into place.
        this._queue(grab.ws);
    }

    _onGeometryChanged(win) {
        const grab = this._grab;
        if (grab?.win !== win)
            this._snapBack(win);
        else if (grab.kind === 'move')
            this._updateOverlay();
        else {
            // Live: SlotConstraint already updated the layout. A window held at
            // its minimum only moves, so this runs on position changes too.
            this._relayout(grab.ws, win);
            this._updateOverlay();
        }
    }

    // The grabbed window's slot for the current pointer position. Called from
    // SlotConstraint, so it only reads from Mutter.
    _constrainResize(grab) {
        const area = this._area(grab.ws);
        if (!area || this._grab !== grab)
            return null;
        const layout = this._layout(grab.ws);
        const frame = Model.grabFrame(grab.start, grab.pointerStart, this._pointer(), grab.edges);
        for (const edge of grab.edges) {
            Model.resizeEdge(layout, area, GAPS, grab.win, edge, frame, this._minSize,
                this._visible);
        }
        const {windows} = Model.computeLayout(layout, area, GAPS, this._visible, this._minSize);
        return windows.get(grab.win) ?? null;
    }

    _dropConstraint() {
        const grab = this._grab;
        if (grab?.constraint) {
            grab.win.remove_external_constraint(grab.constraint);
            grab.constraint = null;
        }
    }

    // A window that moved or resized on its own goes back to its slot. This
    // catches Mutter's initial placement, which lands after our first move, and
    // apps that resize themselves. During a grab, grab end relayouts instead.
    _snapBack(win) {
        if (!this._grab)
            this._queue(this._windows.get(win)?.ws);
    }

    _pointer() {
        const [x, y] = global.get_pointer();
        return {x, y};
    }

    // --- Drop preview, region outlines and size labels ------------------------------------------------

    _showOverlay() {
        this._hideOverlay();
        const {ws} = this._grab;
        const area = this._area(ws);
        if (!area)
            return;
        // Outlines and preview live among the window actors: see _restackOverlay.
        this._overlay = new St.Widget();
        // Floating regions get no outline: they don't tile.
        this._regionBoxes = this._layout(ws).regions.map(r => {
            const box = new St.Widget({style_class: 'triptych-region', visible: !r.floating});
            this._overlay.add_child(box);
            return box;
        });
        this._preview = this._box('triptych-preview', area);
        this._preview.hide();
        global.window_group.add_child(this._overlay);
        global.window_group.add_child(this._preview);
        // A size label per dragged boundary, above every window.
        this._labels = this._grab.kind === 'resize' ? this._grab.edges.map(() => {
            const label = new St.Label({style_class: 'triptych-size', visible: false});
            Main.layoutManager.uiGroup.add_child(label);
            return label;
        }) : [];
        this._updateOverlay();
    }

    _box(styleClass, r) {
        const box = new St.Widget({style_class: styleClass});
        box.set_position(r.x, r.y);
        box.set_size(r.width, r.height);
        return box;
    }

    // Region outlines follow the layout (they move during a resize); during a
    // move, the preview shows the drop target.
    _updateOverlay() {
        const grab = this._grab;
        const area = grab && this._area(grab.ws);
        if (!this._overlay || !area)
            return;
        this._restackOverlay();
        const layout = this._layout(grab.ws);
        const {regions} = Model.computeLayout(layout, area, GAPS, this._visible, this._minSize);
        regions.forEach((r, i) => {
            this._regionBoxes[i].set_position(r.x, r.y);
            this._regionBoxes[i].set_size(r.width, r.height);
        });
        if (grab.kind !== 'move') {
            this._updateLabels(layout, area);
            return;
        }
        const target = Model.dropTarget(layout, area, GAPS, this._pointer(),
            grab.win, this._minSize, this._visible);
        if (!target?.rect) {
            this._preview.hide(); // no change, or floating where it's dropped
            return;
        }
        // Blue: split. Green: swap. Red: no room.
        this._preview.style_class = !target.fits ? 'triptych-preview refused'
            : target.swap ? 'triptych-preview swap' : 'triptych-preview';
        this._preview.set_position(target.rect.x, target.rect.y);
        this._preview.set_size(target.rect.width, target.rect.height);
        this._preview.show();
    }

    // Each size label sits on its boundary, next to the pointer. A corner
    // drag has two.
    _updateLabels(layout, area) {
        const grab = this._grab;
        const p = this._pointer();
        grab.edges.forEach((edge, i) => {
            const label = this._labels[i];
            const b = Model.boundaryInfo(layout, area, GAPS, grab.win, edge, this._minSize,
                this._visible);
            label.visible = !!b;
            if (!b)
                return;
            const [before, after] = b.percents;
            label.text = b.axis === 'row' ? `${before}%  │  ${after}%` : `${before}%\n${after}%`;
            const [, w] = label.get_preferred_width(-1);
            const [, h] = label.get_preferred_height(w);
            const along = (pointer, size) =>
                Math.min(Math.max(pointer + LABEL_OFFSET, b.start), b.end - size);
            if (b.axis === 'row')
                label.set_position(Math.round(b.pos - w / 2), Math.round(along(p.y, h)));
            else
                label.set_position(Math.round(along(p.x, w)), Math.round(b.pos - h / 2));
        });
    }

    // Outlines go just above the wallpaper, under every window. The preview
    // goes just under the grabbed window, over the windows it would displace.
    // Mutter reorders window_group on every restack, so this runs on every
    // update.
    _restackOverlay() {
        const group = global.window_group;
        group.set_child_above_sibling(this._overlay, Main.layoutManager._backgroundGroup);
        const actor = this._grab?.win.get_compositor_private();
        if (actor?.get_parent() === group)
            group.set_child_below_sibling(this._preview, actor);
        else
            group.set_child_above_sibling(this._preview, null);
    }

    _hideOverlay() {
        this._overlay?.destroy();
        this._preview?.destroy();
        this._labels?.forEach(label => label.destroy());
        this._overlay = null;
        this._preview = null;
        this._regionBoxes = null;
        this._labels = null;
    }
}
