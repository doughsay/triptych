import {test} from 'node:test';
import assert from 'node:assert/strict';

import * as M from '../extension/model.js';
import {GAPS as REAL_GAPS, MIN_SIZE, REGION_SIZES} from '../extension/config.js';

const AREA = {x: 0, y: 0, width: 4000, height: 1000};
const GAPS = {outer: 0, region: 0, inner: 0};
const MIN = 100;

const layout = () => M.createLayout([1, 2, 1]);
const rects = l => M.computeLayout(l, AREA, GAPS).windows;

test('regionOrder is center first, then outward, left before right', () => {
    assert.deepEqual(M.regionOrder(1), [0]);
    assert.deepEqual(M.regionOrder(3), [1, 0, 2]);
    assert.deepEqual(M.regionOrder(5), [2, 1, 3, 0, 4]);
});

test('region rects follow sizes and gaps', () => {
    const {regions} = M.computeLayout(layout(), AREA, {outer: 10, region: 20, inner: 0});
    assert.deepEqual(regions, [
        {x: 10, y: 10, width: 985, height: 980},
        {x: 1015, y: 10, width: 1970, height: 980},
        {x: 3005, y: 10, width: 985, height: 980},
    ]);
});

test('new windows fill empty regions center, left, right', () => {
    const l = layout();
    assert.equal(M.insertWindow(l, 'a', AREA, GAPS, MIN), 1);
    assert.equal(M.insertWindow(l, 'b', AREA, GAPS, MIN), 0);
    assert.equal(M.insertWindow(l, 'c', AREA, GAPS, MIN), 2);
    const r = rects(l);
    assert.deepEqual(r.get('a'), {x: 1000, y: 0, width: 2000, height: 1000});
    assert.deepEqual(r.get('b'), {x: 0, y: 0, width: 1000, height: 1000});
    assert.deepEqual(r.get('c'), {x: 3000, y: 0, width: 1000, height: 1000});
});

test('empty regions stay empty and keep their width', () => {
    const l = layout();
    M.insertWindow(l, 'a', AREA, GAPS, MIN);
    assert.deepEqual(rects(l).get('a'), {x: 1000, y: 0, width: 2000, height: 1000});
});

test('with no empty region, the largest pane splits along its longer side', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c'])
        M.insertWindow(l, w, AREA, GAPS, MIN);
    // Center (2000x1000) is largest: side by side.
    assert.equal(M.insertWindow(l, 'd', AREA, GAPS, MIN), 1);
    // Now a, d, b and c are all 1000x1000: the tie goes to center first, then
    // tree order, so a, then d.
    assert.equal(M.insertWindow(l, 'e', AREA, GAPS, MIN), 1);
    assert.equal(M.insertWindow(l, 'f', AREA, GAPS, MIN), 1);
    // Then left, then right.
    assert.equal(M.insertWindow(l, 'g', AREA, GAPS, MIN), 0);
    assert.equal(M.insertWindow(l, 'h', AREA, GAPS, MIN), 2);
    // All 500x1000 now; the next one stacks in the first (a).
    assert.equal(M.insertWindow(l, 'i', AREA, GAPS, MIN), 1);
    const r = rects(l);
    assert.deepEqual(r.get('a'), {x: 1000, y: 0, width: 500, height: 500});
    assert.deepEqual(r.get('i'), {x: 1000, y: 500, width: 500, height: 500});
    assert.deepEqual(r.get('e'), {x: 1500, y: 0, width: 500, height: 1000});
    assert.deepEqual(r.get('h'), {x: 3500, y: 0, width: 500, height: 1000});
});

test('placement order on the real monitor with the configured gaps', () => {
    // 6144x1728 logical (7680x2160 at 125%). Gaps are ignored when comparing, so the
    // center halves tie with the side regions and the center goes first. After
    // 8 windows every pane is an eighth of the screen.
    const l = M.createLayout(REGION_SIZES);
    const area = {x: 0, y: 0, width: 6144, height: 1728};
    const order = [];
    for (let i = 0; i < 12; i++)
        order.push(M.insertWindow(l, `w${i}`, area, REAL_GAPS, MIN_SIZE));
    assert.deepEqual(order, [1, 0, 2, 1, 1, 1, 0, 2, 1, 1, 1, 1]);
});

test('focus does not affect placement', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c'])
        M.insertWindow(l, w, AREA, GAPS, MIN);
    M.setFocus(l, 'c');
    assert.equal(M.insertWindow(l, 'd', AREA, GAPS, MIN), 1);
});

test('a new window floats when no pane can split above the minimum', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c', 'd'])
        M.insertWindow(l, w, AREA, GAPS, 600);
    // Every pane is 1000x1000, and halves of 500 are under 600.
    const before = JSON.stringify(l);
    assert.equal(M.insertWindow(l, 'e', AREA, GAPS, 600), null);
    assert.equal(JSON.stringify(l), before);
    // With a lower minimum it splits.
    assert.equal(M.insertWindow(l, 'e', AREA, GAPS, 500), 1);
});

test('removing a window collapses its split; the last one empties the region', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c'])
        M.insertWindow(l, w, AREA, GAPS, MIN);
    M.insertWindow(l, 'd', AREA, GAPS, MIN);
    M.removeWindow(l, 'a');
    assert.deepEqual(rects(l).get('d'), {x: 1000, y: 0, width: 2000, height: 1000});
    M.removeWindow(l, 'd');
    assert.equal(l.regions[1].root, null);
    // The next new window goes back into the empty center.
    assert.equal(M.insertWindow(l, 'e', AREA, GAPS, MIN), 1);
});

test('invisible (minimized) windows keep their slot but take no space', () => {
    const l = layout();
    M.insertWindow(l, 'a', AREA, GAPS, MIN);
    l.regions[0].root = {win: 'x'};
    l.regions[2].root = {win: 'y'};
    M.insertWindow(l, 'b', AREA, GAPS, MIN);
    const hidden = new Set(['a']);
    const r = M.computeLayout(l, AREA, GAPS, w => !hidden.has(w)).windows;
    assert.equal(r.has('a'), false);
    assert.deepEqual(r.get('b'), {x: 1000, y: 0, width: 2000, height: 1000});
    hidden.clear();
    assert.deepEqual(rects(l).get('a'), {x: 1000, y: 0, width: 1000, height: 1000});
});

test('fill covers the region; focusing a sibling ends it', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c'])
        M.insertWindow(l, w, AREA, GAPS, MIN);
    M.insertWindow(l, 'd', AREA, GAPS, MIN);
    assert.equal(M.toggleFill(l, 'a'), true);
    assert.deepEqual(rects(l).get('a'), {x: 1000, y: 0, width: 2000, height: 1000});
    assert.equal(M.setFocus(l, 'd'), 'a');
    assert.deepEqual(rects(l).get('a'), {x: 1000, y: 0, width: 1000, height: 1000});
});

test('dropTarget: empty region fills, occupied region splits on nearest side', () => {
    const l = layout();
    M.insertWindow(l, 'a', AREA, GAPS, MIN);
    M.insertWindow(l, 'b', AREA, GAPS, MIN);
    // Right region is empty.
    assert.deepEqual(M.dropTarget(l, AREA, GAPS, {x: 3500, y: 500}, 'b', MIN),
        {region: 2, rect: {x: 3000, y: 0, width: 1000, height: 1000}, fits: true});
    // Over the right part of 'a'.
    assert.deepEqual(M.dropTarget(l, AREA, GAPS, {x: 2900, y: 500}, 'b', MIN),
        {region: 1, win: 'a', side: 'right', rect: {x: 2000, y: 0, width: 1000, height: 1000},
            fits: true});
    // Over its own (sole) region: no change.
    assert.equal(M.dropTarget(l, AREA, GAPS, {x: 500, y: 500}, 'b', MIN), null);
});

test('moveWindow splits the target on the chosen side', () => {
    const l = layout();
    M.insertWindow(l, 'a', AREA, GAPS, MIN);
    M.insertWindow(l, 'b', AREA, GAPS, MIN);
    const t = M.dropTarget(l, AREA, GAPS, {x: 2000, y: 100}, 'b', MIN);
    assert.equal(t.side, 'top');
    M.moveWindow(l, 'b', t, AREA, GAPS);
    assert.equal(l.regions[0].root, null);
    const r = rects(l);
    assert.deepEqual(r.get('b'), {x: 1000, y: 0, width: 2000, height: 500});
    assert.deepEqual(r.get('a'), {x: 1000, y: 500, width: 2000, height: 500});
});

test('a drop that would split below the minimum is refused', () => {
    const l = layout();
    M.insertWindow(l, 'a', AREA, GAPS, MIN);
    M.insertWindow(l, 'b', AREA, GAPS, MIN);
    // Right half of a (2000 wide): halves of 1000 fit 600, but not 1200.
    let t = M.dropTarget(l, AREA, GAPS, {x: 2900, y: 500}, 'b', 600);
    assert.equal(t.fits, true);
    t = M.dropTarget(l, AREA, GAPS, {x: 2900, y: 500}, 'b', 1200);
    assert.equal(t.fits, false);
    const before = JSON.stringify(l);
    assert.equal(M.moveWindow(l, 'b', t, AREA, GAPS), false);
    assert.equal(JSON.stringify(l), before);
    // A floating window (not in the layout) is refused the same way.
    assert.equal(M.moveWindow(l, 'f', t, AREA, GAPS), false);
    assert.equal(M.findWindow(l, 'f'), null);
    // When it fits, a floating window drops in like any other.
    t = M.dropTarget(l, AREA, GAPS, {x: 2900, y: 500}, 'f', 600);
    assert.equal(M.moveWindow(l, 'f', t, AREA, GAPS), true);
    assert.equal(M.findWindow(l, 'f').region, 1);
});

test('resizeEdge moves a split boundary inside a region', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c'])
        M.insertWindow(l, w, AREA, GAPS, MIN);
    M.insertWindow(l, 'd', AREA, GAPS, MIN);
    // Drag a's east edge from 2000 to 2400.
    M.resizeEdge(l, AREA, GAPS, 'a', 'e', {x: 1000, y: 0, width: 1400, height: 1000}, 100);
    const r = rects(l);
    assert.deepEqual(r.get('a'), {x: 1000, y: 0, width: 1400, height: 1000});
    assert.deepEqual(r.get('d'), {x: 2400, y: 0, width: 600, height: 1000});
});

test('resizeEdge on an outer window edge moves the region boundary', () => {
    const l = layout();
    M.insertWindow(l, 'a', AREA, GAPS, MIN);
    // Drag a's west edge from 1000 to 800; the empty left region shrinks.
    M.resizeEdge(l, AREA, GAPS, 'a', 'w', {x: 800, y: 0, width: 2200, height: 1000}, 100);
    const {regions, windows} = M.computeLayout(l, AREA, GAPS);
    assert.deepEqual(regions[0], {x: 0, y: 0, width: 800, height: 1000});
    assert.deepEqual(windows.get('a'), {x: 800, y: 0, width: 2200, height: 1000});
    // Right boundary untouched.
    assert.equal(regions[2].x, 3000);
});

test('resizeEdge clamps to the minimum size and ignores screen edges', () => {
    const l = layout();
    M.insertWindow(l, 'a', AREA, GAPS, MIN);
    M.resizeEdge(l, AREA, GAPS, 'a', 'w', {x: 10, y: 0, width: 2990, height: 1000}, 100);
    assert.equal(M.computeLayout(l, AREA, GAPS).regions[0].width, 100);
    assert.equal(M.resizeEdge(l, AREA, GAPS, 'a', 'n', {x: 100, y: 50, width: 2900, height: 950}, 100), false);
});

// Real gaps from config.js, so gap shortfalls show up.
const width = (l, w) => M.computeLayout(l, AREA, REAL_GAPS).windows.get(w).width;
const near = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) <= 1, `${actual} is not ~${expected}`);

test('resizeEdge keeps a nested neighbor split along the same axis above the minimum', () => {
    const l = layout();
    l.regions[1].root = {dir: 'row', ratio: 0.5, a: {win: 'a'},
        b: {dir: 'row', ratio: 0.5, a: {win: 'd'}, b: {win: 'e'}}};
    // Drag a's east edge almost to the screen edge.
    M.resizeEdge(l, AREA, REAL_GAPS, 'a', 'e', {x: 1000, y: 8, width: 2000, height: 984},
        MIN_SIZE);
    near(width(l, 'd'), MIN_SIZE);
    near(width(l, 'e'), MIN_SIZE);
});

test('resizeEdge keeps a nested neighbor split across the axis above the minimum', () => {
    const l = layout();
    l.regions[1].root = {dir: 'row', ratio: 0.5, a: {win: 'a'},
        b: {dir: 'column', ratio: 0.5, a: {win: 'd'}, b: {win: 'e'}}};
    M.resizeEdge(l, AREA, REAL_GAPS, 'a', 'e', {x: 1000, y: 8, width: 2000, height: 984},
        MIN_SIZE);
    near(width(l, 'd'), MIN_SIZE);
});

test('resizeEdge keeps neighbor regions above the minimum, gaps and splits included', () => {
    const l = layout();
    l.regions[0].root = {win: 'b'};
    l.regions[1].root = {win: 'a'};
    l.regions[2].root = {dir: 'row', ratio: 0.5, a: {win: 'c'}, b: {win: 'f'}};
    // a's east edge to the screen edge: the right region keeps two minimum panes.
    M.resizeEdge(l, AREA, REAL_GAPS, 'a', 'e', {x: 1000, y: 8, width: 2990, height: 984},
        MIN_SIZE);
    near(width(l, 'c'), MIN_SIZE);
    near(width(l, 'f'), MIN_SIZE);
    // a's west edge to the screen edge: the left region keeps one.
    M.resizeEdge(l, AREA, REAL_GAPS, 'a', 'w', {x: 8, y: 8, width: 3000, height: 984},
        MIN_SIZE);
    near(width(l, 'b'), MIN_SIZE);
});

// Per-window minimums: 'calc' is narrow and tall, 'wide' is wide, the rest 100.
const MINS = w => ({
    calc: {width: 600, height: 900},
    wide: {width: 900, height: 100},
    huge: {width: 1200, height: 100},
    big: {width: 1200, height: 600},
}[w] ?? {width: 100, height: 100});

test('placement respects each window\'s own minimum', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c', 'd'])
        M.insertWindow(l, w, AREA, GAPS, MINS);
    // Every pane is 1000x1000 and would split into 500x1000 halves: too narrow
    // for calc, fine for a normal window.
    assert.equal(M.insertWindow(l, 'calc', AREA, GAPS, MINS), null);
    assert.equal(M.insertWindow(l, 'e', AREA, GAPS, MINS), 1);
});

test('placement splits across the longer side when the windows only fit that way', () => {
    const l = layout();
    l.regions[0].root = {win: 'b'};
    l.regions[1].root = {win: 'a'};
    l.regions[2].root = {win: 'c'};
    // Center (2000x1000) would split side by side into 1000-wide halves, too
    // narrow for huge (1200), so it stacks instead.
    assert.equal(M.insertWindow(l, 'huge', AREA, GAPS, MINS), 1);
    assert.equal(l.regions[1].root.dir, 'column');
    // big needs 1200x600: neither direction of any pane fits it.
    assert.equal(M.insertWindow(l, 'big', AREA, GAPS, MINS), null);
});

test('a pane whose own window would drop under its minimum is not split', () => {
    const l = layout();
    l.regions[0].root = {win: 'b'};
    l.regions[1].root = {win: 'big'};
    l.regions[2].root = {win: 'c'};
    // Center is the largest pane, but either half is too small for big.
    assert.equal(M.insertWindow(l, 'd', AREA, GAPS, MINS), 0);
});

test('drops respect the minimums of both windows', () => {
    const l = layout();
    M.insertWindow(l, 'a', AREA, GAPS, MINS);
    M.insertWindow(l, 'b', AREA, GAPS, MINS);
    // Right half of a (2000 wide): halves of 1000 take calc.
    assert.equal(M.dropTarget(l, AREA, GAPS, {x: 2900, y: 500}, 'calc', MINS).fits, true);
    // Right half of b (1000 wide): halves of 500 don't.
    assert.equal(M.dropTarget(l, AREA, GAPS, {x: 900, y: 500}, 'calc', MINS).fits, false);
    // The empty right region (1000 wide) takes calc but not huge.
    assert.equal(M.dropTarget(l, AREA, GAPS, {x: 3500, y: 500}, 'calc', MINS).fits, true);
    assert.equal(M.dropTarget(l, AREA, GAPS, {x: 3500, y: 500}, 'huge', MINS).fits, false);
});

test('resizeEdge stops at a neighbor\'s own minimum', () => {
    const l = layout();
    l.regions[1].root = {dir: 'row', ratio: 0.5, a: {win: 'a'}, b: {win: 'wide'}};
    M.resizeEdge(l, AREA, GAPS, 'a', 'e', {x: 1000, y: 0, width: 1900, height: 1000}, MINS);
    assert.deepEqual(rects(l).get('wide'), {x: 2100, y: 0, width: 900, height: 1000});
});

test('shrinking a region keeps its splits above the minimum, and restores them after', () => {
    const l = layout();
    l.regions[1].root = {win: 'x'};
    l.regions[2].root = {dir: 'row', ratio: 0.8, a: {win: 'c'}, b: {win: 'f'}};
    const layoutRects = () => M.computeLayout(l, AREA, REAL_GAPS, undefined, MIN_SIZE).windows;
    // Push the right region down to its minimum (two panes plus a gap). At a
    // 0.8 ratio, f would get under 100px.
    M.resizeEdge(l, AREA, REAL_GAPS, 'x', 'e', {x: 1000, y: 8, width: 2990, height: 984},
        MIN_SIZE);
    near(layoutRects().get('c').width, MIN_SIZE);
    near(layoutRects().get('f').width, MIN_SIZE);
    // The stored ratio is untouched, so growing the region back restores it.
    assert.equal(l.regions[2].root.ratio, 0.8);
});

test('grabFrame moves only the dragged edges, by the pointer delta', () => {
    const start = {x: 100, y: 50, width: 400, height: 300};
    const p0 = {x: 500, y: 350};
    assert.deepEqual(M.grabFrame(start, p0, {x: 550, y: 360}, ['e']),
        {x: 100, y: 50, width: 450, height: 300});
    assert.deepEqual(M.grabFrame(start, p0, {x: 450, y: 360}, ['w']),
        {x: 50, y: 50, width: 450, height: 300});
    assert.deepEqual(M.grabFrame(start, p0, {x: 480, y: 450}, ['n', 'e']),
        {x: 100, y: 150, width: 380, height: 200});
});

test('a split exactly at its minimum stays there despite an uneven stored ratio', () => {
    // Real gaps, so the minimum sums aren't round numbers.
    for (const width of [3999, 4000, 4001, 3333]) {
        const area = {x: 0, y: 0, width, height: 1000};
        const l = layout();
        l.regions[1].root = {win: 'x'};
        l.regions[2].root = {dir: 'row', ratio: 0.8, a: {win: 'c'}, b: {win: 'f'}};
        M.resizeEdge(l, area, REAL_GAPS, 'x', 'e', {x: 1000, y: 8, width: width, height: 984},
            MIN_SIZE);
        const r = M.computeLayout(l, area, REAL_GAPS, undefined, MIN_SIZE).windows;
        near(r.get('c').width, MIN_SIZE);
        near(r.get('f').width, MIN_SIZE);
    }
});

test('in a filled region, any window\'s edge moves the region boundary', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c', 'd'])
        M.insertWindow(l, w, AREA, GAPS, MIN);
    M.toggleFill(l, 'a');
    // d is hidden under a, and its east edge is on the center/right boundary.
    M.resizeEdge(l, AREA, GAPS, 'd', 'e', {x: 2000, y: 0, width: 1200, height: 1000}, MIN);
    const {regions, windows} = M.computeLayout(l, AREA, GAPS);
    assert.equal(regions[1].width, 2200);
    assert.deepEqual(windows.get('a'), regions[1]);
    // a's west edge too: no split inside a filled region moves.
    const ratio = l.regions[1].root.ratio;
    M.resizeEdge(l, AREA, GAPS, 'a', 'w', {x: 1100, y: 0, width: 2100, height: 1000}, MIN);
    assert.equal(l.regions[1].root.ratio, ratio);
    assert.equal(M.computeLayout(l, AREA, GAPS).regions[1].x, 1100);
});

// --- Floating regions and swap -------------------------------------------

test('placement skips floating regions, and floats when every region is floating', () => {
    const l = layout();
    M.setRegionFloating(l, 1, true);
    assert.equal(M.insertWindow(l, 'a', AREA, GAPS, MIN), 0);
    assert.equal(M.insertWindow(l, 'b', AREA, GAPS, MIN), 2);
    assert.equal(M.insertWindow(l, 'c', AREA, GAPS, MIN), 0);
    M.setRegionFloating(l, 0, true);
    M.setRegionFloating(l, 2, true);
    assert.equal(M.insertWindow(l, 'd', AREA, GAPS, MIN), null);
});

test('setRegionFloating hands back the region\'s windows and clears its fill', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c', 'd'])
        M.insertWindow(l, w, AREA, GAPS, MIN);
    M.toggleFill(l, 'a');
    assert.deepEqual(M.setRegionFloating(l, 1, true), ['a', 'd']);
    assert.equal(l.regions[1].root, null);
    assert.equal(l.regions[1].fill, null);
    assert.equal(M.findWindow(l, 'a'), null);
    // Back to tiled: empty, ready for insertInto.
    assert.deepEqual(M.setRegionFloating(l, 1, false), []);
    assert.equal(M.insertInto(l, 'a', 1, AREA, GAPS, MIN), 1);
    assert.equal(M.insertInto(l, 'd', 1, AREA, GAPS, MIN), 1);
    assert.deepEqual(rects(l).get('d'), {x: 2000, y: 0, width: 1000, height: 1000});
});

test('insertInto refuses floating regions and regions without room', () => {
    const l = layout();
    M.setRegionFloating(l, 0, true);
    assert.equal(M.insertInto(l, 'a', 0, AREA, GAPS, MIN), null);
    // The right region is 1000 wide: huge (1200) can't fill it.
    assert.equal(M.insertInto(l, 'huge', 2, AREA, GAPS, MINS), null);
    assert.equal(M.insertInto(l, 'calc', 2, AREA, GAPS, MINS), 2);
});

test('regionAt counts gaps toward the nearer region', () => {
    const l = layout();
    const gaps = {outer: 0, region: 20, inner: 0};
    assert.equal(M.regionAt(l, AREA, gaps, {x: 500, y: 0}), 0);
    assert.equal(M.regionAt(l, AREA, gaps, {x: 1005, y: 0}), 1);
    assert.equal(M.regionAt(l, AREA, gaps, {x: 3999, y: 0}), 2);
});

test('dropping into a floating region floats the window', () => {
    const l = layout();
    for (const w of ['a', 'b'])
        M.insertWindow(l, w, AREA, GAPS, MIN);
    M.setRegionFloating(l, 2, true);
    const t = M.dropTarget(l, AREA, GAPS, {x: 3500, y: 500}, 'b', MIN);
    assert.deepEqual(t, {region: 2, rect: null, fits: true, float: true});
    assert.equal(M.moveWindow(l, 'b', t, AREA, GAPS), true);
    assert.equal(M.findWindow(l, 'b'), null);
});

test('dropping on the middle of a window swaps the two', () => {
    const l = layout();
    for (const w of ['a', 'b', 'c', 'd'])
        M.insertWindow(l, w, AREA, GAPS, MIN);
    // b (left region) dropped on the middle of d (center right half).
    const t = M.dropTarget(l, AREA, GAPS, {x: 2500, y: 500}, 'b', MIN);
    assert.equal(t.swap, true);
    assert.equal(t.win, 'd');
    assert.deepEqual(t.rect, {x: 2000, y: 0, width: 1000, height: 1000});
    assert.equal(M.moveWindow(l, 'b', t, AREA, GAPS), true);
    const r = rects(l);
    assert.deepEqual(r.get('b'), {x: 2000, y: 0, width: 1000, height: 1000});
    assert.deepEqual(r.get('d'), {x: 0, y: 0, width: 1000, height: 1000});
    // Off-center still splits.
    assert.equal(M.dropTarget(l, AREA, GAPS, {x: 2900, y: 500}, 'd', MIN).side, 'right');
});

test('a swap is refused if either window would not fit, and floating windows never swap', () => {
    const l = layout();
    l.regions[0].root = {win: 'huge'};
    l.regions[1].root = {dir: 'row', ratio: 0.5, a: {win: 'a'}, b: {win: 'd'}};
    l.regions[2].root = {win: 'c'};
    // huge (1200 wide) can't take a's 1000-wide pane.
    const t = M.dropTarget(l, AREA, GAPS, {x: 1500, y: 500}, 'huge', MINS);
    assert.equal(t.swap, true);
    assert.equal(t.fits, false);
    // A floating window (not in the layout) over a middle splits instead.
    assert.notEqual(M.dropTarget(l, AREA, GAPS, {x: 1500, y: 500}, 'f', MINS).swap, true);
});

test('resetRegionSizes restores the configured widths', () => {
    const l = layout();
    M.insertWindow(l, 'a', AREA, GAPS, MIN);
    M.resizeEdge(l, AREA, GAPS, 'a', 'w', {x: 800, y: 0, width: 2200, height: 1000}, MIN);
    assert.equal(M.computeLayout(l, AREA, GAPS).regions[0].width, 800);
    M.resetRegionSizes(l, [1, 2, 1]);
    assert.deepEqual(M.computeLayout(l, AREA, GAPS).regions.map(r => r.width), [1000, 2000, 1000]);
});

test('room for a drop is judged after the dragged window leaves its slot', () => {
    const l = layout();
    l.regions[0].root = {win: 'b'};
    l.regions[1].root = {dir: 'row', ratio: 0.5, a: {win: 'a'}, b: {win: 'huge'}};
    l.regions[2].root = {win: 'c'};
    // huge (1200 wide) onto the bottom of a: a is 800 wide now (huge's minimum
    // squeezes it), but 2000 once huge leaves, so stacking under it fits.
    const t = M.dropTarget(l, AREA, GAPS, {x: 1400, y: 900}, 'huge', MINS);
    assert.equal(t.side, 'bottom');
    assert.equal(t.fits, true);
    // The preview still shows the current size.
    assert.deepEqual(t.rect, {x: 1000, y: 500, width: 800, height: 500});
    assert.equal(M.moveWindow(l, 'huge', t, AREA, GAPS), true);
    assert.deepEqual(rects(l).get('huge'), {x: 1000, y: 500, width: 2000, height: 500});
});
