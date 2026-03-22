'use strict';

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as CheckBox from 'resource:///org/gnome/shell/ui/checkBox.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Utils from './utils.js';

import { formatDateWithCFormatString } from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {
    Extension,
    gettext as _,
    pgettext
} from 'resource:///org/gnome/shell/extensions/extension.js';

const DateMenu = Main.panel.statusArea.dateMenu.menu;
const NC_ = (c, s) => pgettext(c, s);

import { GraphBackend } from './graph-backend.js';
import { TodoistBackend } from './todoist-backend.js';
import { SyncEngine } from './sync-engine.js';
import { TaskModel, sortByName, sortByDueDate, sortByPriority } from './task-model.js';

let HAS_GRAPH = false;
try {
    await import('gi://Soup?version=3.0');
    await import('gi://Secret');
    HAS_GRAPH = true;
} catch (e) {}

export default class DocketExtension extends Extension {
    /**
     * Called when the extension is enabled.
     *
     * https://gjs.guide/extensions/overview/anatomy.html#extension-js-required
     */
    enable() {
        this._widget = new Docket(this.getSettings(), this.metadata);
    }

    /**
     * Called when the extension is uninstalled, disabled in GNOME Extensions,
     * when user logs out or when the screen locks.
     */
    disable() {
        this._widget.destroy();
        this._widget = null;
    }
}

const Docket = GObject.registerClass(
    class Docket extends St.BoxLayout {
        /**
         * Initializes the widget.
         *
         * @param {Gio.Settings} settings - Extension settings object.
         * @param {object} metadata - Extension metadata.
         */
        _init(settings, metadata) {
            super._init({
                name: 'docket',
                // Re-use style classes. We'll do it in multiple places for
                // better compatibility with custom Shell themes.
                style_class:
                    'datemenu-calendar-column docket-column message-list',
                orientation: Clutter.Orientation.VERTICAL
            });

            this._calendarArea = DateMenu.box
                .get_first_child()
                .get_first_child();

            this._messageList = this._calendarArea.get_first_child();
            this._calendarWidget = this._calendarArea.get_last_child();

            // Set the height of the widget to the height of the calendar
            // widget.
            this.add_constraint(
                new Clutter.BindConstraint({
                    source: this._calendarWidget,
                    coordinate: Clutter.BindCoordinate.HEIGHT
                })
            );

            this._calendarArea.add_child(this);
            this._settings = settings;
            this._metadata = metadata;
            this.connect('destroy', this._onDestroy.bind(this));
            this._buildPlaceholder();
            this._initTaskLists();
        }

        /**
         * Builds and adds a placeholder which is used to display informational
         * and error messages.
         */
        _buildPlaceholder() {
            this._placeholder = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true
            });

            const labeledIconBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'message-list-placeholder'
            });

            this._taskIcon = new St.Icon({
                gicon: Gio.ThemedIcon.new('checkbox-checked-symbolic')
            });

            this._statusLabel = new St.Label({
                /* Translators: without the ellipsis as it's appended
                automatically. */
                text: _('Loading') + Utils.ELLIPSIS_CHAR_,
                reactive: true
            });

            this._linkLabel = new St.Label({
                reactive: true,
                visible: false
            });

            labeledIconBox.add_child(this._taskIcon);
            labeledIconBox.add_child(this._statusLabel);
            labeledIconBox.add_child(this._linkLabel);
            this._placeholder.add_child(labeledIconBox);
            this.add_child(this._placeholder);
        }

        /**
         * Initializes task lists.
         *
         * @async
         */
        async _initTaskLists() {
            try {
                this._contentBox = new St.BoxLayout({
                    style_class: `calendar world-clocks-button transparent`,
                    orientation: Clutter.Orientation.VERTICAL,
                    y_expand: true,
                    x_expand: true,
                });

                this._calendarWidget.add_style_class_name(
                    'docket-remove-calendar-margin'
                );

                this._contentBox.add_style_class_name(
                    'docket-remove-task-box-padding'
                );

                this._contentBox.bind_property(
                    'visible',
                    this._placeholder,
                    'visible',
                    GObject.BindingFlags.INVERT_BOOLEAN
                );

                this.add_child(this._contentBox);

                const themeContext = St.ThemeContext.get_for_stage(
                    global.stage
                );

                this._loadThemeHacks(themeContext);

                if (!HAS_GRAPH) {
                    this._showPlaceholderWithStatus('missing-dependencies');
                    return;
                }

                // Facilitates lazy loading of tasks.
                this._upperLimit = 0;

                this._backends = new Map();
                this._pendingBackends = [];

                const graphBackend = new GraphBackend();
                try {
                    const graphLoaded = await graphBackend.loadTokens();
                    if (graphLoaded && graphBackend.isAuthenticated())
                        this._backends.set('microsoft', graphBackend);
                } catch (e) {
                    console.log('[docket] Microsoft keyring load failed, will retry');
                    this._pendingBackends.push(graphBackend);
                }

                const todoistBackend = new TodoistBackend();
                try {
                    const todoistLoaded = await todoistBackend.loadTokens();
                    if (todoistLoaded && todoistBackend.isAuthenticated())
                        this._backends.set('todoist', todoistBackend);
                } catch (e) {
                    console.log('[docket] Todoist keyring load failed, will retry');
                    this._pendingBackends.push(todoistBackend);
                }

                if (this._pendingBackends.length > 0) {
                    console.log(`[docket] ${this._pendingBackends.length} backend(s) pending, scheduling retry...`);
                    this._tokenRetryCount = 0;
                    this._tokenRetryId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, 2, () => {
                            if (this._destroyed) return GLib.SOURCE_REMOVE;
                            this._tokenRetryCount++;
                            this._retryPendingBackends().then(anyLoaded => {
                                if (this._destroyed) return;
                                if (anyLoaded) {
                                    console.log('[docket] Pending backends loaded on retry');
                                    this._reinitBackends().catch(
                                        err => logError(err)
                                    );
                                }
                            }).catch(retryErr => {
                                console.log(`[docket] Token retry ${this._tokenRetryCount}/5 failed: ${retryErr.message}`);
                            });
                            if (this._tokenRetryCount >= 5 ||
                                !this._pendingBackends?.length) {
                                this._tokenRetryId = 0;
                                if (!this._pendingBackends?.length)
                                    console.log('[docket] All pending backends loaded');
                                else
                                    console.log('[docket] Token retries exhausted, some backends unavailable');
                                if (!this._destroyed && this._backends.size === 0) {
                                    this._showPlaceholderWithStatus('missing-dependencies');
                                    this._watchForAuth();
                                }
                                return GLib.SOURCE_REMOVE;
                            }
                            return GLib.SOURCE_CONTINUE;
                        }
                    );

                    // If some backends DID load, init with what we have
                    if (this._backends.size === 0)
                        return; // Nothing loaded yet — retry will handle init
                }

                await this._initAfterTokens(themeContext);
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Continues initialization after tokens are loaded from keyring.
         * Extracted so both the normal path and keyring-retry path can
         * call the same code.
         *
         * @param {St.ThemeContext} themeContext
         * @async
         */
        async _initAfterTokens(themeContext) {
            this._syncEngine = new SyncEngine(
                this._backends, this._settings
            );

            this._syncEngine.connect('tasks-changed', () => {
                this._onSyncUpdate();
            });
            this._syncEngine.connect('lists-changed', () => {
                // Defer tree rebuild while inline edit is active
                if (this._editingTask) return;
                const activeUid = this._taskLists[this._activeTaskList]
                    ? this._taskLists[this._activeTaskList].uid
                    : null;
                this._storeTaskLists();
                if (activeUid) {
                    const newIndex = this._taskLists.findIndex(l => l.uid === activeUid);
                    this._showActiveTaskList(newIndex !== -1 ? newIndex : 0);
                } else {
                    this._showActiveTaskList(this._activeTaskList ?? 0);
                }
            });
            this._syncEngine.connect('auth-required', () => {
                // Only show auth prompt if NO backends are authenticated
                const anyAuth = [...this._backends.values()].some(b => b.isAuthenticated());
                if (!anyAuth)
                    this._showPlaceholderWithStatus('missing-dependencies');
            });

            this._syncEngine.connect('offline', () => {
                if (this._offlineBanner) {
                    const lastSync = this._syncEngine.getLastSyncTime();
                    const ago = lastSync ? this._formatTimeAgo(lastSync) : '';
                    this._offlineLabel.set_text(
                        ago ? `No internet \u2014 showing cached tasks from ${ago}`
                            : 'No internet \u2014 showing cached tasks'
                    );
                    this._offlineBanner.visible = true;
                }
            });

            this._syncEngine.connect('online', () => {
                if (this._offlineBanner)
                    this._offlineBanner.visible = false;
            });

            this._syncEngine.connect('operation-failed', (description) => {
                this._showOperationFailedDialog(description);
            });

            try {
                await this._syncEngine.initialize();
            } catch (e) {
                if (e.message === 'auth-required') {
                    this._showPlaceholderWithStatus('missing-dependencies');
                    this._watchForAuth();
                    return;
                }
                throw e;
            }

            this._storeTaskLists(true);

            this._offlineBanner = new St.BoxLayout({
                style_class: 'docket-offline-banner',
                visible: false,
                x_expand: true,
            });
            const offlineIcon = new St.Icon({
                icon_name: 'network-offline-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._offlineLabel = new St.Label({
                text: 'No internet \u2014 showing cached tasks',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._offlineBanner.add_child(offlineIcon);
            this._offlineBanner.add_child(this._offlineLabel);
            this._contentBox.insert_child_at_index(this._offlineBanner, 0);

            this._buildHeader();

            this._buildQuickAddEntry();

            this._scrollView = new St.ScrollView({
                style_class: 'vfade',
                clip_to_allocation: true,
                y_expand: true,
            });

            this._scrollView
                .get_vadjustment()
                .connect(
                    'notify::value',
                    Utils.debounce_(
                        this._onTaskListScrolled.bind(this),
                        'vscroll',
                        100,
                        false
                    )
                );

            this._threshold =
                Utils.LL_THRESHOLD_ * themeContext.scale_factor;

            const spacing = this.get_theme_node().get_length('spacing') * 2;

            this._taskBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style: `spacing: ${spacing / themeContext.scaleFactor}px`
            });

            this._scrollView.add_child(this._taskBox);
            this._contentBox.add_child(this._scrollView);

            this._buildCompletedRow();

            this._themeChangedId = themeContext.connect(
                'notify::scale-factor',
                this._loadThemeHacks.bind(this)
            );

            this._onMenuOpenId = DateMenu.connect(
                'open-state-changed',
                this._onMenuOpen.bind(this)
            );

            Gio.Settings.sync();

            this._settingsChangedId = this._settings.connect(
                'changed',
                this._onSettingsChanged.bind(this)
            );

            this._watchForAuth();

            if (!this._taskLists.length) {
                this._showPlaceholderWithStatus('no-tasks');
                return;
            }

            const last = this._settings.get_string('last-active');
            const index = this._taskLists.map((i) => i.uid).indexOf(last);
            this._mergeTaskLists = last === 'merge';

            this._showActiveTaskList(
                index !== -1 && !this._mergeTaskLists ? index : 0
            );
        }

        /**
         * Builds a header for task lists. The header consists of a task list
         * name and two buttons to switch to either previous or next task list.
         * Switching is also triggered by scrolling a mouse wheel on the header.
         * If there's more than one task list, user can click on the task
         * name and activate another task list via the popup menu.
         */
        _buildHeader() {
            this._headerBox = new St.BoxLayout({
                reactive: true,
                x_expand: true,
                style_class: 'calendar-month-header'
            });

            this._headerBox.connect(
                'scroll-event',
                this._onHeaderScrolled.bind(this)
            );

            this._backButton = new St.Button({
                style_class: 'calendar-change-month-back pager-button pager',
                accessible_name: _('Previous task list'),
                can_focus: true
            });

            this._backButton.add_child(
                new St.Icon({
                    icon_name: 'pan-start-symbolic'
                })
            );

            this._backButton.connect(
                'clicked',
                this._onTaskListSwitched.bind(this, false)
            );

            this._filterButton = new St.Button({
                style_class: 'calendar-change-month-back pager-button pager',
                can_focus: true,
                accessible_name: _('Filter tasks'),
                child: new St.Icon({
                    icon_name: 'edit-find-symbolic',
                    icon_size: 16,
                }),
            });
            this._filterMenu = new PopupMenu.PopupMenu(
                this._filterButton,
                0.5,
                St.Side.BOTTOM
            );
            this._filterMenu.actor.add_style_class_name('aggregate-menu');
            Main.uiGroup.add_child(this._filterMenu.actor);
            this._filterMenu.actor.hide();
            const filterPlaceholder = new PopupMenu.PopupMenuItem('placeholder');
            this._filterMenu.addMenuItem(filterPlaceholder);

            this._filterButton.connect('clicked', () =>
                this._filterMenu.toggle()
            );

            this._filterMenu.connect('open-state-changed', (_menu, open) => {
                if (open) this._onFilterMenuOpen();
            });

            const filterManager = new PopupMenu.PopupMenuManager(
                this._filterButton
            );
            filterManager.addMenu(this._filterMenu);

            this._filterMenu.itemActivated = () => {};

            this._filterMenuItems = {};
            this._filterToggleItem = null;

            this._settingsFilterId = this._settings.connect(
                'changed::show-only-selected-categories',
                () => {
                    this._refreshFilterIcon(
                        this._settings.get_boolean('show-only-selected-categories') &&
                        this._settings.get_strv('selected-task-categories').length > 0
                    );
                }
            );

            this._taskListName = new St.Label({
                style_class: 'calendar-month-label task-list-name',
                text: 'placeholder',
                x_expand: true
            });

            this._taskListNameArrow = new St.Icon({
                style_class: 'popup-menu-arrow',
                icon_name: 'pan-down-symbolic',
                accessible_role: Atk.Role.ARROW,
                y_align: Clutter.ActorAlign.CENTER
            });

            this._headerBackendIcon = new St.Icon({
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-right: 4px;',
                visible: false,
            });

            const taskListNameBox = new St.BoxLayout();
            taskListNameBox.add_child(this._headerBackendIcon);
            taskListNameBox.add_child(this._taskListName);
            taskListNameBox.add_child(this._taskListNameArrow);

            this._taskListNameButton = new St.Button({
                style_class: 'task-list-name-button',
                can_focus: true,
                x_expand: true,
                accessible_name: _('Select task list'),
                accessible_role: Atk.Role.MENU,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                child: taskListNameBox
            });

            this._taskListMenu = new PopupMenu.PopupMenu(
                this._taskListNameButton,
                0.5,
                St.Side.BOTTOM
            );

            Main.uiGroup.add_child(this._taskListMenu.actor);
            this._taskListMenu.actor.hide();
            const placeholder = new PopupMenu.PopupMenuItem('placeholder');
            this._taskListMenu.addMenuItem(placeholder);

            this._taskListNameButton.connect('clicked', () =>
                this._taskListMenu.toggle()
            );

            this._taskListMenu.connect(
                'open-state-changed',
                this._onTaskListMenuOpen.bind(this)
            );

            const manager = new PopupMenu.PopupMenuManager(
                this._taskListNameButton
            );

            manager.addMenu(this._taskListMenu);

            this._forwardButton = new St.Button({
                style_class: 'calendar-change-month-forward pager-button pager',
                accessible_name: _('Next task list'),
                can_focus: true
            });

            this._forwardButton.add_child(
                new St.Icon({
                    icon_name: 'pan-end-symbolic'
                })
            );

            this._forwardButton.connect(
                'clicked',
                this._onTaskListSwitched.bind(this, true)
            );

            this._headerBox.add_child(this._backButton);
            this._headerBox.add_child(this._filterButton);
            this._headerBox.add_child(this._taskListNameButton);
            this._headerBox.add_child(this._forwardButton);
            this._contentBox.add_child(this._headerBox);
        }

        _buildQuickAddEntry() {
            this._quickAddDueDate = null;

            this._quickAddRow = new St.BoxLayout({
                x_expand: true,
                style: 'margin: 4px 8px; spacing: 4px;',
            });

            this._datePickerButton = new St.Button({
                style_class: 'quick-add-date-button',
                can_focus: true,
                child: new St.Icon({
                    icon_name: 'x-office-calendar-symbolic',
                    icon_size: 16,
                }),
            });

            this._datePickerButton.connect(
                'clicked',
                this._toggleCalendarPicker.bind(this)
            );

            this._quickAddEntry = new St.Entry({
                style_class: 'quick-add-entry',
                hint_text: _('Add a task…'),
                can_focus: true,
                x_expand: true,
                style: 'padding: 4px 8px; border-radius: 6px;',
            });

            this._quickAddEntry.clutter_text.connect(
                'activate',
                this._onQuickAddActivate.bind(this)
            );

            this._quickAddRow.add_child(this._datePickerButton);
            this._quickAddRow.add_child(this._quickAddEntry);
            this._contentBox.add_child(this._quickAddRow);

            this._buildCalendarPicker();
        }

        _buildCalendarPicker() {
            this._calendarViewDate = new Date();

            this._calendarPicker = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                visible: false,
                style_class: 'quick-add-calendar',
            });

            const navRow = new St.BoxLayout({x_expand: true});

            const prevBtn = new St.Button({
                style_class: 'calendar-change-month-back pager-button',
                can_focus: true,
                child: new St.Icon({icon_name: 'pan-start-symbolic'}),
            });
            prevBtn.connect('clicked', () => this._navigateCalendar(-1));

            this._calMonthLabel = new St.Label({
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-weight: bold;',
            });

            const nextBtn = new St.Button({
                style_class: 'calendar-change-month-forward pager-button',
                can_focus: true,
                child: new St.Icon({icon_name: 'pan-end-symbolic'}),
            });
            nextBtn.connect('clicked', () => this._navigateCalendar(1));

            navRow.add_child(prevBtn);
            navRow.add_child(this._calMonthLabel);
            navRow.add_child(nextBtn);
            this._calendarPicker.add_child(navRow);

            const dowRow = new St.BoxLayout({x_expand: true});
            const dayNames = [
                NC_('day abbreviation', 'Su'),
                NC_('day abbreviation', 'Mo'),
                NC_('day abbreviation', 'Tu'),
                NC_('day abbreviation', 'We'),
                NC_('day abbreviation', 'Th'),
                NC_('day abbreviation', 'Fr'),
                NC_('day abbreviation', 'Sa'),
            ];
            for (const d of dayNames) {
                dowRow.add_child(new St.Label({
                    text: d,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    style_class: 'quick-add-calendar-dow',
                }));
            }
            this._calendarPicker.add_child(dowRow);

            this._dayButtons = [];
            for (let w = 0; w < 6; w++) {
                const weekRow = new St.BoxLayout({x_expand: true});
                for (let d = 0; d < 7; d++) {
                    const btn = new St.Button({
                        x_expand: true,
                        can_focus: true,
                        style_class: 'quick-add-calendar-day',
                    });
                    btn.connect('clicked',
                        this._onCalendarDayClicked.bind(this, w * 7 + d));
                    weekRow.add_child(btn);
                    this._dayButtons.push(btn);
                }
                this._calendarPicker.add_child(weekRow);
            }

            const bottomRow = new St.BoxLayout({
                x_expand: true,
                style: 'spacing: 8px; margin-top: 4px;',
            });

            const todayBtn = new St.Button({
                label: _('Today'),
                style_class: 'quick-add-calendar-action button',
                can_focus: true,
                x_expand: true,
            });
            todayBtn.connect('clicked', () => {
                const d = new Date();
                d.setHours(0, 0, 0, 0);
                this._quickAddDueDate = d;
                this._updateDateButtonLabel();
                this._calendarPicker.visible = false;
            });

            const clearBtn = new St.Button({
                label: _('Clear'),
                style_class: 'quick-add-calendar-action button',
                can_focus: true,
                x_expand: true,
            });
            clearBtn.connect('clicked', () => {
                this._quickAddDueDate = null;
                this._updateDateButtonLabel();
                this._calendarPicker.visible = false;
            });

            bottomRow.add_child(todayBtn);
            bottomRow.add_child(clearBtn);
            this._calendarPicker.add_child(bottomRow);

            this._contentBox.add_child(this._calendarPicker);
            this._updateCalendarGrid();
        }

        _buildCompletedRow() {
            const COMPLETED_MODE_LABELS = [
                _('Never'),
                _('Immediately'),
                _('After a period of time after completion'),
                _('After a specific time of the day'),
            ];

            this._completedRow = new St.BoxLayout({
                style_class: 'calendar-change-month-back',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
            });

            this._completedLabel = new St.Label({
                text: _('Hide completed tasks:'),
                style_class: 'task-list-name',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._completedModeButton = new St.Button({
                style_class: 'calendar-change-month-back pager-button',
                can_focus: true,
                accessible_name: _('Hide completed tasks mode'),
                y_align: Clutter.ActorAlign.CENTER,
            });

            const modeButtonBox = new St.BoxLayout({ style_class: 'pager' });
            this._completedModeLabel = new St.Label({
                text: COMPLETED_MODE_LABELS[this._settings.get_int('hide-completed-tasks')],
                y_align: Clutter.ActorAlign.CENTER,
            });
            const modeArrow = new St.Icon({
                style_class: 'popup-menu-arrow',
                icon_name: 'pan-down-symbolic',
                icon_size: 12,
                y_align: Clutter.ActorAlign.CENTER,
            });
            modeButtonBox.add_child(this._completedModeLabel);
            modeButtonBox.add_child(modeArrow);
            this._completedModeButton.set_child(modeButtonBox);

            this._completedRow.add_child(this._completedLabel);
            this._completedRow.add_child(this._completedModeButton);

            this._contentBox.add_child(this._completedRow);

            this._completedMenu = new PopupMenu.PopupMenu(
                this._completedModeButton,
                0.5,
                St.Side.BOTTOM
            );
            Main.uiGroup.add_child(this._completedMenu.actor);
            this._completedMenu.actor.hide();
            const completedPlaceholder = new PopupMenu.PopupMenuItem('placeholder');
            this._completedMenu.addMenuItem(completedPlaceholder);

            this._completedModeButton.connect('clicked', () =>
                this._completedMenu.toggle()
            );

            this._completedMenu.connect('open-state-changed', (_menu, open) => {
                if (open) this._onCompletedMenuOpen();
            });

            const completedManager = new PopupMenu.PopupMenuManager(
                this._completedModeButton
            );
            completedManager.addMenu(this._completedMenu);

            this._settingsCompletedId = this._settings.connect(
                'changed::hide-completed-tasks',
                () => {
                    const mode = this._settings.get_int('hide-completed-tasks');
                    this._completedModeLabel.set_text(COMPLETED_MODE_LABELS[mode]);
                    // Task refresh handled by existing blanket 'changed' listener
                }
            );
        }

        _onCompletedMenuOpen() {
            this._completedMenu.removeAll();

            const currentMode = this._settings.get_int('hide-completed-tasks');

            const modes = [
                { value: 0, label: _('Never') },
                { value: 1, label: _('Immediately') },
                { value: 2, label: _('After a period of time after completion') },
                { value: 3, label: _('After a specific time of the day') },
            ];

            for (const mode of modes) {
                const item = new PopupMenu.PopupMenuItem(mode.label);
                item.setOrnament(
                    mode.value === currentMode
                        ? PopupMenu.Ornament.DOT
                        : PopupMenu.Ornament.NONE
                );
                item.connect('activate', () => {
                    this._settings.set_int('hide-completed-tasks', mode.value);
                    this._completedModeLabel.set_text(mode.label);
                    this._showActiveTaskList(this._activeTaskList);
                });
                this._completedMenu.addMenuItem(item);
            }
        }

        _toggleCalendarPicker() {
            this._calendarPicker.visible = !this._calendarPicker.visible;
            if (this._calendarPicker.visible) {
                this._calendarViewDate = this._quickAddDueDate
                    ? new Date(this._quickAddDueDate)
                    : new Date();
                this._updateCalendarGrid();
            }
        }

        _navigateCalendar(delta) {
            this._calendarViewDate.setMonth(
                this._calendarViewDate.getMonth() + delta
            );
            this._updateCalendarGrid();
        }

        _updateCalendarGrid() {
            const vd = this._calendarViewDate;
            const year = vd.getFullYear();
            const month = vd.getMonth();

            const monthNames = [
                _('January'), _('February'), _('March'), _('April'),
                _('May'), _('June'), _('July'), _('August'),
                _('September'), _('October'), _('November'), _('December'),
            ];
            this._calMonthLabel.text = `${monthNames[month]} ${year}`;

            const firstDay = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const daysInPrev = new Date(year, month, 0).getDate();

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            for (let i = 0; i < 42; i++) {
                const btn = this._dayButtons[i];
                let dayNum, isCurrentMonth;

                if (i < firstDay) {
                    dayNum = daysInPrev - firstDay + i + 1;
                    isCurrentMonth = false;
                } else if (i >= firstDay + daysInMonth) {
                    dayNum = i - firstDay - daysInMonth + 1;
                    isCurrentMonth = false;
                } else {
                    dayNum = i - firstDay + 1;
                    isCurrentMonth = true;
                }

                btn.label = `${dayNum}`;
                btn.remove_style_pseudo_class('active');
                btn.style_class = 'quick-add-calendar-day';

                if (!isCurrentMonth) {
                    btn.add_style_class_name('quick-add-calendar-day-other');
                }

                if (isCurrentMonth &&
                    today.getFullYear() === year &&
                    today.getMonth() === month &&
                    today.getDate() === dayNum) {
                    btn.add_style_class_name('quick-add-calendar-day-today');
                }

                if (this._quickAddDueDate && isCurrentMonth &&
                    this._quickAddDueDate.getFullYear() === year &&
                    this._quickAddDueDate.getMonth() === month &&
                    this._quickAddDueDate.getDate() === dayNum) {
                    btn.add_style_pseudo_class('active');
                }
            }
        }

        _onCalendarDayClicked(index) {
            const vd = this._calendarViewDate;
            const year = vd.getFullYear();
            const month = vd.getMonth();
            const firstDay = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();

            let date;
            if (index < firstDay) {
                const prevMonth = new Date(year, month, 0);
                date = new Date(prevMonth.getFullYear(), prevMonth.getMonth(),
                    prevMonth.getDate() - firstDay + index + 1);
            } else if (index >= firstDay + daysInMonth) {
                date = new Date(year, month + 1,
                    index - firstDay - daysInMonth + 1);
            } else {
                date = new Date(year, month, index - firstDay + 1);
            }

            date.setHours(0, 0, 0, 0);
            this._quickAddDueDate = date;
            this._updateDateButtonLabel();
            this._calendarPicker.visible = false;
        }

        _updateDateButtonLabel() {
            if (this._quickAddDueDate) {
                const d = this._quickAddDueDate;
                const label = formatDateWithCFormatString(d, '%b %-d');
                this._datePickerButton.child = new St.Label({
                    text: label,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'font-size: 0.85em;',
                });
                this._datePickerButton.add_style_pseudo_class('active');
            } else {
                this._datePickerButton.child = new St.Icon({
                    icon_name: 'x-office-calendar-symbolic',
                    icon_size: 16,
                });
                this._datePickerButton.remove_style_pseudo_class('active');
            }
        }

        /**
         * Handles the Enter key press on the quick-add entry.
         * Creates a new task in the active task list.
         *
         * @async
         */
        async _onQuickAddActivate() {
            try {
                const text = this._quickAddEntry.get_text().trim();

                if (!text) return;

                const taskList = this._taskLists[this._activeTaskList];

                if (!taskList || !this._syncEngine) return;

                const opts = {};
                if (this._quickAddDueDate)
                    opts.dueDateTime = this._quickAddDueDate;

                await this._syncEngine.createTask(taskList.uid, text, opts);

                this._quickAddEntry.set_text('');
                this._quickAddDueDate = null;
                this._updateDateButtonLabel();

                this._resetTaskBox(true);
                this._showActiveTaskList(this._activeTaskList);
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Fills the task list menu.
         *
         * @param {PopupMenu.PopupMenu} _self - Task list menu object.
         * @param {boolean} isOpen - Menu is open.
         */
        _onTaskListMenuOpen(_self, isOpen) {
            if (!isOpen) {
                this._taskListNameButton.remove_style_pseudo_class('active');
                return;
            }

            this._taskListMenu.removeAll();
            this._taskListNameButton.add_style_pseudo_class('active');

            for (const [index, taskList] of this._taskLists.entries()) {
                const name =
                    taskList.name.length > 25
                        ? taskList.name.substring(0, 22) + Utils.ELLIPSIS_CHAR_
                        : taskList.name;

                const item = new PopupMenu.PopupMenuItem(name);

                const gicon = this._backendGIcon(taskList.backendId);
                if (gicon) {
                    const icon = new St.Icon({
                        gicon: gicon,
                        icon_size: 16,
                        style_class: 'popup-menu-icon',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    item.insert_child_below(icon, item.label);
                }

                // Edit button for renaming — hide for immutable system lists
                // (Flagged Emails can't be renamed or deleted)
                const immutable = taskList.wellknownListName === 'flaggedEmails';
                if (!immutable) {
                    const editBtn = new St.Button({
                        style_class: 'list-edit-button',
                        can_focus: true,
                        child: new St.Icon({
                            style_class: 'list-edit-icon',
                            icon_name: 'document-edit-symbolic',
                            icon_size: 14,
                        }),
                        x_align: Clutter.ActorAlign.END,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    editBtn.connect('clicked', () => {
                        this._taskListMenu.close();
                        this._onEditTaskList(taskList, index);
                    });
                    item.add_child(editBtn);
                }

                if (index === this._activeTaskList && !this._mergeTaskLists)
                    item.setOrnament(PopupMenu.Ornament.DOT);
                else item.setOrnament(PopupMenu.Ornament.NONE);

                item.connect('activate', () => {
                    if (this._mergeTaskLists) delete this._mergeTaskLists;

                    this._resetTaskBox(true);
                    this._showActiveTaskList(index);
                });

                this._taskListMenu.addMenuItem(item);
            }

            const separator = new PopupMenu.PopupSeparatorMenuItem();
            this._taskListMenu.addMenuItem(separator);

            const allTasksItem = new PopupMenu.PopupMenuItem(_('All Tasks'));

            if (this._mergeTaskLists)
                allTasksItem.setOrnament(PopupMenu.Ornament.DOT);
            else allTasksItem.setOrnament(PopupMenu.Ornament.NONE);

            allTasksItem.connect('activate', () => {
                this._mergeTaskLists = true;
                this._resetTaskBox(true);
                this._showActiveTaskList(this._activeTaskList);
            });

            this._taskListMenu.addMenuItem(allTasksItem);

            const createSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this._taskListMenu.addMenuItem(createSeparator);

            const createItem = new PopupMenu.PopupMenuItem(_('Create new list\u2026'));
            createItem.connect('activate', () => {
                this._onCreateTaskList();
            });
            this._taskListMenu.addMenuItem(createItem);
        }

        /**
         * Opens a modal dialog to create a new task list.
         * Determines which backend to use: if only one is authenticated,
         * uses that one; if multiple, defaults to the first authenticated.
         */
        _onCreateTaskList() {
            const authenticatedBackends = [...this._backends.entries()]
                .filter(([_id, b]) => b.isAuthenticated());

            if (authenticatedBackends.length === 0) {
                console.error('[docket] No authenticated backends for list creation');
                return;
            }

            const dialog = new ModalDialog.ModalDialog({
                styleClass: 'docket-create-list-dialog',
            });

            const contentBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style: 'spacing: 12px; padding: 12px;',
            });

            const titleLabel = new St.Label({
                text: _('Create New List'),
                style: 'font-weight: bold; font-size: 1.1em;',
            });
            contentBox.add_child(titleLabel);

            const entry = new St.Entry({
                hint_text: _('List name'),
                can_focus: true,
                x_expand: true,
                style: 'min-width: 250px;',
            });
            contentBox.add_child(entry);

            let selectedBackendId = authenticatedBackends[0][0];
            if (authenticatedBackends.length > 1) {
                const backendBox = new St.BoxLayout({
                    style: 'spacing: 8px;',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                const backendLabel = new St.Label({
                    text: _('Account:'),
                    y_align: Clutter.ActorAlign.CENTER,
                });
                backendBox.add_child(backendLabel);

                for (const [backendId] of authenticatedBackends) {
                    const displayName = backendId === 'microsoft' ? 'Microsoft' : 'Todoist';
                    const btn = new St.Button({
                        label: displayName,
                        style_class: backendId === selectedBackendId
                            ? 'list-backend-selector list-backend-selected'
                            : 'list-backend-selector',
                        can_focus: true,
                    });
                    btn._backendId = backendId;
                    btn.connect('clicked', () => {
                        selectedBackendId = backendId;
                        // Update button styles
                        for (const child of backendBox.get_children()) {
                            if (child instanceof St.Button) {
                                if (child._backendId === backendId)
                                    child.add_style_class_name('list-backend-selected');
                                else
                                    child.remove_style_class_name('list-backend-selected');
                            }
                        }
                    });
                    backendBox.add_child(btn);
                }
                contentBox.add_child(backendBox);
            }

            dialog.contentLayout.add_child(contentBox);

            dialog.addButton({
                label: _('Cancel'),
                action: () => dialog.close(global.get_current_time()),
                key: Clutter.KEY_Escape,
            });

            dialog.addButton({
                label: _('OK'),
                action: () => {
                    const name = entry.get_text().trim();
                    dialog.close(global.get_current_time());
                    if (name) {
                        this._syncEngine.createTaskList(selectedBackendId, name)
                            .catch(e => logError(e));
                    }
                },
                key: Clutter.KEY_Return,
                default: true,
            });

            dialog.open(global.get_current_time());

            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                entry.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        }

        /**
         * Opens a modal dialog to edit (rename or delete) a task list.
         * @param {object} taskList - The task list object {uid, name, backendId}
         * @param {number} index - Index of the task list in this._taskLists
         */
        _onEditTaskList(taskList, index) {
            const dialog = new ModalDialog.ModalDialog({
                styleClass: 'docket-edit-list-dialog',
            });

            const contentBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style: 'spacing: 12px; padding: 12px;',
            });

            const titleLabel = new St.Label({
                text: _('Edit List'),
                style: 'font-weight: bold; font-size: 1.1em;',
            });
            contentBox.add_child(titleLabel);

            const entry = new St.Entry({
                text: taskList.name,
                can_focus: true,
                x_expand: true,
                style: 'min-width: 250px;',
            });
            contentBox.add_child(entry);

            dialog.contentLayout.add_child(contentBox);

            // Delete button — hide for Microsoft system lists (e.g. Flagged Emails, Tasks)
            const isSystemList = taskList.wellknownListName &&
                taskList.wellknownListName !== 'none';
            if (!isSystemList) {
                dialog.addButton({
                    label: _('Delete'),
                    action: () => {
                        dialog.close(global.get_current_time());
                        this._onDeleteTaskList(taskList, index);
                    },
                });
            }

            dialog.addButton({
                label: _('Cancel'),
                action: () => dialog.close(global.get_current_time()),
                key: Clutter.KEY_Escape,
            });

            dialog.addButton({
                label: _('Save'),
                action: () => {
                    const newName = entry.get_text().trim();
                    dialog.close(global.get_current_time());
                    if (newName && newName !== taskList.name) {
                        this._syncEngine.renameTaskList(taskList.uid, newName)
                            .catch(e => logError(e));
                    }
                },
                key: Clutter.KEY_Return,
                default: true,
            });

            dialog.open(global.get_current_time());

            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                entry.grab_key_focus();
                entry.get_clutter_text().set_selection(0, -1);
                return GLib.SOURCE_REMOVE;
            });
        }

        /**
         * Shows a confirmation dialog and deletes a task list.
         * @param {object} taskList - The task list object {uid, name, backendId}
         * @param {number} index - Index of the task list in this._taskLists
         */
        _onDeleteTaskList(taskList, index) {
            const dialog = new ModalDialog.ModalDialog({
                styleClass: 'docket-delete-list-dialog',
            });

            const contentBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style: 'spacing: 12px; padding: 12px;',
            });

            const warningLabel = new St.Label({
                text: _('Delete list "%s"?').format(taskList.name),
                style: 'font-weight: bold; font-size: 1.1em;',
            });
            contentBox.add_child(warningLabel);

            const detailLabel = new St.Label({
                text: _('All tasks in this list will be permanently deleted.'),
                style: 'color: rgba(255, 255, 255, 0.7);',
            });
            contentBox.add_child(detailLabel);

            dialog.contentLayout.add_child(contentBox);

            dialog.addButton({
                label: _('Cancel'),
                action: () => dialog.close(global.get_current_time()),
                key: Clutter.KEY_Escape,
                default: true,
            });

            dialog.addButton({
                label: _('Delete'),
                action: () => {
                    dialog.close(global.get_current_time());
                    // If we're deleting the active list, switch to the first one
                    if (index === this._activeTaskList) {
                        const newIndex = index > 0 ? index - 1 : 0;
                        this._syncEngine.deleteTaskList(taskList.uid).then(() => {
                            this._showActiveTaskList(
                                this._taskLists.length > 0 ? newIndex : null
                            );
                        }).catch(e => logError(e));
                    } else {
                        this._syncEngine.deleteTaskList(taskList.uid)
                            .catch(e => logError(e));
                    }
                },
            });

            dialog.open(global.get_current_time());
        }

        /**
         * Shows a modal dialog informing the user that a background operation
         * failed after exhausting all retry attempts. The optimistic UI change
         * has already been rolled back by the time this is called.
         *
         * @param {string} description - Human-readable description of what failed
         */
        _showOperationFailedDialog(description) {
            const dialog = new ModalDialog.ModalDialog({
                styleClass: 'docket-operation-failed-dialog',
            });

            const contentBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style: 'spacing: 12px; padding: 12px;',
            });

            const titleLabel = new St.Label({
                text: _('Operation Failed'),
                style: 'font-weight: bold; font-size: 1.1em;',
            });
            contentBox.add_child(titleLabel);

            const detailLabel = new St.Label({
                text: _('%s\n\nThe change has been reverted.').format(description),
                style: 'color: rgba(255, 255, 255, 0.7);',
            });
            detailLabel.clutter_text.line_wrap = true;
            contentBox.add_child(detailLabel);

            dialog.contentLayout.add_child(contentBox);

            dialog.addButton({
                label: _('OK'),
                action: () => dialog.close(global.get_current_time()),
                key: Clutter.KEY_Escape,
                default: true,
            });

            dialog.open(global.get_current_time());
        }

        _onFilterMenuOpen() {
            this._filterMenu.removeAll();

            const enabled = this._settings.get_boolean('show-only-selected-categories');
            const selected = this._settings.get_strv('selected-task-categories');

            this._filterToggleItem = new PopupMenu.PopupSwitchMenuItem(
                _('Enable Filter'), enabled
            );
            this._filterToggleItem.connect('toggled', (_item, state) => {
                this._settings.set_boolean('show-only-selected-categories', state);
                for (const name in this._filterMenuItems)
                    this._filterMenuItems[name].setSensitive(state);
                this._refreshFilterIcon(state && selected.length > 0);
                this._showActiveTaskList(this._activeTaskList);
            });
            this._filterMenu.addMenuItem(this._filterToggleItem);
            this._filterMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const categories = [
                { name: 'past',             label: _('Past') },
                { name: 'today',            label: _('Due Today') },
                { name: 'tomorrow',         label: _('Due Tomorrow') },
                { name: 'next-seven-days',  label: _('Due in Next 7 Days') },
                { name: 'scheduled',        label: _('Scheduled') },
                { name: 'unscheduled',      label: _('Unscheduled') },
                { name: 'not-cancelled',    label: _('Not Cancelled') },
            ];

            this._filterMenuItems = {};
            for (const cat of categories) {
                const item = new PopupMenu.PopupMenuItem(cat.label);
                item._categoryName = cat.name;
                item.setOrnament(
                    selected.includes(cat.name)
                        ? PopupMenu.Ornament.CHECK
                        : PopupMenu.Ornament.NONE
                );
                item.setSensitive(enabled);
                item.connect('activate', () => this._toggleCategoryItem(cat.name));
                this._filterMenu.addMenuItem(item);
                this._filterMenuItems[cat.name] = item;
            }
        }

        /**
         * Toggles a category in the filter selection and updates GSettings.
         *
         * @param {string} name - Category name to toggle.
         */
        _toggleCategoryItem(name) {
            const selection = this._settings.get_strv('selected-task-categories');
            const idx = selection.indexOf(name);

            if (idx >= 0) {
                selection.splice(idx, 1);
            } else {
                selection.push(name);
                this._applyCategoryConstraints(name, selection);
            }

            this._settings.set_strv('selected-task-categories', selection);

            if (selection.length > 0 && !this._settings.get_boolean('show-only-selected-categories')) {
                this._settings.set_boolean('show-only-selected-categories', true);
                if (this._filterToggleItem)
                    this._filterToggleItem.setToggleState(true);
            }

            for (const catName in this._filterMenuItems) {
                this._filterMenuItems[catName].setOrnament(
                    selection.includes(catName)
                        ? PopupMenu.Ornament.CHECK
                        : PopupMenu.Ornament.NONE
                );
                this._filterMenuItems[catName].setSensitive(true);
            }

            this._refreshFilterIcon(selection.length > 0);
            this._showActiveTaskList(this._activeTaskList);
        }

        /**
         * Removes conflicting categories from selection when a new one is added.
         *
         * @param {string} justSelected - Category that was just selected.
         * @param {string[]} selection - Current selection array (modified in place).
         */
        _applyCategoryConstraints(justSelected, selection) {
            const conflicts = {
                'past':             ['scheduled'],
                'today':            ['next-seven-days', 'scheduled'],
                'tomorrow':         ['next-seven-days', 'scheduled'],
                'next-seven-days':  ['today', 'tomorrow', 'scheduled'],
                'scheduled':        ['past', 'today', 'tomorrow', 'next-seven-days', 'unscheduled'],
                'unscheduled':      ['scheduled'],
            };
            const toRemove = conflicts[justSelected] || [];
            for (const c of toRemove) {
                const idx = selection.indexOf(c);
                if (idx >= 0) selection.splice(idx, 1);
            }
        }

        /**
         * Updates the filter button appearance based on active/inactive state.
         *
         * @param {boolean} active - Whether filtering is currently active.
         */
        _refreshFilterIcon(active) {
            if (active) {
                this._filterButton.add_style_pseudo_class('active');
            } else {
                this._filterButton.remove_style_pseudo_class('active');
            }
        }

        /**
         * Stores a list of task list data (UIDs and names) for quick access.
         * Task lists are sorted according to user-defined order.
         *
         * @param {boolean} [cleanup] - Cleanup the settings (remove obsolete
         * task list uids).
         */
        _storeTaskLists(cleanup = false) {
            try {
                if (!this._syncEngine) return;

                const graphLists = this._syncEngine.getTaskLists();
                const customOrder = this._settings.get_strv('task-list-order');
                const disabled = this._settings.get_strv('disabled-task-lists');

                this._taskLists = graphLists
                    .filter(list => disabled.indexOf(list.id) === -1)
                    .map(list => ({uid: list.id, name: list.displayName, backendId: list._backendId, wellknownListName: list.wellknownListName}));

                if (customOrder.length) {
                    this._taskLists.sort(
                        Utils.customSort_.bind(this, customOrder)
                    );
                }

                if (cleanup) {
                    this._cleanupSettings(
                        disabled,
                        graphLists.map(list => list.id)
                    );
                }
            } catch (e) {
                logError(e);
            }
        }

        _onSyncUpdate() {
            try {
                if (this._activeTaskList === null) return;
                // Defer tree rebuild while inline edit is active
                if (this._editingTask) return;
                this._resetTaskBox();
                this._showActiveTaskList(this._activeTaskList);
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Creates data structures required to resolve task hierarchy.
         *
         * @param {object[]|object[][]} tasks - A list or list of lists of
         * internal task model objects.
         * @param {string} [taskListUid] - ID of task list tasks belong to.
         */
        _buildTaskMap(tasks, taskListUid = null) {
            this._rootTasks = [];
            this._relatedTo = new Map();

            // No task list UID means we have multiple task lists merged:
            if (taskListUid === null) {
                tasks = [].concat(...tasks);
            }

            for (const task of tasks.sort(
                (a, b) =>
                    sortByDueDate(a, b) ||
                    sortByPriority(a, b) ||
                    sortByName(a, b)
            )) {
                if (!task.title) continue;

                this._rootTasks.push(task);

                if (task.checklistItems && task.checklistItems.length) {
                    const subtasks = task.checklistItems.map(ci => ({
                        id: ci.id,
                        _uid: ci.id,
                        title: ci.displayName,
                        status: ci.isChecked ? 'completed' : 'notStarted',
                        _due: null,
                        dueDateTime: null,
                        _taskList: task._taskList,
                        _isChecklistItem: true,
                        _parentTaskId: task.id,
                        checklistItems: [],
                        categories: [],
                        importance: 'normal',
                    }));
                    this._relatedTo.set(task.id, subtasks);
                }
            }
        }

        /**
         * Initializes listing of tasks in the widget.
         *
         * @async
         * @param {string} taskListUid - Unique task list identifier.
         * @param {boolean} merge - Task lists will be merged into one.
         *
         * @returns {Promise<boolean>} `true` if there's at least one task.
         */
        _listTasks(taskListUid, merge) {
            try {
                this._allTasksLoaded = false;

                if (!this._syncEngine) return;

                if (merge) {
                    const taskLists = this._taskLists.map(tl =>
                        this._filterTasks(tl.uid)
                    );

                    if (!taskLists.length || this._idleAddId) return;

                    if (
                        this._settings.get_boolean(
                            'hide-empty-completed-task-lists'
                        )
                    ) {
                        let allCompleted = true;

                        for (const tasks of taskLists) {
                            for (const task of tasks) {
                                if (!['completed', 'deferred'].includes(task.status)) {
                                    allCompleted = false;
                                    break;
                                }
                            }
                            if (!allCompleted) break;
                        }

                        if (allCompleted) {
                            this._showPlaceholderWithStatus('no-tasks');
                            return;
                        }
                    }

                    this._buildTaskMap(taskLists);
                } else {
                    const tasks = this._filterTasks(taskListUid);

                    if (!tasks || this._idleAddId) return;

                    this._buildTaskMap(tasks, taskListUid);
                }

                this._currentRootTask = 0;
                this._currentChild = this._taskBox.first_child;
                this._previousDueDate = undefined;

                this._idleAddId = GLib.idle_add(
                    GLib.PRIORITY_LOW,
                    this._idleAdd.bind(this)
                );

                return true;
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Dates have time zone information, which can span regions with
         * different day light savings adjustments. To accurately calculate
         * day differences between two dates, we'll use this method to convert
         * the dates to UTC first.
         *
         * @param {Date} date - Date to be converted into UTC.
         *
         * @returns {number} The number of milliseconds since January 1, 1970,
         * 00:00:00 UTC.
         */
        _toUTC(date) {
            return Date.UTC(
                date.getFullYear(),
                date.getMonth(),
                date.getDate()
            );
        }

        /**
         * For a given checkbox, returns UID of the next or previous
         * sibling checkbox.
         *
         * @param {Checkbox.Checkbox} item - Checkbox to investigate.
         * @param {boolean} [next] - Retrieve next sibling checkbox.
         *
         * @returns {string|null} UID of a sibling checkbox or `null`.
         */
        _getSiblingCheckbox(item, next = false) {
            let sibling = next
                ? item.get_next_sibling()
                : item.get_previous_sibling();

            while (sibling) {
                if (
                    sibling instanceof CheckBox.CheckBox &&
                    sibling.can_focus &&
                    !(next && item._rootTask && !sibling._rootTask)
                )
                    return sibling._uid;

                sibling = next
                    ? sibling.get_next_sibling()
                    : sibling.get_previous_sibling();
            }

            return null;
        }

        /**
         * Builds task checkboxes.
         *
         * @param {object} task - Internal task model object.
         * @param {boolean} [root] - Task is a root task (not subtask).
         *
         * @returns {Checkbox.Checkbox} Task checkbox.
         */
        _buildCheckbox(task, root = false) {
            const checkbox = new CheckBox.CheckBox(
                task.title
            );

            // Keep track of the focused checkbox for users using
            // keyboard navigation:
            checkbox.connect('key-focus-in', (self) => {
                this._focused = {
                    previous: this._getSiblingCheckbox(self),
                    focused: self,
                    next: this._getSiblingCheckbox(self, true),
                    refocus: null
                };

                const allocation = self.get_allocation_box();
                const adjustment = this._scrollView.get_vadjustment();
                const height = this._taskBox.allocation.get_height();

                // Updates scrollbar adjustment when user navigates task
                // lists using keyboard:
                if (
                    adjustment.value &&
                    allocation.y1 < adjustment.value + this._threshold
                ) {
                    adjustment.set_value(
                        adjustment.value - this._threshold / 2
                    );
                } else if (
                    allocation.y1 >
                    height + adjustment.value - this._threshold
                ) {
                    adjustment.set_value(
                        adjustment.value + this._threshold / 2
                    );
                }
            });

            if (task.status === 'completed') {
                checkbox.checked = true;
                checkbox.getLabelActor().set_opacity(100);
            }

            if (root) checkbox._rootTask = true;

            checkbox._task = task;
            checkbox._uid = task._uid || task.id;

            checkbox
                .getLabelActor()
                .add_style_class_name(
                    'world-clocks-header no-world-clocks world-clocks-city'
                );

            checkbox.getLabelActor().clutter_text.line_wrap_mode =
                Pango.WrapMode.WORD_CHAR;

            if (task.status === 'deferred') {
                checkbox.set_opacity(100);
                checkbox.set_toggle_mode(false);
                checkbox.set_can_focus(false);

                checkbox.getLabelActor().add_style_class_name('task-cancelled');
            } else {
                checkbox.connect('clicked', () =>
                    this._taskClicked(checkbox)
                );
            }

            // Align checkbox indicator and label to top for multi-line tasks
            const boxActor = checkbox.child.get_child_at_index(0);
            if (boxActor) boxActor.y_align = Clutter.ActorAlign.START;
            checkbox.getLabelActor().y_align = Clutter.ActorAlign.START;

            // Add action buttons inside the checkbox layout
            const deleteBtn = new St.Button({
                style_class: 'task-delete-button',
                can_focus: true,
                y_align: Clutter.ActorAlign.START,
                child: new St.Icon({
                    style_class: 'task-delete-icon',
                    icon_name: 'user-trash-symbolic',
                    icon_size: 14,
                }),
            });
            deleteBtn.connect('clicked', () => this._onDeleteTask(checkbox));
            checkbox.child.insert_child_at_index(deleteBtn, 0);

            const editBtn = new St.Button({
                style_class: 'task-edit-button',
                can_focus: true,
                y_align: Clutter.ActorAlign.START,
                child: new St.Icon({
                    style_class: 'task-edit-icon',
                    icon_name: 'document-edit-symbolic',
                    icon_size: 14,
                }),
            });
            editBtn.connect('clicked', () => this._onEditTask(checkbox));
            checkbox.child.insert_child_at_index(editBtn, 1);

            const dueDateBtn = new St.Button({
                style_class: 'task-duedate-button',
                can_focus: true,
                y_align: Clutter.ActorAlign.START,
                child: new St.Icon({
                    style_class: 'task-duedate-icon',
                    icon_name: 'x-office-calendar-symbolic',
                    icon_size: 14,
                }),
            });
            dueDateBtn.connect('clicked', () =>
                this._onDueDateTask(checkbox));
            checkbox.child.insert_child_at_index(dueDateBtn, 2);

            // Add subtask "+" button — only on root tasks (not checklist items/subtasks)
            if (root) {
                const addSubtaskBtn = new St.Button({
                    style_class: 'task-add-subtask-button',
                    can_focus: true,
                    y_align: Clutter.ActorAlign.START,
                    child: new St.Icon({
                        style_class: 'task-add-subtask-icon',
                        icon_name: 'list-add-symbolic',
                        icon_size: 12,
                    }),
                });
                addSubtaskBtn.connect('clicked', () =>
                    this._onAddSubtask(checkbox));
                // Append after all other children (rightmost position)
                checkbox.child.add_child(addSubtaskBtn);
            }

            return checkbox;
        }

        /**
         * Adds an arrow indicator to denote orphan tasks.
         *
         * @param {Checkbox.Checkbox} checkbox - Checkbox to style.
         *
         * @returns {Checkbox.Checkbox} Styled checkbox.
         */
        _styleOrphanTaskCheckbox(checkbox) {
            const indicator = new St.Label({
                text: '!',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: coral',
                /* Translators: this denotes a subtask with an inaccessible
                parent task. */
                accessible_name: _('Orphan task'),
                accessible_role: Atk.Role.ARROW
            });

            checkbox.child.insert_child_at_index(indicator, 4);
            return checkbox;
        }

        /**
         * Adds arrows and margins to denote subtasks.
         *
         * @param {Checkbox.Checkbox} checkbox - Checkbox to style.
         * @param {number} depth - Depth level of a subtask.
         *
         * @returns {Checkbox.Checkbox} Styled checkbox.
         */
        _styleSubtaskCheckbox(checkbox, depth) {
            const rtl = this.text_direction === Clutter.TextDirection.RTL;

            const arrow = new St.Label({
                accessible_name: _('Beginning of a subtask list'),
                accessible_role: Atk.Role.ARROW,
                style_class: 'subtask-indicator',
                text: rtl ? Utils.ARC_UP_LEFT_CHAR_ : Utils.ARC_UP_RIGHT_CHAR_
            });

            checkbox._arrow = arrow;
            checkbox.child.insert_child_at_index(arrow, 0);

            checkbox.connect('show', (self) => {
                const scaleFactor = St.ThemeContext.get_for_stage(
                    global.stage
                ).scale_factor;

                const boxWidth = self._box.get_width() / scaleFactor;

                const spacing =
                    self.child.get_theme_node().get_length('spacing') /
                    scaleFactor;

                if (rtl) {
                    self._arrow.set_style(
                        `padding-left: ${
                            boxWidth - self._arrow.get_width() / scaleFactor
                        }px`
                    );

                    self.set_style(
                        `margin-right: ${--depth * (boxWidth + spacing)}px`
                    );
                } else {
                    self._arrow.set_style(
                        `padding-right: ${
                            boxWidth - self._arrow.get_width() / scaleFactor
                        }px`
                    );

                    self.set_style(
                        `margin-left: ${--depth * (boxWidth + spacing)}px`
                    );
                }
            });

            return checkbox;
        }

        /**
         * Creates due date labels for tasks.
         *
         * @param {Date|null} due - Due date of a task.
         * @param {boolean} [root] - Task is a root tasks (not subtask).
         * @param {boolean} [orphan] - Task is an orphan task.
         *
         * @returns {St.Label} Due date label.
         */
        _buildDueDateLabel(due, root = false, orphan = false) {
            const today = new Date();

            const label = new St.Label({
                style_class: 'world-clocks-header',
                x_align: Clutter.ActorAlign.START
            });

            if (!root) label.add_style_class_name('subtask-label');

            if (due === null && root) {
                label.text = _('No due date');
            } else if (due.toDateString() === today.toDateString()) {
                label.text = _('Today');
            } else if (
                due < today &&
                this._settings.get_boolean('group-past-tasks') &&
                root
            ) {
                /* Translators: this is a category name for tasks with
                due date in the past. */
                label.text = _('Past');

                if (this._previousDueDate && !orphan) label._skip = true;
            } else {
                let format =
                    due.getYear() === today.getYear()
                        ? /* Translators: %A is the weekday name (e.g. Friday)
                        %B is the name of the month (e.g. February)
                        %-d is the day of the month, a decimal number ("-"
                        before "d" disables padding with zeros (e.g. prints "2"
                        instead of "02")
                        %Y is the year as a decimal number including the
                        century (e.g. 2021)

                        So, "%A, %B %-d" in English translates to e.g. "Friday,
                        February 2".

                        The idea is of course to adjust these placeholders
                        according to the format used in your language. */
                          NC_('task due date', '%A, %B %-d')
                        : NC_('task due date with a year', '%A, %B %-d, %Y');

                format = Shell.util_translate_time_string(format);
                const diff = this._toUTC(due) - this._toUTC(today);

                label.text = `${formatDateWithCFormatString(due, format)} (${
                    diff > 0 ? '+' : '-'
                }${Math.floor(Math.abs(diff) / Utils.MSECS_IN_DAY_)})`;
            }

            return label;
        }

        /**
         * Prepends due date to subtasks.
         *
         * @param {Checkbox.Checkbox} checkbox - Checkbox to modify.
         * @param {Date|null} due - Due date of a task.
         *
         * @returns {Checkbox.Checkbox} Checkbox with a prepended due date.
         */
        _prependDueDate(checkbox, due) {
            if (!due || checkbox.checked) return checkbox;

            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL
            });

            const subTaskSummary = checkbox.child.get_child_at_index(5);
            checkbox.child.remove_child(subTaskSummary);
            box.add_child(this._buildDueDateLabel(due));

            if (this.text_direction === Clutter.TextDirection.RTL)
                subTaskSummary.set_x_align(Clutter.ActorAlign.START);

            box.add_child(subTaskSummary);
            checkbox.child.insert_child_at_index(box, 5);
            return checkbox;
        }

        /**
         * Adds subtasks to root tasks.
         *
         * @param {Checkbox.Checkbox} parentCheckbox - Parent checkbox to append
         * subtasks to.
         * @param {string} parentUid - UID of the parent checkbox.
         * @param {number} [depth] - Depth level of a subtask.
         */
        _addSubtasks(parentCheckbox, parentUid, depth = 0) {
            if (!this._idleAddId) return;

            const subtasks = this._relatedTo.get(parentUid);

            if (!subtasks) return;

            for (const [index, subtask] of subtasks.entries()) {
                let subtaskCheckbox = this._buildCheckbox(subtask);

                subtaskCheckbox = this._styleSubtaskCheckbox(
                    subtaskCheckbox,
                    depth + 1
                );

                if (parentCheckbox._subtasks)
                    parentCheckbox._subtasks.push(subtaskCheckbox);
                else parentCheckbox._subtasks = [subtaskCheckbox];

                subtaskCheckbox._parentCheckbox = parentCheckbox;

                if (index !== 0) subtaskCheckbox._arrow.set_opacity(0);

                subtaskCheckbox = this._prependDueDate(
                    subtaskCheckbox,
                    subtask._due
                );

                this._idleAddHelper(subtaskCheckbox);
                this._relatedTo.delete(parentUid);
                this._addSubtasks(subtaskCheckbox, subtask._uid, depth + 1);
            }
        }

        /**
         * Facilitates lazy loading of task box items.
         *
         * @param {*} item - Object to add to the task box.
         */
        _idleAddHelper(item) {
            if (!this._idleAddId) return;

            const adjustment = this._scrollView.get_vadjustment();
            const height = this._taskBox.get_allocation_box().get_height();
            const limit = this._upperLimit + height + this._threshold;

            if (this._currentChild) {
                this._replaceTasksOnGoing = true;
                const { allocation } = this._currentChild;

                // Skip tasks above the visible region:
                if (allocation.y2 >= adjustment.value) {
                    this._taskBox.replace_child(this._currentChild, item);
                    this._currentChild = item.get_next_sibling();

                    // Reset focused checkbox after update:
                    if (this._focused) {
                        if (this._focused['previous'] === item._uid)
                            this._focused['refocus'] = item;
                        else if (this._focused['focused']._uid === item._uid)
                            item.grab_key_focus();
                        else if (
                            this._focused['next'] === item._uid &&
                            !this._focused['focused'].has_key_focus()
                        )
                            this._focused['refocus'] = item;
                        else if (
                            !this._focused['previous'] &&
                            !this._focused['next']
                        )
                            this._taskListNameButton.grab_key_focus();
                    }
                } else {
                    this._currentChild = this._currentChild.get_next_sibling();

                    return;
                }

                if (
                    this._currentChild &&
                    this._currentChild.allocation.y1 > limit
                ) {
                    this._replaceTasksOnGoing = false;

                    // Clean tasks below the visible region. These are
                    // leftover tasks from previous longer task lists:
                    while (this._currentChild) {
                        const next = this._currentChild.get_next_sibling();
                        this._currentChild.destroy();
                        this._currentChild = next;
                    }
                }
            } else {
                this._taskBox.add_child(item);
                this._replaceTasksOnGoing = false;
            }

            // Load tasks in small increments. If the last task has
            // children, keep loading until all children are loaded:
            if (
                adjustment.upper > limit &&
                !this._replaceTasksOnGoing &&
                this._taskBox.last_child._rootTask
            )
                this._resetTaskBox(false, true);
        }

        /**
         * Adds task checkboxes.
         */
        _idleAdd() {
            const task = this._rootTasks[this._currentRootTask++];

            if (!task) {
                // Clean leftover tasks from previous task lists:
                while (this._currentChild) {
                    const next = this._currentChild.get_next_sibling();
                    this._currentChild.destroy();
                    this._currentChild = next;
                }

                this._allTasksLoaded = true;
                return this._resetTaskBox(false, true);
            }

            const checkbox = this._buildCheckbox(task, true);
            const due = task._due;

            // If a task belongs to an already created group:
            if (
                (due === null && due === this._previousDueDate) ||
                (this._previousDueDate &&
                    due &&
                    due.toDateString() === this._previousDueDate.toDateString())
            ) {
                // Simply add the task:
                this._idleAddHelper(checkbox);
            } else {
                // Otherwise, we need a new group label:
                const label = this._buildDueDateLabel(due, true);

                if (label._skip) {
                    this._idleAddHelper(checkbox);
                    this._addSubtasks(checkbox, task._uid);
                    return GLib.SOURCE_CONTINUE;
                } else {
                    this._idleAddHelper(label);
                    this._idleAddHelper(checkbox);
                    this._previousDueDate = due;
                }
            }

            this._addSubtasks(checkbox, task._uid);
            return GLib.SOURCE_CONTINUE;
        }

        /**
         * Filters tasks and task lists based on user-defined settings.
         *
         * @async
         * @param {string} listId - Task list ID to filter.
         *
         * @returns {object[]|undefined} Filtered tasks or undefined if list is empty/all completed.
         */
        _filterTasks(listId) {
            try {
                let tasks = this._syncEngine.getTasks(listId);

                const categoryFilter = this._getCategoryFilter();
                if (categoryFilter)
                    tasks = tasks.filter(categoryFilter);

                const completedFilter = this._getCompletedFilter();
                if (completedFilter)
                    tasks = tasks.filter(completedFilter);

                // Hide empty and completed task lists
                if (
                    this._settings.get_boolean(
                        'hide-empty-completed-task-lists'
                    ) &&
                    !this._settings.get_boolean('merge-task-lists')
                ) {
                    if (!tasks.length) return;

                    for (const task of tasks) {
                        if (!['completed', 'deferred'].includes(task.status))
                            return tasks;
                    }

                    return;
                }

                return tasks;
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Builds an S-expression to facilitate task filtering.
         *
         * @param {string} start - String with the ISO 8601 representation of a
        /**
         * Returns a filter function for hiding completed tasks based on
         * user settings, or null if no filtering needed.
         */
        _getCompletedFilter() {
            const mode = this._settings.get_int('hide-completed-tasks');

            switch (mode) {
                case Utils.HIDE_COMPLETED_TASKS_['immediately']:
                    return (task) => task.status !== 'completed';

                case Utils.HIDE_COMPLETED_TASKS_['after-time-period']: {
                    const adjust = this._settings.get_int('hct-apotac-value');
                    const unit = this._settings.get_int('hct-apotac-unit');
                    const now = new Date();
                    let msAdjust = 0;

                    switch (unit) {
                        case Utils.TIME_UNITS_['seconds']:
                            msAdjust = adjust * 1000; break;
                        case Utils.TIME_UNITS_['minutes']:
                            msAdjust = adjust * 60000; break;
                        case Utils.TIME_UNITS_['hours']:
                            msAdjust = adjust * 3600000; break;
                        case Utils.TIME_UNITS_['days']:
                            msAdjust = adjust * 86400000; break;
                    }

                    const cutoff = new Date(now.getTime() - msAdjust);

                    return (task) => {
                        if (task.status !== 'completed') return true;
                        if (!task.completedDateTime) return false;
                        return task.completedDateTime >= cutoff;
                    };
                }

                case Utils.HIDE_COMPLETED_TASKS_['after-specified-time']: {
                    const now = new Date();
                    const startOfDay = new Date(
                        now.getFullYear(), now.getMonth(), now.getDate()
                    );
                    const specHour = this._settings.get_int('hct-astod-hour');
                    const specMin = this._settings.get_int('hct-astod-minute');
                    const specTime = new Date(
                        now.getFullYear(), now.getMonth(), now.getDate(),
                        specHour, specMin, 0
                    );

                    if (now < specTime) {
                        return (task) => {
                            if (task.status !== 'completed') return true;
                            if (!task.completedDateTime) return false;
                            return task.completedDateTime >= startOfDay;
                        };
                    } else {
                        return (task) => task.status !== 'completed';
                    }
                }

                default:
                    return null;
            }
        }

        /**
         * Builds an S-expression to facilitate showing of only selected task
         * categories.
         *
         * @returns {string} S-expression to facilitate task filtering.
         */
        /**
         * Returns a filter function for category-based task filtering,
         * or null if no filtering needed.
         */
        _getCategoryFilter() {
            const selected = this._settings.get_strv(
                'selected-task-categories'
            );

            if (
                !this._settings.get_boolean('show-only-selected-categories') ||
                !selected.length
            )
                return null;

            const now = new Date();
            const startOfToday = new Date(
                now.getFullYear(), now.getMonth(), now.getDate()
            );
            const endOfToday = new Date(startOfToday.getTime() + 86400000 - 1);
            const startOfTomorrow = new Date(startOfToday.getTime() + 86400000);
            const endOfTomorrow = new Date(startOfTomorrow.getTime() + 86400000 - 1);
            const endOfNextSevenDays = new Date(startOfToday.getTime() + 7 * 86400000 - 1);
            const endOfYesterday = new Date(startOfToday.getTime() - 1);

            const filters = [];

            const dueDateFilter = (task) => {
                const due = task.dueDateTime;

                if (selected.includes('past') && due && due < startOfToday)
                    return true;
                if (selected.includes('today') && due && due >= startOfToday && due <= endOfToday)
                    return true;
                if (selected.includes('tomorrow') && due && due >= startOfTomorrow && due <= endOfTomorrow)
                    return true;
                if (selected.includes('next-seven-days') && due && due >= startOfToday && due <= endOfNextSevenDays)
                    return true;

                // If none of the date categories match but we have date filters,
                // only show if no date categories are selected
                const hasDateCategory = ['past', 'today', 'tomorrow', 'next-seven-days']
                    .some(c => selected.includes(c));

                return !hasDateCategory;
            };

            filters.push(dueDateFilter);

            if (selected.includes('scheduled'))
                filters.push((task) => task.dueDateTime !== null);

            if (selected.includes('unscheduled'))
                filters.push((task) => task.dueDateTime === null || dueDateFilter(task));

            if (selected.includes('not-cancelled'))
                filters.push((task) => task.status !== 'deferred');

            return (task) => filters.every(f => f(task));
        }

        /**
         * Handles task click events. Adds/removes styling and stores changes.
         *
         * @async
         * @param {Checkbox} checkbox - Checkbox that got clicked.
         */
        async _taskClicked(checkbox) {
            // Skip if inline edit is active — the click propagated from
            // the edit/delete button to the parent CheckBox.
            if (this._editingTask) return;

            try {
                this._resetTaskBox();
                const task = checkbox._task;
                const listId = task._taskList;

                if (task._isChecklistItem) {
                    // Toggle checklist item
                    await this._syncEngine.toggleChecklistItem(
                        listId, task._parentTaskId, task.id
                    );
                } else {
                    // Toggle task complete/uncomplete
                    if (checkbox.checked) {
                        checkbox.getLabelActor().set_opacity(100);
                        await this._syncEngine.completeTask(listId, task.id);
                    } else {
                        checkbox.getLabelActor().set_opacity(255);
                        await this._syncEngine.uncompleteTask(listId, task.id);
                    }
                }

                this._showActiveTaskList(this._activeTaskList);
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Handles task delete button clicks. Deletes task via sync engine
         * and refreshes the task list.
         *
         * @async
         * @param {Checkbox} checkbox - Checkbox whose task should be deleted.
         */
        async _onDeleteTask(checkbox) {
            try {
                const task = checkbox._task;
                const listId = task._taskList;
                if (task._isChecklistItem && task._parentTaskId) {
                    await this._syncEngine.deleteSubtask(
                        listId, task._parentTaskId, task.id
                    );
                } else {
                    await this._syncEngine.deleteTask(listId, task.id);
                }
                this._showActiveTaskList(this._activeTaskList);
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Handles inline editing of a task title.
         * @param {CheckBox.CheckBox} checkbox - The checkbox whose task to edit.
         */
        _onEditTask(checkbox) {
            const task = checkbox._task;
            const labelActor = checkbox.getLabelActor();

            this._editingTask = true;

            const originalText = task.title;
            labelActor.hide();

            const entry = new St.Entry({
                text: originalText,
                can_focus: true,
                x_expand: true,
                style: 'padding: 2px 4px;',
            });

            const parent = labelActor.get_parent();
            const labelIndex = parent.get_children().indexOf(labelActor);
            parent.insert_child_at_index(entry, labelIndex + 1);

            entry.grab_key_focus();
            entry.get_clutter_text().set_selection(0, -1);

            // Cleanup guard — only manipulate widgets if they're still
            // alive in the widget tree.  If tasks-changed triggers a
            // tree rebuild while the entry exists, the widgets will
            // already be destroyed; touching them would hit the
            // clutter_actor_set_mapped assertion.
            let cleaned = false;
            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                this._editingTask = false;
                try {
                    if (entry && !entry.is_finalized?.() && entry.get_parent()) {
                        entry.get_parent().remove_child(entry);
                        entry.destroy();
                    }
                    if (labelActor && !labelActor.is_finalized?.()) {
                        labelActor.show();
                    }
                } catch (e) {
                    // Widget already destroyed by tree rebuild — ignore
                }
                // Flush any deferred tree rebuilds that were suppressed
                // while inline edit was active (e.g. lists-changed,
                // settings-changed, periodic refresh).
                this._onSyncUpdate();
            };

            // Enter = save — cleanup synchronously, then fire-and-forget
            // the API call so the entry is gone before any tree rebuild.
            entry.get_clutter_text().connect('activate', () => {
                const newTitle = entry.get_text().trim();
                cleanup();
                if (newTitle && newTitle !== originalText) {
                    this._syncEngine.updateTaskTitle(
                        task._taskList, task.id, newTitle
                    ).catch(e => logError(e));
                }
            });

            // Escape = cancel
            entry.get_clutter_text().connect('key-press-event', (_actor, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    cleanup();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            // NO key-focus-out handler — focus loss during widget tree
            // replacement (tasks-changed → _idleAddHelper) causes the
            // Clutter unmap assertion crash.  Only explicit user actions
            // (Enter / Escape) trigger cleanup.
        }

        /**
         * Handles adding a subtask via an inline entry below the task row.
         * Shows a text entry; Enter creates the subtask, Escape cancels.
         * @param {CheckBox.CheckBox} checkbox - The parent task checkbox.
         */
        _onAddSubtask(checkbox) {
            const task = checkbox._task;

            this._editingTask = true;

            const entry = new St.Entry({
                hint_text: _('Add a subtask...'),
                can_focus: true,
                x_expand: true,
                style: 'padding: 2px 4px; margin-left: 24px; margin-top: 2px; margin-bottom: 2px;',
            });

            const taskBox = checkbox.get_parent();
            if (!taskBox) {
                this._editingTask = false;
                return;
            }
            const checkboxIndex = taskBox.get_children().indexOf(checkbox);
            taskBox.insert_child_at_index(entry, checkboxIndex + 1);

            entry.grab_key_focus();

            let cleaned = false;
            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                this._editingTask = false;
                try {
                    if (entry && !entry.is_finalized?.() && entry.get_parent()) {
                        entry.get_parent().remove_child(entry);
                        entry.destroy();
                    }
                } catch (e) {
                    // Widget already destroyed — ignore
                }
                this._onSyncUpdate();
            };

            // Enter = create subtask
            entry.get_clutter_text().connect('activate', () => {
                const title = entry.get_text().trim();
                cleanup();
                if (title) {
                    this._syncEngine.createSubtask(
                        task._taskList, task.id, title
                    ).catch(e => logError(e));
                }
            });

            // Escape = cancel
            entry.get_clutter_text().connect('key-press-event', (_actor, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    cleanup();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        /**
         * Handles due date editing for a task via an inline spinner picker.
         * Two side-by-side spinners (Month | Day) with up/down arrows,
         * plus Today / Clear / OK action buttons.
         * @param {CheckBox.CheckBox} checkbox - The checkbox whose task to edit.
         */
        _onDueDateTask(checkbox) {
            const task = checkbox._task;

            if (this._activeDueDatePicker) {
                try {
                    const prev = this._activeDueDatePicker;
                    if (prev.get_parent())
                        prev.get_parent().remove_child(prev);
                    prev.destroy();
                } catch (e) {
                    // Already destroyed — ignore
                }
                this._activeDueDatePicker = null;
            }

            const initDate = task.dueDateTime
                ? new Date(task.dueDateTime)
                : new Date();
            let selMonth = initDate.getMonth();     // 0-11
            let selDay = initDate.getDate();         // 1-31
            let selYear = initDate.getFullYear();

            const monthNames = [
                _('January'), _('February'), _('March'), _('April'),
                _('May'), _('June'), _('July'), _('August'),
                _('September'), _('October'), _('November'),
                _('December'),
            ];

            function daysInMonth(month, year) {
                return new Date(year, month + 1, 0).getDate();
            }

            function clampDay() {
                const max = daysInMonth(selMonth, selYear);
                if (selDay > max) selDay = max;
            }

            function updateDisplay() {
                monthValueLabel.text = monthNames[selMonth];
                dayValueLabel.text = `${selDay}`;
                yearLabel.text = `${selYear}`;
            }

            const picker = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'task-duedate-calendar date-spinner-picker',
            });
            this._activeDueDatePicker = picker;

            const spinnerRow = new St.BoxLayout({
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'date-spinner-row',
            });

            const monthSpinner = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'date-spinner',
            });

            const monthUpBtn = new St.Button({
                style_class: 'date-spinner-arrow',
                can_focus: true,
                child: new St.Icon({
                    icon_name: 'pan-up-symbolic',
                    icon_size: 16,
                }),
            });

            const monthValueLabel = new St.Label({
                text: monthNames[selMonth],
                style_class: 'date-spinner-value date-spinner-month',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const monthDownBtn = new St.Button({
                style_class: 'date-spinner-arrow',
                can_focus: true,
                child: new St.Icon({
                    icon_name: 'pan-down-symbolic',
                    icon_size: 16,
                }),
            });

            monthSpinner.add_child(monthUpBtn);
            monthSpinner.add_child(monthValueLabel);
            monthSpinner.add_child(monthDownBtn);

            const yearLabel = new St.Label({
                text: `${selYear}`,
                style_class: 'date-spinner-year',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const daySpinner = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'date-spinner',
            });

            const dayUpBtn = new St.Button({
                style_class: 'date-spinner-arrow',
                can_focus: true,
                child: new St.Icon({
                    icon_name: 'pan-up-symbolic',
                    icon_size: 16,
                }),
            });

            const dayValueLabel = new St.Label({
                text: `${selDay}`,
                style_class: 'date-spinner-value date-spinner-day',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const dayDownBtn = new St.Button({
                style_class: 'date-spinner-arrow',
                can_focus: true,
                child: new St.Icon({
                    icon_name: 'pan-down-symbolic',
                    icon_size: 16,
                }),
            });

            daySpinner.add_child(dayUpBtn);
            daySpinner.add_child(dayValueLabel);
            daySpinner.add_child(dayDownBtn);

            spinnerRow.add_child(monthSpinner);
            spinnerRow.add_child(yearLabel);
            spinnerRow.add_child(daySpinner);
            picker.add_child(spinnerRow);

            const bottomRow = new St.BoxLayout({
                x_expand: true,
                style_class: 'date-spinner-actions',
            });

            const todayBtn = new St.Button({
                label: _('Today'),
                style_class: 'date-spinner-action-btn button',
                can_focus: true,
                x_expand: true,
            });

            const clearBtn = new St.Button({
                label: _('Clear'),
                style_class: 'date-spinner-action-btn button',
                can_focus: true,
                x_expand: true,
            });

            const okBtn = new St.Button({
                label: _('OK'),
                style_class: 'date-spinner-action-btn button',
                can_focus: true,
                x_expand: true,
            });

            bottomRow.add_child(todayBtn);
            bottomRow.add_child(clearBtn);
            bottomRow.add_child(okBtn);
            picker.add_child(bottomRow);

            const taskBox = checkbox.get_parent();
            if (taskBox) {
                const children = taskBox.get_children();
                const checkboxIndex = children.indexOf(checkbox);
                taskBox.insert_child_at_index(picker, checkboxIndex + 1);
            }


            monthUpBtn.connect('clicked', () => {
                if (selMonth === 11) {
                    selMonth = 0;
                    selYear++;
                } else {
                    selMonth++;
                }
                clampDay();
                updateDisplay();
            });

            monthDownBtn.connect('clicked', () => {
                if (selMonth === 0) {
                    selMonth = 11;
                    selYear--;
                } else {
                    selMonth--;
                }
                clampDay();
                updateDisplay();
            });

            dayUpBtn.connect('clicked', () => {
                const max = daysInMonth(selMonth, selYear);
                if (selDay >= max)
                    selDay = 1;
                else
                    selDay++;
                updateDisplay();
            });

            dayDownBtn.connect('clicked', () => {
                if (selDay <= 1)
                    selDay = daysInMonth(selMonth, selYear);
                else
                    selDay--;
                updateDisplay();
            });


            todayBtn.connect('clicked', () => {
                const now = new Date();
                selMonth = now.getMonth();
                selDay = now.getDate();
                selYear = now.getFullYear();
                updateDisplay();
            });

            clearBtn.connect('clicked', () => {
                applyDate.call(this, null);
            });

            okBtn.connect('clicked', () => {
                const date = new Date(selYear, selMonth, selDay);
                date.setHours(0, 0, 0, 0);
                applyDate.call(this, date);
            });

            function applyDate(date) {
                if (picker.get_parent())
                    picker.get_parent().remove_child(picker);
                picker.destroy();
                this._activeDueDatePicker = null;

                this._syncEngine.updateTaskDueDate(
                    task._taskList, task.id, date
                ).catch(e => logError(e));
            }
        }

        /**
         * Either sets and shows the active task list or shows the placeholder.
         *
         * @async
         * @param {number|null} index - Index of the task list to activate or
         * `null` to show the placeholder instead.
         */
        async _showActiveTaskList(index) {
            try {
                this._activeTaskList = index;

                if ((!DateMenu.isOpen && index !== null) || this._idleAddId)
                    return;

                const taskList = this._taskLists[index];

                if (taskList) {
                    if (!this._contentBox.visible) this._contentBox.show();

                    const merge =
                        (this._settings.get_boolean('merge-task-lists') ||
                            this._mergeTaskLists) &&
                        this._taskLists.length;

                    this._taskListName.set_text(
                        merge ? _('All Tasks') : taskList.name
                    );

                    if (merge) {
                        this._headerBackendIcon.visible = false;
                    } else {
                        const hdrGIcon = this._backendGIcon(taskList.backendId);
                        if (hdrGIcon) {
                            this._headerBackendIcon.gicon = hdrGIcon;
                            this._headerBackendIcon.visible = true;
                        } else {
                            this._headerBackendIcon.visible = false;
                        }
                    }

                    this._settings.set_string(
                        'last-active',
                        merge ? 'merge' : taskList.uid
                    );

                    this._setHeader();

                    if (!this._listTasks(taskList.uid, merge)) {
                        Utils.debounce_(
                            this._showActiveTaskList.bind(this),
                            'show',
                            200,
                            false
                        )(this._activeTaskList);
                    }
                } else if (this._contentBox.visible) {
                    this._contentBox.hide();
                }
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Watches the 'auth-event' GSettings key for changes from prefs.
         * When prefs completes sign-in, it writes to this key, triggering
         * the extension to re-initialize.
         */
        _watchForAuth() {
            if (this._authWatchId) return;
            this._lastAuthEventTime = 0;
            this._initInProgress = false;
            this._authWatchId = this._settings.connect(
                'changed::auth-event', () => {
                    const val = this._settings.get_string('auth-event');
                    if (!val) return;

                    // Validate format
                    if (!/^(sign-in|sign-out):\d+$/.test(val))
                        return;

                    // Debounce: ignore events within 5 seconds
                    const now = Date.now();
                    if (now - this._lastAuthEventTime < 5000)
                        return;
                    this._lastAuthEventTime = now;

                    const [action] = val.split(':');

                    // Clear user data on sign-out
                    if (action === 'sign-out')
                        Utils.clearAccountData_(this._settings);

                    if (this._tokenRetryId) {
                        GLib.source_remove(this._tokenRetryId);
                        this._tokenRetryId = 0;
                    }
                    if (this._syncEngine) {
                        this._syncEngine.destroy();
                        this._syncEngine = null;
                    }
                    if (this._backends) {
                        for (const [, backend] of this._backends)
                            backend.destroy();
                        this._backends = null;
                    }
                    if (this._pendingBackends) {
                        for (const backend of this._pendingBackends)
                            backend.destroy();
                        this._pendingBackends = null;
                    }
                    if (this._filterMenu) {
                        if (this._filterMenu.actor.get_parent() === Main.uiGroup)
                            Main.uiGroup.remove_child(this._filterMenu.actor);
                        this._filterMenu.destroy();
                        this._filterMenu = null;
                    }
                    if (this._settingsFilterId) {
                        this._settings.disconnect(this._settingsFilterId);
                        this._settingsFilterId = 0;
                    }
                    if (this._completedMenu) {
                        if (this._completedMenu.actor.get_parent() === Main.uiGroup)
                            Main.uiGroup.remove_child(this._completedMenu.actor);
                        this._completedMenu.destroy();
                        this._completedMenu = null;
                    }
                    if (this._settingsCompletedId) {
                        this._settings.disconnect(this._settingsCompletedId);
                        this._settingsCompletedId = 0;
                    }
                    if (this._contentBox) {
                        this._contentBox.destroy();
                        this._contentBox = null;
                    }
                    if (this._onMenuOpenId) {
                        DateMenu.disconnect(this._onMenuOpenId);
                        this._onMenuOpenId = 0;
                    }
                    if (this._settingsChangedId) {
                        this._settings.disconnect(this._settingsChangedId);
                        this._settingsChangedId = 0;
                    }
                    this._linkLabel.hide();
                    if (!this._initInProgress) {
                        this._initInProgress = true;
                        this._initTaskLists().finally(() => {
                            this._initInProgress = false;
                        });
                    }
                }
            );

            if (!this._settingsTodoistAuthId) {
                this._settingsTodoistAuthId = this._settings.connect(
                    'changed::todoist-auth-event',
                    () => {
                        const val = this._settings.get_string('todoist-auth-event');
                        if (!val) return;

                        // Debounce: ignore events within 5 seconds
                        const now = Date.now();
                        if (now - (this._lastTodoistAuthEventTime || 0) < 5000)
                            return;
                        this._lastTodoistAuthEventTime = now;

                        if (!this._initInProgress) {
                            this._initInProgress = true;
                            this._reinitBackends().finally(() => {
                                this._initInProgress = false;
                            });
                        }
                    }
                );
            }
        }

        /**
         * Re-initialize all backends and the sync engine.
         * Used when auth state changes (e.g. Todoist token added/removed).
         */
        async _reinitBackends() {
            if (this._syncEngine) {
                this._syncEngine.destroy();
                this._syncEngine = null;
            }

            if (this._backends) {
                for (const [, backend] of this._backends)
                    backend.destroy();
                this._backends = null;
            }
            if (this._pendingBackends) {
                for (const backend of this._pendingBackends)
                    backend.destroy();
                this._pendingBackends = null;
            }

            if (this._filterMenu) {
                if (this._filterMenu.actor.get_parent() === Main.uiGroup)
                    Main.uiGroup.remove_child(this._filterMenu.actor);
                this._filterMenu.destroy();
                this._filterMenu = null;
            }
            if (this._settingsFilterId) {
                this._settings.disconnect(this._settingsFilterId);
                this._settingsFilterId = 0;
            }
            if (this._completedMenu) {
                if (this._completedMenu.actor.get_parent() === Main.uiGroup)
                    Main.uiGroup.remove_child(this._completedMenu.actor);
                this._completedMenu.destroy();
                this._completedMenu = null;
            }
            if (this._settingsCompletedId) {
                this._settings.disconnect(this._settingsCompletedId);
                this._settingsCompletedId = 0;
            }
            if (this._contentBox) {
                this._contentBox.destroy();
                this._contentBox = null;
            }
            if (this._onMenuOpenId) {
                DateMenu.disconnect(this._onMenuOpenId);
                this._onMenuOpenId = 0;
            }
            if (this._settingsChangedId) {
                this._settings.disconnect(this._settingsChangedId);
                this._settingsChangedId = 0;
            }
            this._linkLabel.hide();

            await this._initTaskLists();
        }

        /**
         * Attempt to load tokens for any pending backends.
         * @returns {Promise<boolean>} true if at least one backend loaded.
         */
        async _retryPendingBackends() {
            if (!this._pendingBackends || !this._pendingBackends.length)
                return false;

            const stillPending = [];
            let anyLoaded = false;

            for (const backend of this._pendingBackends) {
                try {
                    const loaded = await backend.loadTokens();
                    if (loaded && backend.isAuthenticated()) {
                        this._backends.set(backend.id, backend);
                        anyLoaded = true;
                    } else {
                        stillPending.push(backend);
                    }
                } catch (e) {
                    stillPending.push(backend);
                }
            }

            this._pendingBackends = stillPending;
            return anyLoaded;
        }

        /**
         * Sets placeholder appearance and text.
         *
         * @param {string} status - String to differentiate between various
         * statuses of the placeholder.
         */
        /**
         * Formats a Date into a human-readable relative time string.
         *
         * @param {Date} date - Date to format.
         * @returns {string} Relative time string (e.g. "5m ago").
         */
        _formatTimeAgo(date) {
            const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
            if (seconds < 60) return 'just now';
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return `${minutes}m ago`;
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return `${hours}h ago`;
            const days = Math.floor(hours / 24);
            return `${days}d ago`;
        }

        _showPlaceholderWithStatus(status) {
            this._taskLists = [];
            this._showActiveTaskList(null);

            switch (status) {
                case 'no-tasks':
                    this._taskIcon.set_gicon(
                        Gio.ThemedIcon.new('checkbox-checked-symbolic')
                    );

                    this._statusLabel.set_text(_('No Tasks'));
                    break;
                case 'missing-dependencies': {
                    this._taskIcon.set_gicon(
                        Gio.ThemedIcon.new('system-users-symbolic')
                    );

                    this._statusLabel.set_text(
                        _('Please Sign In')
                    );

                    // Show clickable install guide link
                    this._linkLabel.set_text(_('Installation Guide'));
                    this._linkLabel.show();
                    this._linkLabel.add_style_class_name('url-highlighter');

                    this._linkLabel.connect('style-changed', () => {
                        const [hasColor, color] = this._linkLabel
                            .get_theme_node()
                            .lookup_color('link-color', false);

                        this._linkLabel.set_style(`color: ${
                            hasColor
                                ? color.to_string().substr(0, 7)
                                : '#629fea'
                        };
                        text-decoration: underline; margin-top: 8px;`);
                    });

                    this._linkLabel.connect('motion-event', () => {
                        global.display.set_cursor(Meta.Cursor.POINTER);
                        return Clutter.EVENT_PROPAGATE;
                    });

                    this._linkLabel.connect('leave-event', () => {
                        global.display.set_cursor(Meta.Cursor.DEFAULT);
                        return Clutter.EVENT_PROPAGATE;
                    });

                    this._linkLabel.connect('button-release-event', () => {
                        Gio.app_info_launch_default_for_uri(
                            this._metadata.dependencies,
                            global.create_app_launch_context(0, -1)
                        );

                        DateMenu.close();
                        return Clutter.EVENT_STOP;
                    });
                }
            }
        }

        /**
         * Handles switching bewtween task lists in the task list header.
         *
         * @param {boolean} next - Show the next task list in the list.
         * @param {St.Button} button - Associated button.
         */
        _onTaskListSwitched(next, button) {
            let i = this._activeTaskList;

            if (next) i = ++i % this._taskLists.length;
            else if (i === 0) i = this._taskLists.length - 1;
            else --i;

            if (this._mergeTaskLists) delete this._mergeTaskLists;

            this._taskListMenu.close();
            button.grab_key_focus();
            this._resetTaskBox(true);
            this._showActiveTaskList(i);
        }

        /**
         * Task lists may have a lot of tasks. Loading them all in the widget
         * may noticeably delay the appearance of the top menu. To prevent
         * that, we'll do a lazy loading of tasks: initially only a fraction of
         * them will be loaded. The remaining ones will appear when user
         * scrolls down. This function allows to increase the upper adjustment
         * of the vertical scrollbar if that scrollbar is close to the end of
         * the scrolled window. That in turn will allow to load more tasks.
         *
         * @param {St.Adjustment} adjustment - Vertical scrollbar adjustment.
         */
        _onTaskListScrolled(adjustment) {
            if (
                this._allTasksLoaded ||
                this._idleAddId ||
                adjustment.value === 0
            )
                return;

            const height = this._taskBox.allocation.get_height();

            if (
                adjustment.upper - adjustment.value - height <=
                this._threshold
            ) {
                this._upperLimit += height;
                this._showActiveTaskList(this._activeTaskList);
            }
        }

        /**
         * Sets task list header appearance.
         */
        _setHeader() {
            const singular =
                this._taskLists.length === 1 ||
                this._settings.get_boolean('merge-task-lists');

            if (singular) {
                this._backButton.hide();
                this._forwardButton.hide();
                this._taskListNameArrow.hide();
                this._taskListNameButton.remove_style_class_name('button');
                this._taskListNameButton.set_reactive(false);
            } else {
                this._backButton.show();
                this._forwardButton.show();
                this._taskListNameArrow.show();
                this._taskListNameButton.add_style_class_name('button');
                this._taskListNameButton.set_reactive(true);
            }

            this._filterButton.visible = this._taskLists.length > 0;

            this._refreshFilterIcon(
                this._settings.get_boolean('show-only-selected-categories') &&
                this._settings.get_strv('selected-task-categories').length > 0
            );

            if (
                !singular ||
                !this._settings.get_boolean(
                    'hide-header-for-singular-task-lists'
                )
            )
                this._headerBox.show();
            else this._headerBox.hide();
        }

        /**
         * Stops on-going `GLib.idle_add` operations, restores focus and resets
         * vertical scrollbar adjustment.
         *
         * @param {boolean} [fullReset] - Reset vertical scrollbar adjustment.
         * @param {boolean} [refocus] - Refocus the specified task checkbox.
         */
        _backendGIcon(backendId) {
            let filename;
            switch (backendId) {
            case 'microsoft':
                filename = 'ms-todo.svg';
                break;
            case 'todoist':
                filename = 'todoist.svg';
                break;
            default:
                return null;
            }
            const iconFile = Gio.File.new_for_path(
                `${this._metadata.path}/icons/${filename}`
            );
            return new Gio.FileIcon({file: iconFile});
        }

        _resetTaskBox(fullReset = false, refocus = false) {
            if (this._idleAddId) {
                GLib.source_remove(this._idleAddId);
                delete this._idleAddId;
            }

            if (refocus && this._focused && this._focused['refocus'])
                this._focused['refocus'].grab_key_focus();

            if (!fullReset) return;

            delete this._focused;
            this._scrollView.get_vadjustment().set_values(0, 0, 0, 0, 0, 0);
            this._upperLimit = 0;
        }

        /**
         * Handles scroll events on the task list header.
         *
         * @param {Clutter.Actor} _actor - Actor the event is associated to.
         * @param {Clutter.Event} event - Holds information about the event.
         * @returns {boolean} `false` to continue the propagation of the event.
         */
        _onHeaderScrolled(_actor, event) {
            if (
                this._taskLists.length !== 1 &&
                !this._settings.get_boolean('merge-task-lists')
            ) {
                switch (event.get_scroll_direction()) {
                    case Clutter.ScrollDirection.DOWN:
                    case Clutter.ScrollDirection.RIGHT:
                        this._onTaskListSwitched(true, this._forwardButton);
                        break;
                    case Clutter.ScrollDirection.UP:
                    case Clutter.ScrollDirection.LEFT:
                        this._onTaskListSwitched(false, this._backButton);
                        break;
                }

                return Clutter.EVENT_PROPAGATE;
            }
        }

        /**
         * Performs some styling tricks to improve appearance and compatibility
         * with custom Shell themes.
         *
         * @param {St.ThemeContext} context - Holds styling information.
         */
        _loadThemeHacks(context) {
            // Threshold is a fixed number, we have to scale it accordingly
            // whenever scale factor changes:
            this._threshold = Utils.LL_THRESHOLD_ * context.scale_factor;

            // To make Task Widget look as symmetric as possible, we need to use
            // swapped left and right margin/padding values of the message list
            // widget:
            const [r, l] = [St.Side.RIGHT, St.Side.LEFT].map(
                (side) =>
                    this._messageList._messageView
                        .get_theme_node()
                        .get_margin(side) / context.scale_factor
            );

            this._contentBox.set_style(
                `margin-right: ${l}px; margin-left: ${r}px`
            );

            const rtl = this.text_direction === Clutter.TextDirection.RTL;

            const sides = rtl
                ? [St.Side.LEFT, St.Side.RIGHT]
                : [St.Side.RIGHT, St.Side.LEFT];

            const [mr, ml] = sides.map(
                (side) =>
                    this._messageList.get_theme_node().get_margin(side) /
                    context.scale_factor
            );

            const [pr, pl] = sides.map(
                (side) =>
                    this._messageList.get_theme_node().get_padding(side) /
                    context.scale_factor
            );

            const color = this._messageList
                .get_theme_node()
                .get_border_color(rtl ? St.Side.LEFT : St.Side.RIGHT)
                .to_string()
                .substr(0, 7);

            const width = this._messageList
                .get_theme_node()
                .get_border_width(rtl ? St.Side.LEFT : St.Side.RIGHT);

            const left = rtl ? 'right' : 'left';
            const right = rtl ? 'left' : 'right';

            this.set_style(
                `border-${left}: ${width}px solid ${color};` +
                    `border-${right}: none; padding-${right}: ${pl}px;` +
                    `padding-${left}: ${pr}px; margin-${right}: ${ml}px;` +
                    `margin-${left}: ${mr + pr}px`
            );
        }

        /**
         * Task list events may happen when the extension is disabled. In such
         * state, removing one or more task lists will not remove their uids
         * from extension settings. This method runs every time the extension
         * loads and removes such obsolete uids.
         *
         * @param {string[]} disabled - List of disabled task lists.
         * @param {string[]} uids - List of task list uids ordered according to
         * custom user-defined order.
         */
        _cleanupSettings(disabled, uids) {
            if (disabled.length) {
                this._settings.set_strv(
                    'disabled-task-lists',
                    disabled.filter((list) => uids.indexOf(list) !== -1)
                );
            }

            if (this._settings.get_strv('task-list-order').length)
                this._settings.set_strv('task-list-order', uids);
        }

        /**
         * Shows the active task list whenever user opens the menu.
         * Additionally, initiates updates of the widget every 2 seconds (no
         * remote calls, local data only) if the following three conditions
         * are true: the menu is kept open, hiding of completed tasks is time
         * dependent and the number of occurred refreshes is <= 60.
         *
         * @param {object|null} _menu - Menu of a `dateMenu` button.
         * @param {boolean} isOpen - Menu is open.
         */
        _onMenuOpen(_menu, isOpen) {
            if (isOpen && this._activeTaskList !== null) {
                let i = 0;
                this._showActiveTaskList(this._activeTaskList);

                // Full refresh on panel open, then fast delta polling
                if (this._syncEngine) {
                    this._syncEngine.fullSync().catch(e =>
                        logError(e, 'fullSync on menu open'));
                    this._syncEngine.startPolling(30);
                }

                const hct = this._settings.get_int('hide-completed-tasks');

                if (Utils.HIDE_COMPLETED_TASKS_IS_TIME_DEPENDENT_(hct)) {
                    this._refreshTimeoutId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT,
                        2,
                        () => {
                            if (!this._idleAddId && !this._editingTask)
                                this._showActiveTaskList(this._activeTaskList);

                            if (i++ < 60 && this._activeTaskList !== null)
                                return GLib.SOURCE_CONTINUE;
                            else {
                                this._onMenuOpen(null, false);
                                return GLib.SOURCE_REMOVE;
                            }
                        }
                    );
                }
            } else if (!isOpen) {
                // Switch to background polling
                if (this._syncEngine) {
                    const interval = this._settings.get_int('sync-interval-minutes') || 5;
                    this._syncEngine.startPolling(interval * 60);
                }

                if (this._refreshTimeoutId) {
                    GLib.source_remove(this._refreshTimeoutId);
                    delete this._refreshTimeoutId;
                }

                if (!this._taskBox) return;
                const height = this._taskBox.get_allocation_box().get_height();

                // Once the menu is closed, remove tasks below the visible
                // region:
                this._cleanUpId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                    const last = this._taskBox.get_last_child();

                    if (last && last.allocation.y1 > height + this._threshold) {
                        last.destroy();
                        return GLib.SOURCE_CONTINUE;
                    }

                    delete this._cleanUpId;
                });

                delete this._rootTasks;
                delete this._orphanTasks;
                delete this._taskUids;
                this._resetTaskBox(true);
            }
        }

        /**
         * Updates the widget when extension settings change.
         *
         * @async
         * @param {Gio.Settings} _api - API for storing and retrieving settings.
         * @param {string} key - The name of the settings key that changed.
         */
        async _onSettingsChanged(_api, key) {
            try {
                const silentKeys = ['last-active'];

                if (silentKeys.includes(key)) return;
                // Defer tree rebuild while inline edit is active
                if (this._editingTask) return;

                const active = this._taskLists[this._activeTaskList]
                    ? this._taskLists[this._activeTaskList].uid
                    : null;

                await this._storeTaskLists();

                if (!this._taskLists.length) {
                    this._showPlaceholderWithStatus('no-tasks');
                    return;
                }

                // If enabled task list is the only visible task list, show it:
                if (!this._contentBox.visible) {
                    this._showActiveTaskList(0);
                } else {
                    // Otherwise, either refresh the current active task list
                    // or, if active task list is not visible anymore (i.e.
                    // we hid it), show the first task list in the list of
                    // visible task lists:
                    const index = this._taskLists
                        .map((i) => i.uid)
                        .indexOf(active);
                    this._showActiveTaskList(index !== -1 ? index : 0);
                }
            } catch (e) {
                logError(e);
            }
        }

        /**
         * Cleanup.
         */
        _onDestroy() {
            if (
                this._calendarWidget.has_style_class_name(
                    'docket-remove-calendar-margin'
                )
            ) {
                this._calendarWidget.remove_style_class_name(
                    'docket-remove-calendar-margin'
                );
            }

            if (
                this._taskListMenu &&
                this._taskListMenu.actor.get_parent() === Main.uiGroup
            )
                Main.uiGroup.remove_child(this._taskListMenu.actor);

            if (this._filterMenu) {
                if (this._filterMenu.actor.get_parent() === Main.uiGroup)
                    Main.uiGroup.remove_child(this._filterMenu.actor);
                this._filterMenu.destroy();
                this._filterMenu = null;
            }

            if (this._settingsFilterId) {
                this._settings.disconnect(this._settingsFilterId);
                this._settingsFilterId = 0;
            }

            if (this._completedMenu) {
                if (this._completedMenu.actor.get_parent() === Main.uiGroup)
                    Main.uiGroup.remove_child(this._completedMenu.actor);
                this._completedMenu.destroy();
                this._completedMenu = null;
            }

            if (this._settingsCompletedId) {
                this._settings.disconnect(this._settingsCompletedId);
                this._settingsCompletedId = 0;
            }

            if (this._themeChangedId) {
                St.ThemeContext.get_for_stage(global.stage).disconnect(
                    this._themeChangedId
                );
            }

            if (this._settingsChangedId)
                this._settings.disconnect(this._settingsChangedId);

            if (this._authWatchId)
                this._settings.disconnect(this._authWatchId);

            if (this._settingsTodoistAuthId) {
                this._settings.disconnect(this._settingsTodoistAuthId);
                this._settingsTodoistAuthId = 0;
            }

            if (this._tokenRetryId) {
                GLib.source_remove(this._tokenRetryId);
                this._tokenRetryId = 0;
            }

            this._destroyed = true;

            if (this._cleanUpId) GLib.source_remove(this._cleanUpId);

            if (this._refreshTimeoutId)
                GLib.source_remove(this._refreshTimeoutId);

            if (this._idleAddId) GLib.source_remove(this._idleAddId);

            if (this._onMenuOpenId) DateMenu.disconnect(this._onMenuOpenId);

            if (this._syncEngine) {
                this._syncEngine.destroy();
                this._syncEngine = null;
            }

            if (this._backends) {
                for (const [, backend] of this._backends)
                    backend.destroy();
                this._backends = null;
            }

            if (this._pendingBackends) {
                for (const backend of this._pendingBackends)
                    backend.destroy();
                this._pendingBackends = null;
            }

            Utils.removeDebounceTimeouts_();
        }
    }
);
