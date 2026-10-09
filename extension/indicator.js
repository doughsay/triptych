// Quick Settings toggle: turns tiling on and off, and its menu switches the
// regions of the current workspace between tiled and floating.

import GObject from 'gi://GObject';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {REGION_SIZES} from './config.js';

const ICON = 'view-grid-symbolic';

const REGION_NAMES = REGION_SIZES.length === 3
    ? ['Left', 'Center', 'Right']
    : REGION_SIZES.map((_, i) => `Region ${i + 1}`);

// Clicking the row of a stock switch item closes the whole menu (only a click
// on the switch itself doesn't). These just flip, so you can set several.
const RegionSwitch = GObject.registerClass(
class RegionSwitch extends PopupMenu.PopupSwitchMenuItem {
    activate() {
        this.toggle();
    }
});

const TriptychToggle = GObject.registerClass(
class TriptychToggle extends QuickSettings.QuickMenuToggle {
    // `regions()` returns { get(): bool[] (floating per region), set(i, floating),
    // resetSizes() } for the current workspace, or null while tiling is off.
    _init(settings, regions) {
        super._init({title: 'Triptych', iconName: ICON, toggleMode: true});
        this._regions = regions;
        settings.bind('tiling-enabled', this, 'checked', 0);

        this.menu.setHeader(ICON, 'Triptych', 'Tiled regions on this workspace');
        this._switches = REGION_NAMES.map((name, i) => {
            const item = new RegionSwitch(name, true);
            item.connect('toggled', (_item, tiled) => this._regions()?.set(i, !tiled));
            this.menu.addMenuItem(item);
            return item;
        });
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._reset = this.menu.addAction('Reset Region Sizes', () => this._regions()?.resetSizes());
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this.sync();
        });
        this.connect('notify::checked', () => this.sync());
        this.sync();
    }

    sync() {
        const floating = this._regions()?.get();
        this._switches.forEach((item, i) => {
            item.setSensitive(!!floating);
            item.setToggleState(floating ? !floating[i] : true);
        });
        this._reset.setSensitive(!!floating);
    }
});

export const Indicator = GObject.registerClass(
class Indicator extends QuickSettings.SystemIndicator {
    _init(settings, regions) {
        super._init();
        this.toggle = new TriptychToggle(settings, regions);
        this.quickSettingsItems.push(this.toggle);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});
