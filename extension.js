/**
 * Overview Toggle Always on Top — GNOME Shell 45-50
 *
 * - Auto-pins PiP windows (Chrome/Firefox) on open
 * - Right-click any window in the Overview to toggle always-on-top
 * - 📌 badge overlay on pinned windows in the Overview
 * - Badge tracks all always-on-top changes (internal and external)
 * - Badge color follows the GNOME accent color
 * - No menu entry / no badge for fullscreen or maximized windows
 * - GSettings: pip-size-percent / pip-size-pixels / pip-position control PiP start geometry
 * - GSettings: pip-extra-titles for custom PiP window title fragments
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WindowPreview from 'resource:///org/gnome/shell/ui/windowPreview.js';
import {
    PopupSeparatorMenuItem,
    PopupSwitchMenuItem,
} from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PINNED_TAG = '_alwaysOnTop';
const ACCENT_FALLBACK = '#3584e4';

const ACCENT_MAP = {
    'blue':   ['#3584e4', '#78aeed'],
    'teal':   ['#2190a4', '#4ec3d7'],
    'green':  ['#3a944a', '#8ec870'],
    'yellow': ['#c88800', '#f5c518'],
    'orange': ['#ed5b00', '#ffa348'],
    'red':    ['#e62d42', '#f66151'],
    'pink':   ['#d56199', '#f78ec2'],
    'purple': ['#9141ac', '#c061cb'],
    'slate':  ['#6f8396', '#9ab4c8'],
};

function isMaximizedOrFullscreen(win) {
    if (win.is_fullscreen()) return true;
    return !!(win.maximized_horizontally || win.maximized_vertically);
}

export default class OverviewToggleAlwaysOnTopExtension extends Extension {

    enable() {
        this._ = this.gettext.bind(this);
        this._badges           = new Map();
        this._previewConns     = new Map();
        this._windowAboveConns = new Map();
        this._origPopulateMenu = null;
        this._badgeRefreshTimeout = null;
        this._pipTimers        = new Set();
        this._settings         = null;
        this._accentChangedId  = null;
        this._colorSchemeChangedId = null;

        this._extSettings = this.getSettings();

        // accent-color / color-scheme keys require GNOME 47+; wrap for 45/46 compat
        try {
            this._settings = new Gio.Settings({
                schema: 'org.gnome.desktop.interface',
            });
            this._accentChangedId = this._settings.connect(
                'changed::accent-color',
                () => this._rebuildAllBadges()
            );
            this._colorSchemeChangedId = this._settings.connect(
                'changed::color-scheme',
                () => this._rebuildAllBadges()
            );
        } catch (_) {}

        const proto = WindowPreview.WindowPreview.prototype;
        const self  = this;

        if (typeof proto._populateMenu === 'function') {
            this._origPopulateMenu = proto._populateMenu;
            proto._populateMenu = function (...args) {
                self._origPopulateMenu.apply(this, args);
                self._injectMenuItems(this);
            };
        } else {
            // GNOME 50+: _populateMenu removed, use captured-event instead
            this._capturedEventId = global.stage.connect(
                'captured-event',
                (_actor, event) => this._onCapturedEvent(event)
            );
        }

        this._overviewShowId = Main.overview.connect('showing', () => {
            this._scheduleBadgeSync(0);
        });

        this._windowCreatedId = global.display.connect(
            'window-created',
            (_d, win) => {
                const id = win.connect('shown', () => {
                    win.disconnect(id);
                    if (this._isPiP(win)) {
                        this._setPin(win, true);
                        this._applyPiPGeometry(win);
                        // Safety net: retry after 400ms in case the browser repositions the window
                        this._schedulePiPGeometry(win, 400);
                    }
                    this._trackWindowAbove(win);
                });
            }
        );

        this._forEachWindow(win => {
            if (this._isPiP(win)) this._setPin(win, true);
            this._trackWindowAbove(win);
        });
    }

    disable() {
        if (this._origPopulateMenu !== null) {
            WindowPreview.WindowPreview.prototype._populateMenu =
                this._origPopulateMenu;
            this._origPopulateMenu = null;
        }
        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = null;
        }
        if (this._overviewShowId) {
            Main.overview.disconnect(this._overviewShowId);
            this._overviewShowId = null;
        }
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = null;
        }
        if (this._badgeRefreshTimeout !== null) {
            clearTimeout(this._badgeRefreshTimeout);
            this._badgeRefreshTimeout = null;
        }
        for (const timerId of this._pipTimers)
            GLib.source_remove(timerId);
        this._pipTimers.clear();

        if (this._settings) {
            if (this._accentChangedId)
                this._settings.disconnect(this._accentChangedId);
            if (this._colorSchemeChangedId)
                this._settings.disconnect(this._colorSchemeChangedId);
            this._settings = null;
            this._accentChangedId = null;
            this._colorSchemeChangedId = null;
        }
        this._extSettings = null;

        this._forEachWindow(win => this._untrackWindowAbove(win));
        this._windowAboveConns.clear();

        for (const badge of this._badges.values())
            badge.destroy();
        this._badges.clear();

        for (const [preview, ids] of this._previewConns) {
            for (const id of ids)
                preview.disconnect(id);
        }
        this._previewConns.clear();

        this._forEachWindow(win => {
            if (win[PINNED_TAG]) {
                win.unmake_above();
                delete win[PINNED_TAG];
            }
        });
    }

    _scheduleBadgeSync(attempt) {
        if (this._badgeRefreshTimeout !== null) {
            clearTimeout(this._badgeRefreshTimeout);
            this._badgeRefreshTimeout = null;
        }
        if (attempt >= 6) return;

        const delay = attempt === 0 ? 150 : 300;
        this._badgeRefreshTimeout = setTimeout(() => {
            this._badgeRefreshTimeout = null;
            this._walkPreviews(p => this._syncBadge(p));
            this._scheduleBadgeSync(attempt + 1);
        }, delay);
    }

    _schedulePiPGeometry(win, delayMs) {
        const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._pipTimers.delete(timerId);
            try {
                if (!win.is_destroyed())
                    this._applyPiPGeometry(win);
            } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });
        this._pipTimers.add(timerId);
    }

    _getAccentColor() {
        try {
            const accentKey = this._settings?.get_string('accent-color') ?? '';
            const scheme    = this._settings?.get_string('color-scheme') ?? '';
            const isDark    = scheme === 'prefer-dark';
            const pair      = ACCENT_MAP[accentKey];
            if (pair) return isDark ? pair[1] : pair[0];
        } catch (_) {}
        return ACCENT_FALLBACK;
    }

    _rebuildAllBadges() {
        for (const badge of this._badges.values())
            badge.destroy();
        this._badges.clear();
        if (Main.overview.visible)
            this._walkPreviews(p => this._syncBadge(p));
    }

    _onCapturedEvent(event) {
        if (!Main.overview.visible) return Clutter.EVENT_PROPAGATE;
        if (event.type() !== Clutter.EventType.BUTTON_PRESS) return Clutter.EVENT_PROPAGATE;
        if (event.get_button() !== 3) return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);

        while (actor) {
            if (actor.metaWindow instanceof Meta.Window) break;
            actor = actor.get_parent?.() ?? null;
        }
        if (!actor?.metaWindow) return Clutter.EVENT_PROPAGATE;

        const metaWin = actor.metaWindow;
        if (isMaximizedOrFullscreen(metaWin)) return Clutter.EVENT_PROPAGATE;

        this._setPin(metaWin, !this._isPinned(metaWin));
        this._walkPreviews(p => this._syncBadge(p));

        return Clutter.EVENT_STOP;
    }

    _injectMenuItems(preview) {
        const metaWin = preview.metaWindow;
        if (!metaWin) return;

        const menu = preview._menu;
        if (!menu) return;

        if (isMaximizedOrFullscreen(metaWin)) return;

        menu.addMenuItem(new PopupSeparatorMenuItem());

        const isPinned = this._isPinned(metaWin);
        const item = new PopupSwitchMenuItem(this._('📌 Always on Top'), isPinned);

        item.connect('toggled', (_item, state) => {
            this._setPin(metaWin, state);
            this._walkPreviews(p => this._syncBadge(p));
            menu.close();
        });

        menu.addMenuItem(item);
    }

    _trackWindowAbove(win) {
        const winId = win.get_id();
        if (this._windowAboveConns.has(winId)) return;

        const connId = win.connect('notify::above', () => {
            if (win.is_above())
                win[PINNED_TAG] = true;
            else
                delete win[PINNED_TAG];

            if (Main.overview.visible) {
                this._walkPreviews(p => {
                    if (p.metaWindow === win) this._syncBadge(p);
                });
            }
        });
        this._windowAboveConns.set(winId, connId);
    }

    _untrackWindowAbove(win) {
        const winId  = win.get_id();
        const connId = this._windowAboveConns.get(winId);
        if (connId !== undefined) {
            win.disconnect(connId);
            this._windowAboveConns.delete(winId);
        }
    }

    _isPinned(win) {
        return win.is_above();
    }

    _isPiP(win) {
        const PIP_TITLES = [
            // English (Chrome/Firefox)
            'picture in picture',
            'picture-in-picture',
            // German
            'bild im bild',
            'bild-im-bild',
            // French
            'incrustation vidéo',
            "image dans l'image",
            // Spanish
            'imagen en imagen',
            // Italian
            "immagine nell'immagine",
            'finestra picture in picture',
            // Portuguese
            'imagem na imagem',
            // Dutch
            'beeld-in-beeld',
            // Polish
            'obraz w obrazie',
            // Czech
            'obraz v obraze',
            // Russian
            'картинка в картинке',
            // Swedish
            'bild-i-bild',
            'bild i bild',
            // Danish
            'billede i billede',
            'billede-i-billede',
            // Finnish
            'kuva kuvassa',
            // Norwegian
            'bilde-i-bilde',
            'bilde i bilde',
            // Turkish
            'görüntü içinde görüntü',
            'resim içinde resim',
        ];

        const title = (win.get_title() ?? '').toLowerCase();
        if (PIP_TITLES.some(t => title.includes(t))) return true;

        // User-defined extra title fragments (optional, from preferences)
        const extras = this._extSettings?.get_strv('pip-extra-titles') ?? [];
        if (extras.length > 0 && extras.some(t => t && title.includes(t.toLowerCase())))
            return true;

        // Fallback: small window from a known browser
        const cls  = (win.get_wm_class() ?? '').toLowerCase();
        const rect = win.get_frame_rect();
        return (
            rect.width < 640 && rect.height < 400 &&
            (cls.includes('chrome') || cls.includes('chromium') || cls.includes('firefox'))
        );
    }

    _applyPiPGeometry(win) {
        if (!this._extSettings) return;

        const pixelOverride = this._extSettings.get_int('pip-size-pixels');
        const percent       = this._extSettings.get_int('pip-size-percent');
        const position      = this._extSettings.get_string('pip-position');
        const margin        = this._extSettings.get_int('pip-position-margin');

        const rect = win.get_frame_rect();
        if (rect.width <= 0 || rect.height <= 0) return;

        // -- Target size --
        let targetWidth  = rect.width;
        let targetHeight = rect.height;

        if (pixelOverride > 0 || percent > 0) {
            const aspect = rect.height / rect.width;

            if (pixelOverride > 0) {
                targetWidth = pixelOverride;
            } else {
                const monitorIdx = global.display.get_current_monitor();
                const geo        = global.display.get_monitor_geometry(monitorIdx);
                targetWidth      = Math.round(geo.width * percent / 100);
            }
            targetHeight = Math.round(targetWidth * aspect);
        }

        // -- Target position --
        let targetX = rect.x;
        let targetY = rect.y;

        if (position && position !== 'none') {
            const monitorIdx = global.display.get_current_monitor();
            const workArea   = win.get_work_area_for_monitor(monitorIdx);

            switch (position) {
            case 'top-left':
                targetX = workArea.x + margin;
                targetY = workArea.y + margin;
                break;
            case 'top-right':
                targetX = workArea.x + workArea.width  - targetWidth  - margin;
                targetY = workArea.y + margin;
                break;
            case 'bottom-left':
                targetX = workArea.x + margin;
                targetY = workArea.y + workArea.height - targetHeight - margin;
                break;
            case 'bottom-right':
                targetX = workArea.x + workArea.width  - targetWidth  - margin;
                targetY = workArea.y + workArea.height - targetHeight - margin;
                break;
            case 'center':
                targetX = workArea.x + Math.round((workArea.width  - targetWidth)  / 2);
                targetY = workArea.y + Math.round((workArea.height - targetHeight) / 2);
                break;
            }
        }

        win.move_resize_frame(false, targetX, targetY, targetWidth, targetHeight);
    }

    _syncBadge(preview) {
        const metaWin = preview.metaWindow;
        if (!metaWin) return;

        const winId    = metaWin.get_id();
        const isPinned = this._isPinned(metaWin) && !isMaximizedOrFullscreen(metaWin);
        const existing = this._badges.get(winId);

        if (isPinned) {
            if (existing) {
                existing.show();
                return;
            }

            const accentColor = this._getAccentColor();
            const badge = new St.Label({
                text: '📌',
                style: `font-size: 18px; background-color: ${accentColor}cc; border-radius: 8px; padding: 2px 5px; margin: 8px;`,
                reactive: false,
            });

            // add_overlay_child removed in GNOME 50; fall back to add_child
            try {
                preview.add_overlay_child(badge);
            } catch (_) {
                preview.add_child(badge);
                badge.set_position(8, 8);
            }
            this._badges.set(winId, badge);

            const dId = preview.connect('destroy', () => {
                try { preview.disconnect(dId); } catch (_) {}
                try { badge.destroy(); } catch (_) {}
                this._badges.delete(winId);
                const ids = this._previewConns.get(preview) ?? [];
                this._previewConns.set(preview, ids.filter(i => i !== dId));
            });
            const ids = this._previewConns.get(preview) ?? [];
            ids.push(dId);
            this._previewConns.set(preview, ids);

        } else {
            if (existing)
                existing.hide();
        }
    }

    _walkPreviews(fn) {
        const visited = new Set();

        const visit = item => {
            if (!item || visited.has(item)) return;
            visited.add(item);
            if (item.metaWindow instanceof Meta.Window) {
                fn(item);
                return;
            }
            const n = item.get_n_children?.() ?? 0;
            for (let i = 0; i < n; i++) visit(item.get_child_at_index(i));
        };

        try {
            const controls = Main.overview._overview?.controls;
            const wsd      = controls?._workspacesDisplay;
            if (!wsd) return;

            // _workspaceViews (GNOME 45-49) or _workspacesViews (GNOME 50+)
            const views = wsd._workspaceViews ?? wsd._workspacesViews ?? [];
            for (const view of views) {
                // GNOME 50+: view._workspaces[] → workspace._windows[]
                for (const ws of view._workspaces ?? []) {
                    for (const w of ws._windows ?? []) {
                        if (w?.metaWindow instanceof Meta.Window) fn(w);
                    }
                }
                // GNOME 45-49: view._windows[] directly
                for (const w of view._windows ?? []) {
                    if (w?.metaWindow instanceof Meta.Window) fn(w);
                }
                visit(view);
            }

            if (visited.size === 0) visit(wsd);
        } catch (_) {}
    }

    _setPin(win, pinned) {
        if (pinned) {
            win.make_above();
            win[PINNED_TAG] = true;
        } else {
            win.unmake_above();
            delete win[PINNED_TAG];
        }
    }

    _forEachWindow(fn) {
        const wm = global.display.get_workspace_manager();
        for (let i = 0; i < wm.get_n_workspaces(); i++) {
            for (const win of wm.get_workspace_by_index(i).list_windows()) {
                fn(win);
            }
        }
    }
}
