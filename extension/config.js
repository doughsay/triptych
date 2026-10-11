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

// Windows whose WM class (lowercased) starts with one of these are never tiled.
// steam_app_ covers Proton/Steam games.
export const FLOAT_CLASSES = [
    'steam',
];

// Windows whose WM class (lowercased) starts with `wmClass` and whose title
// starts with `title` are never tiled. Firefox titles extension popups (e.g. a
// password manager's unlock window) "Extension: (<name>) - ...", but otherwise
// they look like normal Firefox windows.
export const FLOAT_TITLES = [
    {wmClass: 'firefox', title: 'Extension: ('},
];

// Apps often set their final title only after the window has opened, so a
// title change this soon after a window opens can still float it. Later
// changes (e.g. switching tabs) never do.
export const FLOAT_TITLE_SECONDS = 5;

// Dropping a window this close to another window's center (as a fraction of
// its size) swaps the two instead of splitting: 0.25 = the middle half in each
// direction.
export const SWAP_ZONE = 0.25;
