// Pure layout model. No GNOME imports: unit-tested with `node --test`.
//
// A layout belongs to one workspace. It is an ordered row of regions. Each region
// holds a binary split tree of panes (or nothing). A pane holds one window, or
// a tab group: windows that share the pane, one shown at a time, under a bar
// of tabs. Windows are opaque keys (Meta.Window in the shell, strings in
// tests).
//
//   Layout = { regions: Region[] }
//   Region = { size: number, root: Node | null, fill: win | null, floating: bool }
//   Node   = Pane | { dir: 'row' | 'column', ratio: number, a: Node, b: Node }
//   Pane   = { win } | { tabs: win[] }
//
// A tab group always has two or more windows; with one left it becomes a
// plain { win } again. Which tab shows isn't part of the layout: every window
// of a group gets the same rect, and the shell shows whichever is on top.
//
// A floating region holds no tree: windows in it float, and placement skips
// it. Floating windows aren't in the layout at all.
//
// Rects are { x, y, width, height } in logical pixels.
//
// `minSize` is either a number or a function win => { width, height } giving
// a window's smallest frame size (win is null for an empty region).

import {RESIZE_SNAP, SNAP_DISTANCE, SWAP_ZONE, TAB_BAR_HEIGHT} from './config.js';

export function createLayout(sizes) {
    return {
        regions: sizes.map(size => ({size, root: null, fill: null, floating: false})),
    };
}

// Order in which empty regions are filled: center first, then outward, left
// before right. For 3 regions: [1, 0, 2].
export function regionOrder(n) {
    const center = Math.floor((n - 1) / 2);
    const order = [center];
    for (let d = 1; order.length < n; d++) {
        if (center - d >= 0)
            order.push(center - d);
        if (center + d < n)
            order.push(center + d);
    }
    return order;
}

const isLeaf = node => !('dir' in node); // a pane

// Height a tab group's bar takes from its pane: the bar and the gap under it.
// The bar stands apart from the window because a window's rounded corners are
// up to the app and can't be matched. The gap is half the inner gap, so the
// bar reads as belonging to its window rather than as a pane of its own.
const barSpace = gap => TAB_BAR_HEIGHT + gap / 2;
const winsOf = pane => pane.tabs ?? [pane.win];

function* leaves(node) {
    if (!node)
        return;
    if (isLeaf(node)) {
        yield node;
    } else {
        yield* leaves(node.a);
        yield* leaves(node.b);
    }
}

function anyVisible(node, visible) {
    for (const leaf of leaves(node)) {
        if (winsOf(leaf).some(visible))
            return true;
    }
    return false;
}

// Path of nodes from the region root down to the window's pane.
function pathTo(node, win, path = []) {
    if (!node)
        return null;
    path.push(node);
    if (isLeaf(node)) {
        if (winsOf(node).includes(win))
            return path;
    } else if (pathTo(node.a, win, path) || pathTo(node.b, win, path)) {
        return path;
    }
    path.pop();
    return null;
}

export function findWindow(layout, win) {
    for (let i = 0; i < layout.regions.length; i++) {
        const path = pathTo(layout.regions[i].root, win);
        if (path)
            return {region: i, path};
    }
    return null;
}

export function windowsOf(layout) {
    return layout.regions.flatMap(r => [...leaves(r.root)].flatMap(winsOf));
}

function replaceNode(region, path, replacement) {
    if (path.length === 1) {
        region.root = replacement;
        return;
    }
    const parent = path[path.length - 2];
    if (parent.a === path[path.length - 1])
        parent.a = replacement;
    else
        parent.b = replacement;
}

// --- Geometry -----------------------------------------------------------

function inset(area, gaps) {
    return {
        x: area.x + gaps.outer,
        y: area.y + gaps.outer,
        width: area.width - 2 * gaps.outer,
        height: area.height - 2 * gaps.outer,
    };
}

// Left edge (before gaps) of each region, plus the right edge of the last one.
function regionEdges(layout, area, gaps) {
    const inner = inset(area, gaps);
    const total = layout.regions.reduce((s, r) => s + r.size, 0);
    const edges = [inner.x];
    let acc = 0;
    for (const r of layout.regions) {
        acc += r.size;
        edges.push(inner.x + inner.width * acc / total);
    }
    return {edges, inner};
}

function regionRectsF(layout, area, gaps) {
    const {edges, inner} = regionEdges(layout, area, gaps);
    const n = layout.regions.length;
    return layout.regions.map((_, i) => {
        const left = edges[i] + (i > 0 ? gaps.region / 2 : 0);
        const right = edges[i + 1] - (i < n - 1 ? gaps.region / 2 : 0);
        return {x: left, y: inner.y, width: right - left, height: inner.height};
    });
}

function splitRect(r, dir, ratio, gap) {
    if (dir === 'row') {
        const p = r.x + r.width * ratio;
        return [
            {x: r.x, y: r.y, width: p - gap / 2 - r.x, height: r.height},
            {x: p + gap / 2, y: r.y, width: r.x + r.width - p - gap / 2, height: r.height},
        ];
    }
    const p = r.y + r.height * ratio;
    return [
        {x: r.x, y: r.y, width: r.width, height: p - gap / 2 - r.y},
        {x: r.x, y: p + gap / 2, width: r.width, height: r.y + r.height - p - gap / 2},
    ];
}

// Lays out a tree into `out` (window -> rect). Subtrees with no visible
// windows collapse, so their sibling takes the space. A split whose ratio
// would put a window under its minimum is clamped for this layout only (the
// stored ratio is kept for when there's room again). A tab group's bar takes
// the top TAB_BAR_HEIGHT of its pane, with half a gap under it. opts = { gap, visible, mins, nodeRects?,
// panes?, bars? }: `nodeRects` receives the rect of every split that actually
// divides space, `panes` the rect of every shown pane, and `bars` gets
// { group, rect } for every shown tab bar.
function tile(node, r, opts, out) {
    if (!node)
        return;
    const {gap, visible, mins} = opts;
    if (isLeaf(node)) {
        const shown = winsOf(node).filter(visible);
        if (shown.length === 0)
            return;
        opts.panes?.set(node, r);
        if (node.tabs) {
            opts.bars?.push({group: node, rect: {...r, height: TAB_BAR_HEIGHT}});
            r = {...r, y: r.y + barSpace(gap), height: r.height - barSpace(gap)};
        }
        for (const win of shown)
            out.set(win, r);
        return;
    }
    const va = anyVisible(node.a, visible);
    const vb = anyVisible(node.b, visible);
    if (!va || !vb) {
        tile(va ? node.a : node.b, r, opts, out);
        return;
    }
    opts.nodeRects?.set(node, r);
    const [ra, rb] = splitRect(r, node.dir, shownRatio(node, r, gap, mins, visible), gap);
    tile(node.a, ra, opts, out);
    tile(node.b, rb, opts, out);
}

// The ratio a split is laid out at in rect `r`: its stored ratio, clamped so
// both sides stay above their minimums.
function shownRatio(node, r, gap, mins, visible) {
    const len = along(r, node.dir);
    const lo = (minExtent(node.a, node.dir, gap, mins, visible) + gap / 2) / len;
    const hi = 1 - (minExtent(node.b, node.dir, gap, mins, visible) + gap / 2) / len;
    // With no room for both minimums (or exactly none, give or take float
    // noise), share the shortfall evenly rather than fall back to the ratio.
    return lo <= hi ? clamp(node.ratio, lo, hi) : (lo + hi) / 2;
}

// Round edges (not sizes) so adjacent rects never drift apart by a pixel.
function round(r) {
    const x = Math.round(r.x), y = Math.round(r.y);
    return {
        x, y,
        width: Math.round(r.x + r.width) - x,
        height: Math.round(r.y + r.height) - y,
    };
}

const always = () => true;

// A filled region shows no tab bars: the filled window covers them.
function computeF(layout, area, gaps, visible, minSize, nodeRects) {
    const regions = regionRectsF(layout, area, gaps);
    const windows = new Map();
    const bars = [];
    layout.regions.forEach((region, i) => {
        const opts = {gap: gaps.inner, visible, mins: minOf(minSize), nodeRects, bars: []};
        tile(region.root, regions[i], opts, windows);
        if (region.fill && windows.has(region.fill))
            windows.set(region.fill, regions[i]);
        else
            bars.push(...opts.bars);
    });
    return {regions, windows, bars};
}

// Final pixel rects: { regions: Rect[], windows: Map<win, Rect>, tabBars }.
// Windows for which `visible(win)` is false get no rect and take no space.
// tabBars = [{ group, wins, rect }]: each shown tab group (an opaque key that
// stays the same while the group lasts), its windows in tab order (hidden ones
// too), and its bar.
export function computeLayout(layout, area, gaps, visible = always, minSize = 0) {
    const {regions, windows, bars} = computeF(layout, area, gaps, visible, minSize);
    for (const [win, r] of windows)
        windows.set(win, round(r));
    const tabBars = bars.map(({group, rect}) => ({group, wins: [...group.tabs], rect: round(rect)}));
    return {regions: regions.map(round), windows, tabBars};
}

// --- Mutations ----------------------------------------------------------

// Splits the pane holding `leafWin` (a tab group splits as a whole).
function splitLeaf(region, leafWin, win, dir, newFirst) {
    const path = pathTo(region.root, leafWin);
    const leaf = path[path.length - 1];
    const added = {win};
    replaceNode(region, path, {
        dir,
        ratio: 0.5,
        a: newFirst ? added : leaf,
        b: newFirst ? leaf : added,
    });
}

// Splits run along the longer side (Q2).
const splitDir = r => r.height > r.width ? 'column' : 'row';

const NO_GAPS = {outer: 0, region: 0, inner: 0};

// Pane rects (unrounded) of the given regions, in region then tree order:
// Map<pane, rect>. Fill is ignored.
function paneRects(layout, area, gaps, regionIndexes, minSize, visible = always) {
    const regions = regionRectsF(layout, area, gaps);
    const panes = new Map();
    const opts = {gap: gaps.inner, visible, mins: minOf(minSize), panes};
    for (const i of regionIndexes)
        tile(layout.regions[i].root, regions[i], opts, new Map());
    return panes;
}

const minOf = minSize => typeof minSize === 'function'
    ? minSize : () => ({width: minSize, height: minSize});

// Extent of a size along `axis`.
const along = (size, axis) => axis === 'row' ? size.width : size.height;

// Whether `win` fits in rect `r`.
function fitsIn(r, win, mins) {
    const m = mins(win);
    return r.width >= m.width && r.height >= m.height;
}

// Smallest size of a pane: a tab group needs room for its largest window
// (hidden ones too) plus the bar.
function paneMin(pane, mins, gap) {
    if (!pane.tabs)
        return mins(pane.win);
    const all = pane.tabs.map(mins);
    return {
        width: Math.max(...all.map(m => m.width)),
        height: Math.max(...all.map(m => m.height)) + barSpace(gap),
    };
}

function paneFits(r, pane, mins, gap) {
    const m = paneMin(pane, mins, gap);
    return r.width >= m.width && r.height >= m.height;
}

// Whether pane `pane` at rect `r` can split in half along `dir` with both it
// and `win` at least their minimum size.
function canSplit(r, dir, gap, pane, win, mins) {
    const [half] = splitRect(r, dir, 0.5, gap);
    return paneFits(half, pane, mins, gap) && fitsIn(half, win, mins);
}

// Splits the largest pane in `regionIndexes` that can take `win` above both
// windows' minimums, new window after it (right / below). The split runs along
// the pane's longer side, or across it if the windows only fit that way. Sizes are compared
// without gaps, so equal tree fractions tie; ties go to the first pane (region
// order, then tree order). Minimums apply to the real, gapped size. Returns
// the region index, or null if nothing can split.
function splitLargest(layout, win, area, gaps, regionIndexes, minSize) {
    const mins = minOf(minSize);
    const real = paneRects(layout, area, gaps, regionIndexes, minSize);
    const bare = paneRects(layout, area, NO_GAPS, regionIndexes, 0);
    let best = null;
    for (const [pane, r] of bare) {
        const size = r.width * r.height;
        // + 0.5 so float noise can't break a tie.
        if (best && size <= best.size + 0.5)
            continue;
        const preferred = splitDir(r);
        const dir = [preferred, preferred === 'row' ? 'column' : 'row'].find(d =>
            canSplit(real.get(pane), d, gaps.inner, pane, win, mins));
        if (dir)
            best = {leafWin: winsOf(pane)[0], dir, size};
    }
    if (!best)
        return null;
    const region = findWindow(layout, best.leafWin).region;
    splitLeaf(layout.regions[region], best.leafWin, win, best.dir, false);
    return region;
}

// Placement policy (requirements R10), over tiled regions only. Returns the
// region index used, or null if nothing has room, in which case the window
// floats.
export function insertWindow(layout, win, area, gaps, minSize) {
    const order = regionOrder(layout.regions.length).filter(i => !layout.regions[i].floating);
    for (const i of order) {
        if (!layout.regions[i].root && insertInto(layout, win, i, area, gaps, minSize) !== null)
            return i;
    }
    return splitLargest(layout, win, area, gaps, order, minSize);
}

// Placement at a point (R10), usually the pointer. Over a pane, that pane
// splits along its longer side (or across it, if the windows only fit that way)
// and the new window takes the half the point is in. Over an empty region, it
// fills it. If the pane can't split, the region's largest pane that can splits
// instead, and failing that the usual placement applies. So does a point
// outside `area` or in a floating region. Panes are hit-tested as shown, minus
// any fill: minimized windows take no space.
export function insertAt(layout, win, point, area, gaps, minSize, visible = always) {
    const regions = regionRectsF(layout, area, gaps);
    const i = regionIndexAt(regions, gaps, point);
    if (!contains(area, point) || layout.regions[i].floating)
        return insertWindow(layout, win, area, gaps, minSize);
    const mins = minOf(minSize);
    const panes = paneRects(layout, area, gaps, [i], minSize, visible);
    // The pane under the point, or failing that the nearest one.
    let best = null, bestDist = Infinity;
    for (const [pane, r] of panes) {
        const d = distance(r, point);
        if (d < bestDist) {
            best = {pane, r};
            bestDist = d;
        }
    }
    if (best) {
        const {pane, r} = best;
        const preferred = splitDir(r);
        const dir = [preferred, preferred === 'row' ? 'column' : 'row'].find(d =>
            canSplit(r, d, gaps.inner, pane, win, mins));
        if (dir) {
            const newFirst = dir === 'row'
                ? point.x < r.x + r.width / 2
                : point.y < r.y + r.height / 2;
            splitLeaf(layout.regions[i], winsOf(pane)[0], win, dir, newFirst);
            return i;
        }
    }
    return insertInto(layout, win, i, area, gaps, minSize) ??
        insertWindow(layout, win, area, gaps, minSize);
}

// Tiles `win` into region `i`: fills it if empty, else splits its largest pane
// that has room. Returns i, or null if the region is floating or has no room.
export function insertInto(layout, win, i, area, gaps, minSize) {
    const region = layout.regions[i];
    if (region.floating)
        return null;
    if (region.root)
        return splitLargest(layout, win, area, gaps, [i], minSize);
    if (!fitsIn(regionRectsF(layout, area, gaps)[i], win, minOf(minSize)))
        return null;
    region.root = {win};
    return i;
}

// Switches region `i` between tiled and floating. Going floating, its windows
// leave the tree and are returned: they float where they are. Going tiled, the
// region starts empty (the caller re-tiles whichever floating windows it wants).
export function setRegionFloating(layout, i, floating) {
    const region = layout.regions[i];
    const wins = [...leaves(region.root)].flatMap(winsOf);
    region.floating = floating;
    if (floating) {
        region.root = null;
        region.fill = null;
        return wins;
    }
    return [];
}

// Puts region widths back to `sizes` (the configured defaults).
export function resetRegionSizes(layout, sizes) {
    layout.regions.forEach((r, i) => {
        r.size = sizes[i];
    });
}

// What persists of a layout: region widths and tiled/floating modes (not
// which windows were where).
export function saveLayout(layout) {
    return {
        sizes: layout.regions.map(r => r.size),
        floating: layout.regions.map(r => r.floating),
    };
}

// Applies a saved state to a fresh layout. Ignored if it doesn't match the
// region count (the config changed) or isn't well formed.
export function restoreLayout(layout, saved) {
    const n = layout.regions.length;
    const ok = saved && Array.isArray(saved.sizes) && Array.isArray(saved.floating) &&
        saved.sizes.length === n && saved.floating.length === n &&
        saved.sizes.every(v => typeof v === 'number' && v > 0);
    if (!ok)
        return false;
    layout.regions.forEach((r, i) => {
        r.size = saved.sizes[i];
        r.floating = !!saved.floating[i];
    });
    return true;
}

// Index of the region under `point` (gaps count toward the nearer region).
export function regionAt(layout, area, gaps, point) {
    return regionIndexAt(regionRectsF(layout, area, gaps), gaps, point);
}

function regionIndexAt(regions, gaps, point) {
    return regions.findIndex((r, i) =>
        i === regions.length - 1 || point.x < r.x + r.width + gaps.region / 2);
}

// A window leaving a tab group of two leaves a plain pane, changed in place.
export function removeWindow(layout, win) {
    const found = findWindow(layout, win);
    if (!found)
        return false;
    const region = layout.regions[found.region];
    const {path} = found;
    const pane = path.at(-1);
    if (pane.tabs) {
        pane.tabs = pane.tabs.filter(w => w !== win);
        if (pane.tabs.length === 1) {
            pane.win = pane.tabs[0];
            delete pane.tabs;
        }
    } else if (path.length === 1) {
        region.root = null;
    } else {
        const parent = path[path.length - 2];
        const sibling = parent.a === path[path.length - 1] ? parent.b : parent.a;
        replaceNode(region, path.slice(0, -1), sibling);
    }
    if (region.fill === win)
        region.fill = null;
    return true;
}

// Focusing another window in a filled region ends the fill. Returns the
// window that stopped filling, or null.
export function setFocus(layout, win) {
    const found = findWindow(layout, win);
    if (!found)
        return null;
    const region = layout.regions[found.region];
    const fill = region.fill;
    if (!fill || fill === win)
        return null;
    region.fill = null;
    return fill;
}

// Maximize toggles "fill the region" (R7). Returns the new state.
export function toggleFill(layout, win) {
    const found = findWindow(layout, win);
    if (!found)
        return false;
    const region = layout.regions[found.region];
    region.fill = region.fill === win ? null : win;
    return region.fill === win;
}

// Moves a window to a drop target from dropTarget(). A target that doesn't
// fit is refused: nothing changes. A float target takes the window out of the
// tree, leaving it where it was dropped.
export function moveWindow(layout, win, target, area, gaps) {
    if (!target?.fits || target.win === win)
        return false;
    if (target.swap)
        return swapWindows(layout, win, target.win);
    removeWindow(layout, win);
    if (target.float)
        return true;
    const region = layout.regions[target.region];
    const path = target.win && pathTo(region.root, target.win);
    if (path && target.tab) {
        addTab(path.at(-1), win);
    } else if (path) {
        const dir = target.side === 'left' || target.side === 'right' ? 'row' : 'column';
        const newFirst = target.side === 'left' || target.side === 'top';
        splitLeaf(region, target.win, win, dir, newFirst);
    } else if (!region.root) {
        region.root = {win};
    } else {
        // Only hidden windows here: no size limit, the drop was deliberate.
        splitLargest(layout, win, area, gaps, [target.region], 0);
    }
    return true;
}

// Adds `win` as the last tab of `pane`, turning a plain pane into a group.
function addTab(pane, win) {
    if (!pane.tabs) {
        pane.tabs = [pane.win];
        delete pane.win;
    }
    pane.tabs.push(win);
}

// Exchanges the slots of two tiled windows in plain panes. A fill on either
// ends.
function swapWindows(layout, a, b) {
    const fa = findWindow(layout, a), fb = findWindow(layout, b);
    if (!fa || !fb)
        return false;
    fa.path.at(-1).win = b;
    fb.path.at(-1).win = a;
    for (const f of [fa, fb]) {
        const region = layout.regions[f.region];
        if (region.fill === a || region.fill === b)
            region.fill = null;
    }
    return true;
}

// --- Mouse helpers ------------------------------------------------------

// Where a dragged window would land if dropped at `point`. Returns
// { region, win?, side?, rect, fits, float?, swap?, tab? } (rect = preview),
// or null for "no change". `fits` is false when a window would end up under
// its minimum size. In a floating region the target is { float: true } with
// no rect. Over a pane, the middle (SWAP_ZONE) and a tab bar add the window
// as a tab, except that the lower half of the middle of a plain pane swaps
// two tiled windows that aren't in tab groups. Elsewhere the pane splits on
// the nearest side. A window can be dragged out of its own tab group by
// splitting the group.
export function dropTarget(layout, area, gaps, point, dragged, minSize, visible = always) {
    const mins = minOf(minSize);
    const {regions, windows} = computeLayout(layout, area, gaps, visible, minSize);
    const ri = regionIndexAt(regions, gaps, point);
    const region = layout.regions[ri];
    if (region.floating)
        return {region: ri, rect: null, fits: true, float: true};
    const ownPane = findWindow(layout, dragged)?.path.at(-1);
    // Panes of the region, but not the dragged window's own plain pane.
    const others = [...paneRects(layout, area, gaps, [ri], minSize, visible)]
        .filter(([pane]) => pane !== ownPane || pane.tabs)
        .map(([pane, r]) => [pane, round(r)]);

    if (others.length === 0) {
        if (findWindow(layout, dragged)?.region === ri && !region.root?.dir)
            return null;
        return {region: ri, rect: regions[ri], fits: fitsIn(regions[ri], dragged, mins)};
    }

    const own = ownPane && !ownPane.tabs ? windows.get(dragged) : null;
    if (own && contains(own, point))
        return null;

    // The pane under the pointer, or failing that the nearest one.
    let best = null, bestDist = Infinity;
    for (const [pane, r] of others) {
        const d = distance(r, point);
        if (d < bestDist) {
            best = [pane, r];
            bestDist = d;
        }
    }
    const [pane, r] = best;
    const win = winsOf(pane).find(w => w !== dragged);
    const onBar = pane.tabs && contains({...r, height: TAB_BAR_HEIGHT}, point);
    const dx = (point.x - (r.x + r.width / 2)) / r.width;
    const dy = (point.y - (r.y + r.height / 2)) / r.height;
    const middle = Math.abs(dx) < SWAP_ZONE && Math.abs(dy) < SWAP_ZONE;
    if ((onBar || middle) && pane === ownPane)
        return null;
    if (middle && own && !pane.tabs && dy >= 0) {
        const fits = fitsIn(r, dragged, mins) && fitsIn(own, win, mins);
        return {region: ri, win, side: 'center', rect: r, fits, swap: true};
    }

    // Room is judged after the dragged window leaves its slot, which can make
    // the target bigger (moving within a region). The preview stays as is.
    let after = r, afterPane = pane;
    if (ownPane) {
        const without = cloneLayout(layout);
        removeWindow(without, dragged);
        const found = [...paneRects(without, area, gaps, [ri], minSize, visible)]
            .find(([p]) => winsOf(p).includes(win));
        if (!found)
            return null; // the rest of its own group is hidden
        [afterPane, after] = found;
    }
    if (onBar || middle) {
        const fits = paneFits(after, {tabs: [...winsOf(afterPane), dragged]}, mins, gaps.inner);
        return {region: ri, win, side: 'center', rect: r, fits, tab: true};
    }
    const side = Math.abs(dx) > Math.abs(dy)
        ? (dx < 0 ? 'left' : 'right')
        : (dy < 0 ? 'top' : 'bottom');
    const dir = side === 'left' || side === 'right' ? 'row' : 'column';
    const fits = canSplit(after, dir, gaps.inner, afterPane, dragged, mins);
    return {region: ri, win, side, rect: half(r, side), fits};
}

// Copies the trees (windows stay the same objects).
function cloneLayout(layout) {
    const cloneNode = n => {
        if (!n)
            return n;
        if (isLeaf(n))
            return n.tabs ? {tabs: [...n.tabs]} : {...n};
        return {...n, a: cloneNode(n.a), b: cloneNode(n.b)};
    };
    return {regions: layout.regions.map(r => ({...r, root: cloneNode(r.root)}))};
}

function contains(r, p) {
    return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

function distance(r, p) {
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
    return Math.hypot(dx, dy);
}

function half(r, side) {
    const w = Math.round(r.width / 2), h = Math.round(r.height / 2);
    switch (side) {
    case 'left': return {...r, width: w};
    case 'right': return {...r, x: r.x + r.width - w, width: w};
    case 'top': return {...r, height: h};
    default: return {...r, y: r.y + r.height - h, height: h};
    }
}

// The boundary that edge `edge` ('n' | 's' | 'e' | 'w') of `win` sits on:
// the innermost split along that axis with `win` on the dragged side, else the
// region boundary on that side. In a filled region only the region shows, so
// it's always the region boundary. Returns {node, rect} (the split and its
// unrounded rect), {region: j} (the boundary right of region j), or null.
function boundaryOf(layout, area, gaps, win, edge, minSize, visible) {
    const found = findWindow(layout, win);
    if (!found)
        return null;
    const axis = edge === 'e' || edge === 'w' ? 'row' : 'column';
    const inFirst = edge === 'e' || edge === 's';
    if (!layout.regions[found.region].fill) {
        const nodeRects = new Map();
        computeF(layout, area, gaps, visible, minSize, nodeRects);
        const {path} = found;
        for (let i = path.length - 2; i >= 0; i--) {
            const node = path[i];
            const rect = nodeRects.get(node);
            if (rect && node.dir === axis && (node.a === path[i + 1]) === inFirst)
                return {node, rect};
        }
    }
    if (axis !== 'row')
        return null;
    const j = edge === 'e' ? found.region : found.region - 1;
    return j >= 0 && j < layout.regions.length - 1 ? {region: j} : null;
}

// The user dragged edge `edge` of `win` so that its frame is now `frame`.
// Moves the split or region boundary on that edge to follow, snapping to
// multiples of RESIZE_SNAP (of the split, or of the screen width for a region
// boundary) when close. Returns true if anything changed.
export function resizeEdge(layout, area, gaps, win, edge, frame, minSize, visible = always) {
    const mins = minOf(minSize);
    const boundary = boundaryOf(layout, area, gaps, win, edge, minSize, visible);
    if (!boundary)
        return false;

    if (boundary.node) {
        const {node, rect} = boundary;
        const axis = node.dir;
        // A tab group's top edge is its bar's, above the window.
        const bar = edge === 'n' && findWindow(layout, win).path.at(-1).tabs
            ? barSpace(gaps.inner) : 0;
        const pos = edgePos(frame, edge, gaps.inner) - bar;
        const [start, len] = axis === 'row' ? [rect.x, rect.width] : [rect.y, rect.height];
        const lo = start + minExtent(node.a, axis, gaps.inner, mins, visible) + gaps.inner / 2;
        const hi = start + len - minExtent(node.b, axis, gaps.inner, mins, visible) -
            gaps.inner / 2;
        if (lo > hi)
            return false;
        node.ratio = snap((pos - start) / len, (lo - start) / len, (hi - start) / len, len);
        return true;
    }

    const j = boundary.region;
    const {edges, inner} = regionEdges(layout, area, gaps);
    const start = edges[j], end = edges[j + 2];
    // Outer edges of the two regions' content, and the gap each loses at b.
    const left = start + (j > 0 ? gaps.region / 2 : 0);
    const right = end - (j + 2 < layout.regions.length ? gaps.region / 2 : 0);
    const regionMin = k => Math.max(mins(null).width, layout.regions[k].root
        ? minExtent(layout.regions[k].root, 'row', gaps.inner, mins, visible) : 0);
    const lo = left + regionMin(j) + gaps.region / 2;
    const hi = right - regionMin(j + 1) - gaps.region / 2;
    if (lo > hi)
        return false;
    // Snap as a fraction of the whole row, so region sizes come out round.
    const frac = x => (x - inner.x) / inner.width;
    const b = inner.x + inner.width *
        snap(frac(edgePos(frame, edge, gaps.region)), frac(lo), frac(hi), inner.width);
    const pair = layout.regions[j].size + layout.regions[j + 1].size;
    layout.regions[j].size = pair * (b - start) / (end - start);
    layout.regions[j + 1].size = pair - layout.regions[j].size;
    return true;
}

// The boundary under edge `edge` of `win`, for the size label shown while it's
// dragged: { axis, pos, start, end, percents: [before, after] }. The boundary
// is the line x = pos ('row') or y = pos ('column') from start to end.
// Percents are whole numbers: of the screen width for a region boundary, of
// the split for a split boundary. null if the edge isn't on a boundary.
export function boundaryInfo(layout, area, gaps, win, edge, minSize, visible = always) {
    const boundary = boundaryOf(layout, area, gaps, win, edge, minSize, visible);
    if (!boundary)
        return null;
    if (boundary.node) {
        const {node, rect} = boundary;
        const ratio = shownRatio(node, rect, gaps.inner, minOf(minSize), visible);
        const a = Math.round(ratio * 100);
        return node.dir === 'row'
            ? {axis: 'row', pos: rect.x + rect.width * ratio, start: rect.y,
                end: rect.y + rect.height, percents: [a, 100 - a]}
            : {axis: 'column', pos: rect.y + rect.height * ratio, start: rect.x,
                end: rect.x + rect.width, percents: [a, 100 - a]};
    }
    const j = boundary.region;
    const {edges, inner} = regionEdges(layout, area, gaps);
    const total = layout.regions.reduce((s, r) => s + r.size, 0);
    const pct = k => layout.regions.slice(0, k).reduce((s, r) => s + r.size, 0) / total * 100;
    // Rounded cumulatively, so the two always add up to the pair's share.
    const [x, y, z] = [pct(j), pct(j + 1), pct(j + 2)].map(Math.round);
    return {axis: 'row', pos: edges[j + 1], start: inner.y, end: inner.y + inner.height,
        percents: [y - x, z - y]};
}

// The frame a resize grab asks for: the grab-start frame with the dragged
// edges moved as far as the pointer has moved. Mutter's own proposed rect
// can't be used: it is anchored at the window's current position, which the
// layout keeps moving, and it is re-run with our own result when the client
// acks, so either way it drifts from the pointer.
export function grabFrame(start, pointerStart, pointer, edges) {
    const dx = pointer.x - pointerStart.x, dy = pointer.y - pointerStart.y;
    const f = {...start};
    if (edges.includes('e'))
        f.width += dx;
    if (edges.includes('w')) {
        f.x += dx;
        f.width -= dx;
    }
    if (edges.includes('s'))
        f.height += dy;
    if (edges.includes('n')) {
        f.y += dy;
        f.height -= dy;
    }
    return f;
}

// Smallest extent of a subtree along `axis` that keeps every visible window in
// it at least its minimum size. Hidden subtrees collapse and need nothing.
function minExtent(node, axis, gap, mins, visible) {
    if (isLeaf(node))
        return along(paneMin(node, mins, gap), axis);
    const va = anyVisible(node.a, visible);
    const vb = anyVisible(node.b, visible);
    if (!va || !vb)
        return va || vb ? minExtent(va ? node.a : node.b, axis, gap, mins, visible) : 0;
    const a = minExtent(node.a, axis, gap, mins, visible);
    const b = minExtent(node.b, axis, gap, mins, visible);
    return node.dir === axis ? a + gap + b : Math.max(a, b);
}

// Position of the boundary implied by a window edge, accounting for the gap.
function edgePos(frame, edge, gap) {
    switch (edge) {
    case 'e': return frame.x + frame.width + gap / 2;
    case 'w': return frame.x - gap / 2;
    case 's': return frame.y + frame.height + gap / 2;
    default: return frame.y - gap / 2;
    }
}

function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
}

// Fraction `v` of a length of `len` pixels, with soft stops at multiples of
// RESIZE_SNAP: within SNAP_DISTANCE pixels of one (or a quarter of the
// spacing, if less) the boundary holds there, and in between it moves a bit
// faster than the pointer to catch up, meeting it halfway between stops. So it
// never jumps. Then clamped to [lo, hi], so a boundary held by a minimum size
// can still reach it.
function snap(v, lo, hi, len) {
    if (RESIZE_SNAP > 0) {
        const spacing = RESIZE_SNAP * len;
        const reach = Math.min(SNAP_DISTANCE, spacing / 4);
        const stop = Math.round(v / RESIZE_SNAP) * RESIZE_SNAP;
        const d = (v - stop) * len; // pixels from the stop, at most spacing / 2
        const free = Math.max(Math.abs(d) - reach, 0);
        v = stop + Math.sign(d) * free * (spacing / 2) / (spacing / 2 - reach) / len;
    }
    return clamp(v, lo, hi);
}

// Whether a window matches one of the `FLOAT_TITLES` rules: its WM class
// (lowercased) starts with the rule's `wmClass` and its title starts with the
// rule's `title`.
export function matchesTitleRule(wmClass, title, rules) {
    wmClass = (wmClass ?? '').toLowerCase();
    return rules.some(r => wmClass.startsWith(r.wmClass) && (title ?? '').startsWith(r.title));
}
