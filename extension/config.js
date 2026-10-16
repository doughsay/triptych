// Every tunable lives here. There is deliberately no preferences UI (see
// docs/requirements.md, "Simplicity rule").

// Relative widths of the regions, left to right. [1, 2, 1] = 25% / 50% / 25%.
export const REGION_SIZES = [1, 2, 1];

// Gaps in logical pixels: around the screen edge, between regions, and between
// windows inside a region. The region gap is larger so regions read as separate.
export const GAPS = {outer: 8, region: 24, inner: 8};

// Smallest width/height a region or split pane can be dragged down to. New
// windows float instead of splitting a pane below this.
export const MIN_SIZE = 240;

// A dragged region or split boundary has soft stops at multiples of
// RESIZE_SNAP (of the screen width for regions, of the split for splits): it
// holds at one while the pointer is within SNAP_DISTANCE logical pixels of it,
// then catches up smoothly, without jumping. In small splits the distance
// shrinks to a quarter of the spacing, so there's always room in between. A window's minimum size wins over the snap. 0 turns
// snapping off.
export const RESIZE_SNAP = 0.05;
export const SNAP_DISTANCE = 20;

// Windows whose WM class (lowercased) starts with one of these are never tiled.
// steam_app_ covers Proton/Steam games. wl-copy (used by CLI tools to copy)
// opens a hidden window for a moment on compositors without data-control,
// such as Mutter.
export const FLOAT_CLASSES = [
    'steam',
    'io.github.bugaevc.wl-clipboard',
];

// Windows whose WM class (lowercased) starts with `wmClass` and whose title
// starts with `title` are never tiled. Firefox titles extension popups (e.g. a
// password manager's unlock window) "Extension: (<name>) - ...", but otherwise
// they look like normal Firefox windows. Popped-out videos are titled
// "Picture-in-Picture".
export const FLOAT_TITLES = [
    {wmClass: 'firefox', title: 'Extension: ('},
    {wmClass: 'firefox', title: 'Picture-in-Picture'},
];

// Apps often set their final title only after the window has opened, so a
// title change this soon after a window opens can still float it. Later
// changes (e.g. switching tabs) never do.
export const FLOAT_TITLE_SECONDS = 5;

// Dropping a window this close to another window's center (as a fraction of
// its size) swaps the two instead of splitting: 0.25 = the middle half in each
// direction.
export const SWAP_ZONE = 0.25;
