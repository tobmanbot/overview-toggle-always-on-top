/**
 * Preferences UI für Overview Toggle Always on Top
 * Einstellungen: PiP-Startgröße, Startposition und optionale Custom-Titel
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class OverviewToggleAlwaysOnTopPrefs extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const _ = this.gettext.bind(this);

        const page = new Adw.PreferencesPage({
            title: _('PiP Settings'),
            icon_name: 'video-display-symbolic',
        });
        window.add(page);

        // ── Gruppe: Startposition ───────────────────────────────────────────
        const posGroup = new Adw.PreferencesGroup({
            title: _('PiP Start Position'),
            description: _('Where the PiP window is moved when opened.'),
        });
        page.add(posGroup);

        const positions = [
            ['none',         _("None (don't move)")],
            ['top-left',     _('Top Left')],
            ['top-right',    _('Top Right')],
            ['bottom-left',  _('Bottom Left')],
            ['bottom-right', _('Bottom Right')],
            ['center',       _('Center')],
        ];

        const posModel = new Gtk.StringList();
        for (const [, label] of positions) posModel.append(label);

        const posRow = new Adw.ComboRow({
            title: _('Position'),
            model: posModel,
        });

        // Sync: settings ↔ ComboRow
        const currentPos = settings.get_string('pip-position');
        const currentIdx = positions.findIndex(([v]) => v === currentPos);
        posRow.set_selected(currentIdx >= 0 ? currentIdx : 0);

        posRow.connect('notify::selected', () => {
            const idx = posRow.get_selected();
            if (idx >= 0 && idx < positions.length)
                settings.set_string('pip-position', positions[idx][0]);
        });

        settings.connect('changed::pip-position', () => {
            const val = settings.get_string('pip-position');
            const idx = positions.findIndex(([v]) => v === val);
            if (idx >= 0 && posRow.get_selected() !== idx)
                posRow.set_selected(idx);
        });

        posGroup.add(posRow);

        // Rand-Abstand
        const marginRow = new Adw.SpinRow({
            title: _('Distance from Screen Edge'),
            subtitle: _('Pixel distance to edges (only when position is set)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 200,
                step_increment: 1,
                page_increment: 10,
            }),
        });
        settings.bind('pip-position-margin', marginRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        posGroup.add(marginRow);

        // ── Gruppe: Startgröße ──────────────────────────────────────────────
        const sizeGroup = new Adw.PreferencesGroup({
            title: _('PiP Start Size'),
            description: _('Size to set a new PiP window to when opened.\nPixel override takes precedence over percentage. 0 = disabled.'),
        });
        page.add(sizeGroup);

        const percentRow = new Adw.SpinRow({
            title: _('Size as % of Screen Width'),
            subtitle: _('0 = disabled  •  Recommended: 20–30 %'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 80,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('pip-size-percent', percentRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        sizeGroup.add(percentRow);

        const pixelRow = new Adw.SpinRow({
            title: _('Fixed Width in Pixels (Override)'),
            subtitle: _('0 = disabled  •  Takes precedence over percentage'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 3840,
                step_increment: 10,
                page_increment: 100,
            }),
        });
        settings.bind('pip-size-pixels', pixelRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        sizeGroup.add(pixelRow);

        const infoRow = new Adw.ActionRow({
            title: _('Height'),
            subtitle: _('Always proportional to set width (original aspect ratio).'),
        });
        sizeGroup.add(infoRow);

        // ── Gruppe: Custom PiP-Titel (optional) ────────────────────────────
        const titlesGroup = new Adw.PreferencesGroup({
            title: _('Custom PiP Window Titles (Optional)'),
            description: _(
                'Only needed if your browser uses a PiP window title not recognized automatically.\n' +
                'The extension already covers 15 languages built-in — most users can leave this empty.'
            ),
        });
        page.add(titlesGroup);

        // Entry für neuen Titel
        const addRow = new Adw.EntryRow({
            title: _('Add title fragment…'),
        });
        titlesGroup.add(addRow);

        // Liste der aktuellen Custom-Titel
        const renderTitles = () => {
            // Alle alten Title-Rows entfernen (nicht addRow)
            let child = titlesGroup.get_first_child();
            const toRemove = [];
            while (child) {
                if (child !== addRow && child instanceof Adw.ActionRow)
                    toRemove.push(child);
                child = child.get_next_sibling?.() ?? null;
            }
            for (const r of toRemove) titlesGroup.remove(r);

            const titles = settings.get_strv('pip-extra-titles');
            for (const t of titles) {
                const row = new Adw.ActionRow({ title: t });
                const btn = new Gtk.Button({
                    icon_name: 'edit-delete-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['destructive-action', 'flat'],
                    tooltip_text: _('Remove'),
                });
                btn.connect('clicked', () => {
                    const current = settings.get_strv('pip-extra-titles');
                    settings.set_strv('pip-extra-titles', current.filter(x => x !== t));
                });
                row.add_suffix(btn);
                row.set_activatable_widget(btn);
                titlesGroup.add(row);
            }
        };

        settings.connect('changed::pip-extra-titles', renderTitles);
        renderTitles();

        addRow.connect('apply', () => {
            const val = addRow.get_text().trim().toLowerCase();
            if (!val) return;
            const current = settings.get_strv('pip-extra-titles');
            if (!current.includes(val)) {
                settings.set_strv('pip-extra-titles', [...current, val]);
            }
            addRow.set_text('');
        });
    }
}
