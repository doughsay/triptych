import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Indicator} from './indicator.js';
import {Tiler} from './tiler.js';

// The Quick Settings toggle outlives the Tiler: turning tiling off destroys the
// Tiler (windows stay where they are) and turning it on starts a fresh one.
export default class TriptychExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject('changed::tiling-enabled', () => this._sync(), this);

        this._indicator = new Indicator(this._settings, () => this._tiler && {
            get: () => this._tiler.regionsFloating(),
            set: (i, floating) => this._tiler.setRegionFloating(i, floating),
            resetSizes: () => this._tiler.resetRegionSizes(),
        });
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        // Locking doesn't disable the extension (session-modes), so hide the
        // toggle on the lock screen ourselves. The Tiler keeps running.
        Main.sessionMode.connectObject('updated', () => this._syncLocked(), this);
        this._syncLocked();
        this._sync();
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._tiler?.disable();
        this._tiler = null;
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _sync() {
        const on = this._settings.get_boolean('tiling-enabled');
        if (on && !this._tiler) {
            this._tiler = new Tiler();
            this._tiler.enable();
        } else if (!on && this._tiler) {
            this._tiler.disable();
            this._tiler = null;
        }
        this._indicator.toggle.sync();
    }

    _syncLocked() {
        this._indicator.toggle.visible = !Main.sessionMode.isLocked;
    }
}
