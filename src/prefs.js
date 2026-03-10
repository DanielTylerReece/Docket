'use strict';

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import * as Config from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';
import * as Utils from './utils.js';
import system from 'system';

import {
    ExtensionPreferences,
    ngettext,
    pgettext,
    gettext as _
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

let HAS_GRAPH = true;
let AuthManager, GraphApi;

try {
    ({ AuthManager } = await import('./auth.js'));
    ({ GraphApi } = await import('./graph-api.js'));
} catch (e) {
    HAS_GRAPH = false;
}

/**
 * Enables the use of context in translation of plurals.
 *
 * @param {string} context - Context for the translation.
 * @param {string} singular - Singular of the translatable string.
 * @param {string} plural - Plural of the translatable string.
 * @param {number} n - Number to apply the plural formula to.
 *
 * @returns {string} Translated string.
 */
const _npgettext = (context, singular, plural, n) => {
    return n !== 1
        ? ngettext(`${context}\u0004${singular}`, plural, n)
        : pgettext(context, singular);
};

let _resource = null;

/**
 * (Re)loads UI as a resource file.
 */
const _loadResource = () => {
    if (_resource) return;

    _resource = Gio.Resource.load(
        import.meta.url.slice(7, -8) +
            'org.gnome.shell.extensions.docket.gresource'
    );

    Gio.resources_register(_resource);
};

_loadResource();

export default class DocketExtensionPreferences extends ExtensionPreferences {
    /**
     * Displays the preferences window if Microsoft Graph API dependencies
     * (Soup3, libsecret) are installed. Otherwise, an instance of
     * `BeGoneWidget` is shown.
     *
     * @param {Adw.PreferencesWindow} window - The preferences window.
     */
    fillPreferencesWindow(window) {
        _loadResource();

        const widget = HAS_GRAPH
            ? new DocketSettings(this.getSettings(), this.metadata)
            : new BeGoneWidget(this.metadata);

        window.add(widget);
    }
}

const BeGoneWidget = GObject.registerClass(
    class BeGoneWidget extends Adw.PreferencesPage {
        /**
         * Shows a message dialog if required dependencies are not installed on
         * the system.
         *
         * @param {object} metadata - Extension metadata.
         */
        _init(metadata) {
            super._init();

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this.get_root().close();

                const dialog = new Gtk.MessageDialog({
                    buttons: Gtk.ButtonsType.CLOSE,
                    text: _('Error: Missing Dependencies'),
                    secondary_text: _(
                        'Please install libsoup3 and libsecret' +
                            ' to use this extension.'
                    )
                });

                dialog.add_button(_('Help'), 0);
                dialog.set_name('docket-error');
                dialog.present();

                dialog.connect('response', (widget, responseId) => {
                    if (responseId === 0) {
                        Gio.AppInfo.launch_default_for_uri_async(
                            metadata.dependencies,
                            null,
                            null,
                            null
                        );
                    }

                    widget.destroy();
                });

                Gio.resources_unregister(_resource);
                _resource = null;

                return GLib.SOURCE_REMOVE;
            });
        }
    }
);

const DocketSettings = GObject.registerClass(
    {
        GTypeName: 'DocketSettings',
        Template:
            'resource:///org/gnome/shell/extensions/docket/settings-window.ui',
        InternalChildren: [
            'mtlSwitch',
            'gptSwitch',
            'hhfstlSwitch',
            'heactlSwitch',
            'socRow',
            'socSwitch',
            'taskCategoryPast',
            'taskCategoryToday',
            'taskCategoryTomorrow',
            'taskCategoryNextSevenDays',
            'taskCategoryScheduled',
            'taskCategoryUnscheduled',
            'taskCategoryNotCancelled',
            'taskCategoryStarted',
            'hctRow',
            'hctComboBox',
            'hctSettingsStack',
            'hctApotacComboBox',
            'hctApotacSpinButton',
            'hctAstodSpinButtonHour',
            'hctAstodSpinButtonMinute',
            'backendRefreshButton',
            'backendRefreshButtonSpinner',
            'taskListBox'
        ]
    },
    class DocketSettings extends Adw.PreferencesPage {
        /**
         * Initializes the settings widget.
         *
         * @param {Gio.Settings} settings - Settings object.
         * @param {object} metadata - Extension metadata.
         */
        _init(settings, metadata) {
            super._init();
            this._settings = settings;
            this._metadata = metadata;
            this._authManager = null;
            this._api = null;
            this._authGroup = null;
            const provider = new Gtk.CssProvider();
            provider.load_from_resource(`${this._metadata.epath}/prefs.css`);

            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(),
                provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );

            [this._socRow, this._hctRow].forEach((row) =>
                this._findChildWidget(
                    'styleClass',
                    row,
                    'expander-row-arrow'
                ).hide()
            );

            this._hctComboBox.connect('changed', (option) => {
                const expanded = option.active > 1;
                this._hctRow.set_enable_expansion(expanded);
                this._hctRow.set_expanded(expanded);

                switch (option.active) {
                    case Utils.HIDE_COMPLETED_TASKS_['after-time-period']: {
                        this._hctSettingsStack.set_visible_child_name(
                            'hctApotacPage'
                        );

                        break;
                    }

                    case Utils.HIDE_COMPLETED_TASKS_['after-specified-time']: {
                        this._hctSettingsStack.set_visible_child_name(
                            'hctAstodPage'
                        );
                    }
                }
            });

            [
                ['merge-task-lists', this._mtlSwitch],
                ['group-past-tasks', this._gptSwitch],
                ['hide-header-for-singular-task-lists', this._hhfstlSwitch],
                ['hide-empty-completed-task-lists', this._heactlSwitch],
                ['hide-completed-tasks', this._hctComboBox],
                ['show-only-selected-categories', this._socSwitch],
                ['hct-apotac-value', this._hctApotacSpinButton, 'value'],
                ['hct-apotac-unit', this._hctApotacComboBox],
                ['hct-astod-hour', this._hctAstodSpinButtonHour, 'value'],
                ['hct-astod-minute', this._hctAstodSpinButtonMinute, 'value']
            ].forEach(
                ([
                    key,
                    object,
                    property = 'active',
                    flags = Gio.SettingsBindFlags.DEFAULT
                ]) => this._settings.bind(key, object, property, flags)
            );

            const selected = this._settings.get_strv(
                'selected-task-categories'
            );

            [
                this._taskCategoryPast,
                this._taskCategoryToday,
                this._taskCategoryTomorrow,
                this._taskCategoryNextSevenDays,
                this._taskCategoryScheduled,
                this._taskCategoryUnscheduled,
                this._taskCategoryNotCancelled,
                this._taskCategoryStarted
            ].forEach((category) =>
                category.set_active(selected.includes(category.name))
            );

            [
                [this._taskCategoryPast, this._taskCategoryScheduled],
                [this._taskCategoryToday, this._taskCategoryNextSevenDays],
                [this._taskCategoryToday, this._taskCategoryScheduled],
                [this._taskCategoryTomorrow, this._taskCategoryNextSevenDays],
                [this._taskCategoryTomorrow, this._taskCategoryScheduled],
                [this._taskCategoryScheduled, this._taskCategoryUnscheduled],
                [this._taskCategoryNextSevenDays, this._taskCategoryScheduled]
            ].forEach(([source, target]) =>
                source.bind_property_full(
                    'active',
                    target,
                    'active',
                    GObject.BindingFlags.BIDIRECTIONAL,
                    (value) => {
                        if (value.source.active) {
                            value.target.set_active(false);
                            return [true];
                        }

                        return [false];
                    },

                    (value) => {
                        if (value.target.active) {
                            value.source.set_active(false);
                            return [true];
                        }

                        return [false];
                    }
                )
            );

            this._initAuth();
        }

        /**
         * Recursively traverses the widget tree below the given parent and
         * returns the first widget whose given property matches the given
         * value.
         *
         * @param {string} property - Look for a child with this property.
         * @param {*} parent - Parent of the child to be searched.
         * @param {*} value - Value of the given property.
         *
         * @returns {*|null} Child that meets the criteria or `null`.
         */
        _findChildWidget(property, parent, value) {
            let match;

            for (const child of [...parent]) {
                switch (property) {
                    case 'type': {
                        if (child instanceof value) return child;

                        break;
                    }

                    case 'styleClass': {
                        if (child.get_css_classes().includes(value))
                            return child;
                    }
                }

                match = this._findChildWidget(property, child, value);

                if (match) return match;
            }

            return null;
        }

        /**
         * Handles click events for task category checkbuttons.
         *
         * @param {Gtk.CheckButton} button - Corresponding checkbutton.
         */
        _toggleTaskCategory(button) {
            const selection = this._settings.get_strv(
                'selected-task-categories'
            );

            if (!button.active)
                selection.splice(selection.indexOf(button.name), 1);
            else if (!selection.includes(button.name))
                selection.push(button.name);

            this._settings.set_strv('selected-task-categories', selection);
        }

        /**
         * Fills "After a period of time after completion" Gtk.ComboBox with
         * time units.
         *
         * @param {Gtk.SpinButton} button - Corresponding `Gtk.SpinButton` that
         * sets time units.
         */
        _fillApotacComboBox(button) {
            const active = this._hctApotacComboBox.active_id;
            const duration = button.get_value();

            const time = new Map([
                [
                    Utils.TIME_UNITS_['seconds'],
                    _npgettext(
                        'after X second(s)',
                        'second',
                        'seconds',
                        duration
                    )
                ],
                [
                    Utils.TIME_UNITS_['minutes'],
                    _npgettext(
                        'after X minute(s)',
                        'minute',
                        'minutes',
                        duration
                    )
                ],
                [
                    Utils.TIME_UNITS_['hours'],
                    _npgettext('after X hour(s)', 'hour', 'hours', duration)
                ],
                [
                    Utils.TIME_UNITS_['days'],
                    _npgettext('after X day(s)', 'day', 'days', duration)
                ]
            ]);

            this._hctApotacComboBox.remove_all();

            time.forEach((label, i) =>
                this._hctApotacComboBox.append(`${i}`, label)
            );

            if (active !== null) this._hctApotacComboBox.set_active_id(active);
        }

        /**
         * Initializes authentication and loads task lists if authenticated.
         *
         * @async
         */
        async _initAuth() {
            try {
                this._authManager = new AuthManager();
                await this._authManager.loadTokens();
                this._api = new GraphApi(this._authManager);
                this._buildAuthSection();

                if (this._authManager.isAuthenticated())
                    await this._loadTaskLists();
            } catch (e) {
                console.error(`[prefs] Init error: ${e.message}`);
                if (!this._authGroup)
                    this._buildAuthSection();
            }
        }

        /**
         * Builds the Microsoft Account auth section.
         */
        _buildAuthSection() {
            const authGroup = new Adw.PreferencesGroup({
                title: _('Microsoft Account'),
            });

            if (this._authManager && this._authManager.isAuthenticated()) {
                const statusRow = new Adw.ActionRow({
                    title: _('Signed in'),
                    subtitle: _('Connected to Microsoft To Do'),
                });

                const signOutBtn = new Gtk.Button({
                    label: _('Sign Out'),
                    valign: Gtk.Align.CENTER,
                });
                signOutBtn.add_css_class('destructive-action');
                signOutBtn.connect('clicked', () => this._onSignOut());
                statusRow.add_suffix(signOutBtn);
                authGroup.add(statusRow);
            } else {
                const signInRow = new Adw.ActionRow({
                    title: _('Not signed in'),
                    subtitle: _('Sign in to sync with Microsoft To Do'),
                });

                const signInBtn = new Gtk.Button({
                    label: _('Sign In'),
                    valign: Gtk.Align.CENTER,
                });
                signInBtn.add_css_class('suggested-action');
                signInBtn.connect('clicked', () => this._onSignIn());
                signInRow.add_suffix(signInBtn);
                authGroup.add(signInRow);
            }

            this._authGroup = authGroup;
            this.add(authGroup);
        }

        /**
         * Handles the sign-in flow using device code grant.
         *
         * @async
         */
        async _onSignIn() {
            try {
                const flow = await this._authManager.startDeviceCodeFlow();

                // Copy code to clipboard and open browser
                const clipboard = Gdk.Display.get_default().get_clipboard();
                clipboard.set(flow.userCode);

                Gio.AppInfo.launch_default_for_uri_async(
                    flow.verificationUri, null, null, null
                );

                // Update auth section to show waiting state
                this.remove(this._authGroup);

                const authGroup = new Adw.PreferencesGroup({
                    title: _('Microsoft Account'),
                });
                const waitRow = new Adw.ActionRow({
                    title: _('Waiting for approval') + Utils.ELLIPSIS_CHAR_,
                    subtitle: `${_('Code:')} ${flow.userCode} \u2014 ${_('copied to clipboard')}`,
                });

                const cancelBtn = new Gtk.Button({
                    label: _('Cancel'),
                    valign: Gtk.Align.CENTER,
                });
                cancelBtn.add_css_class('destructive-action');
                cancelBtn.connect('clicked', () => {
                    this._authManager.destroy();
                    this._authManager = new AuthManager();
                    this._api = new GraphApi(this._authManager);
                    this.remove(authGroup);
                    this._buildAuthSection();
                });
                waitRow.add_suffix(cancelBtn);
                authGroup.add(waitRow);
                this._authGroup = authGroup;
                this.add(authGroup);

                // Wait for poll completion
                await flow.pollPromise;

                // Success — notify extension and rebuild UI
                this._settings.set_string('auth-event', `sign-in:${Date.now()}`);
                this.remove(this._authGroup);
                this._buildAuthSection();
                await this._loadTaskLists();
            } catch (e) {
                if (e.message === 'destroyed') return;
                console.error(`[prefs] Sign in error: ${e.message}`);
                if (this._authGroup) {
                    this.remove(this._authGroup);
                    this._authGroup = null;
                }
                this._buildAuthSection();
            }
        }

        /**
         * Handles sign-out: clears tokens and resets the UI.
         *
         * @async
         */
        async _onSignOut() {
            try {
                await this._authManager.clearTokens();
                this._settings.set_string('auth-event', `sign-out:${Date.now()}`);

                // Clear task list rows
                let row = this._taskListBox.get_row_at_index(0);
                while (row) {
                    this._taskListBox.remove(row);
                    row = this._taskListBox.get_row_at_index(0);
                }

                // Rebuild auth section
                this.remove(this._authGroup);
                this._authGroup = null;
                this._buildAuthSection();

                // Disable refresh button
                this._backendRefreshButton.set_sensitive(false);
                this._backendRefreshButton.set_tooltip_text(
                    _('Sign in to view task lists')
                );
            } catch (e) {
                console.error(`[prefs] Sign out error: ${e.message}`);
            }
        }

        /**
         * Fetches task lists from Microsoft Graph API and populates the UI.
         *
         * @async
         */
        async _loadTaskLists() {
            try {
                const lists = await this._api.listTaskLists();
                const customOrder = this._settings.get_strv('task-list-order');

                if (customOrder.length) {
                    lists.sort((a, b) => {
                        const ia = customOrder.indexOf(a.id);
                        const ib = customOrder.indexOf(b.id);
                        if (ia === -1 && ib === -1) return 0;
                        if (ia === -1) return 1;
                        if (ib === -1) return -1;
                        return ia - ib;
                    });
                }

                // Clear existing rows
                let row = this._taskListBox.get_row_at_index(0);
                while (row) {
                    this._taskListBox.remove(row);
                    row = this._taskListBox.get_row_at_index(0);
                }

                // Add rows
                for (const list of lists) {
                    const taskListRow = new TaskListRow(list, this);
                    this._taskListBox.append(taskListRow);
                }

                // Configure refresh button
                this._backendRefreshButton.set_sensitive(true);
                this._backendRefreshButton.set_tooltip_text(
                    _('Reload task lists')
                );

                const menu = Gio.Menu.new();
                menu.append(_('Reload Task Lists'), 'refresh.reload');
                const actionGroup = new Gio.SimpleActionGroup();
                const action = new Gio.SimpleAction({ name: 'reload' });
                action.connect('activate', () => this._onReloadLists());
                actionGroup.add_action(action);
                this._backendRefreshButton.set_menu_model(menu);
                this._backendRefreshButton.insert_action_group(
                    'refresh',
                    actionGroup
                );
            } catch (e) {
                console.error(`[prefs] Load task lists error: ${e.message}`);

                if (e.message === 'auth-required') {
                    this.remove(this._authGroup);
                    this._authGroup = null;
                    this._buildAuthSection();
                }

                this._backendRefreshButton.set_sensitive(false);
                this._backendRefreshButton.set_tooltip_text(
                    _('Could not load task lists')
                );
            }
        }

        /**
         * Reloads the task list from Graph API.
         *
         * @async
         */
        async _onReloadLists() {
            try {
                this._backendRefreshButton.set_visible(false);
                this._backendRefreshButtonSpinner.set_visible(true);
                this._backendRefreshButtonSpinner.set_tooltip_text(
                    _('Reloading') + Utils.ELLIPSIS_CHAR_
                );

                await this._loadTaskLists();

                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    this._backendRefreshButton.set_visible(true);
                    this._backendRefreshButtonSpinner.set_visible(false);
                    return GLib.SOURCE_REMOVE;
                });
            } catch (e) {
                console.error(`[prefs] Reload error: ${e.message}`);
                this._backendRefreshButton.set_visible(true);
                this._backendRefreshButtonSpinner.set_visible(false);
            }
        }

        /**
         * Pads values of Gtk.SpinButton with zeros so that they always contain
         * two digits.
         *
         * @param {Gtk.SpinButton} button - Widget involved in the operation.
         *
         * @returns {boolean} `true` to display the formatted value.
         */
        _timeOutput(button) {
            button.set_text(button.adjustment.value.toString().padStart(2, 0));
            return true;
        }

        /**
         * Disconnects signal handlers and unregisters resources when settings
         * window gets destroyed.
         */
        _onUnrealized() {
            if (this._authManager)
                this._authManager.destroy();

            if (this._api)
                this._api.destroy();

            Gio.resources_unregister(_resource);
            _resource = null;
        }

        /**
         * Adds custom buttons to the header bar as soon as the widget gets
         * realized.
         *
         * @param {DocketSettings} widget - Widget that has been realized.
         */
        _onRealized(widget) {
            this._window = widget.get_root();

            const headerBar = this._findChildWidget(
                'type',
                this._window,
                Adw.HeaderBar
            );

            headerBar.pack_end(new SettingsMenuButton(this));
        }
    }
);

const TaskListRow = GObject.registerClass(
    {
        GTypeName: 'TaskListRow',
        Template:
            'resource:///org/gnome/shell/extensions/docket/task-list-row.ui',
        InternalChildren: [
            'taskListProvider',
            'taskListSwitch',
            'taskListOptionsButton',
            'taskListOptionsSpinner'
        ]
    },
    class TaskListRow extends Adw.ActionRow {
        /**
         * Initializes a task list row.
         *
         * @param {object} list - Task list object with {id, displayName}.
         * @param {DocketSettings} widget - Reference to the main widget
         * class.
         */
        _init(list, widget) {
            super._init();
            this._settings = widget._settings;
            this._uid = list.id;
            this.set_title(list.displayName);

            this._taskListProvider.set_text('Microsoft To Do');

            this._taskListSwitch.active =
                this._settings
                    .get_strv('disabled-task-lists')
                    .indexOf(this._uid) === -1;

            let action;
            const actionGroup = new Gio.SimpleActionGroup();
            action = new Gio.SimpleAction({ name: 'up' });
            action.connect('activate', () => this._moveRow(true));
            actionGroup.add_action(action);
            action = new Gio.SimpleAction({ name: 'down' });
            action.connect('activate', () => this._moveRow(false));
            actionGroup.add_action(action);

            this._taskListOptionsButton.insert_action_group(
                'options-menu',
                actionGroup
            );
        }

        /**
         * Handles motion events.
         *
         * @param {Gtk.EventControllerMotion} controller - Event controller.
         * @param {number} x - The X coordinate.
         */
        _onMotionEvent(controller, x) {
            let cursor;

            const reactive =
                controller.widget instanceof Gtk.Switch ||
                controller.widget instanceof Gtk.MenuButton;

            if (x !== undefined) cursor = reactive ? 'default' : 'grab';
            else cursor = reactive ? 'grab' : 'default';

            this.get_root().set_cursor(Gdk.Cursor.new_from_name(cursor, null));
        }

        /**
         * Ensures that changes in task list order are saved in settings.
         */
        _updateTaskListOrder() {
            let i = 0;
            const uids = [];
            const taskListBox = this.get_parent();
            let row = taskListBox.get_row_at_index(i);

            while (row) {
                uids.push(row._uid);
                row = taskListBox.get_row_at_index(i++);
            }

            this._settings.set_strv('task-list-order', uids);
        }

        /**
         * Moves the row up or down in the list of task lists.
         *
         * @param {boolean} up - Move the row upwards.
         */
        _moveRow(up) {
            let index = this.get_index();
            const taskListBox = this.get_parent();
            taskListBox.remove(this);

            if (up) --index;
            else if (taskListBox.get_row_at_index(index)) ++index;
            else index = 0;

            taskListBox.insert(this, index);
            this._updateTaskListOrder();
        }

        /**
         * Prepares drag and drop operations.
         *
         * @param {Gtk.DragSource} source - `Gtk.DragSource` of the drag and
         * drop operation.
         *
         * @returns {Gdk.ContentProvider} Type of content to provide in drag and
         * drop operations.
         */
        _dragPrepare(source) {
            this.get_style_context().add_class('drag-icon');
            source.set_icon(Gtk.WidgetPaintable.new(this), 0, 0);
            return Gdk.ContentProvider.new_for_value(this);
        }

        /**
         * Handles the `drop` part of a drag and drop operation.
         *
         * @param {Gtk.DropTarget} target - `Gtk.DropTarget` of the drag and
         * drop operation.
         */
        _dragDrop(target) {
            const taskListBox = this.get_parent();
            const dropIndex = this.get_index();
            const dragRow = target.value;

            if (dropIndex === dragRow.get_index()) return false;

            taskListBox.remove(dragRow);
            taskListBox.insert(dragRow, dropIndex);
            this._updateTaskListOrder();
            return true;
        }

        /**
         * Finalizes the drag and drop operation.
         */
        _dragEnd() {
            this.get_style_context().remove_class('drag-icon');
        }

        /**
         * Adds or removes the task list from the list of disabled task lists.
         *
         * @param {Gtk.Switch} widget - Switch whose state is handled.
         */
        _setTaskListState(widget) {
            const disabled = this._settings.get_strv('disabled-task-lists');

            if (widget.active) {
                const index = disabled.indexOf(this._uid);

                if (index !== -1) disabled.splice(index, 1);
            } else {
                disabled.push(this._uid);
            }

            this._settings.set_strv('disabled-task-lists', disabled);
        }
    }
);

const SettingsMenuButton = GObject.registerClass(
    {
        GTypeName: 'SettingsMenuButton',
        Template:
            'resource:///org/gnome/shell/extensions/docket/settings-menu.ui',
        InternalChildren: ['aboutDialog', 'supportLogDialog']
    },
    class SettingsMenuButton extends Gtk.MenuButton {
        /**
         * Initializes the settings menu.
         *
         * @param {DocketSettings} widget - Reference to the main widget
         * class.
         */
        _init(widget) {
            super._init();
            const { modal } = widget._window;
            this._metadata = widget._metadata;
            this._aboutDialog.transient_for = widget._window;
            this._aboutDialog.program_name = _(this._metadata.name);
            this._aboutDialog.version = this._metadata.version.toString();
            this._aboutDialog.website = this._metadata.url;
            this._aboutDialog.comments = _(this._metadata.description);

            this._aboutDialog.translator_credits =
                /* Translators: put down your name/nickname and email (optional)
            according to the format below. This will credit you in the "About"
            window of the extension settings. */
                pgettext('translator name <email>', 'translator-credits');

            const actionGroup = new Gio.SimpleActionGroup();
            let action = new Gio.SimpleAction({ name: 'log' });

            action.connect('activate', () => {
                this._supportLogDialog._time =
                    GLib.DateTime.new_now_local().format('%F %T');

                if (modal) widget._window.set_modal(false);

                this._supportLogDialog.present();
                this.set_sensitive(false);
            });

            actionGroup.add_action(action);
            action = new Gio.SimpleAction({ name: 'wiki' });

            action.connect('activate', () => {
                Gio.AppInfo.launch_default_for_uri_async(
                    this._metadata.wiki,
                    null,
                    null,
                    null
                );
            });

            actionGroup.add_action(action);
            action = new Gio.SimpleAction({ name: 'about' });
            action.connect('activate', () => this._aboutDialog.present());
            actionGroup.add_action(action);
            this.insert_action_group('settings-menu', actionGroup);

            this._supportLogDialog.connect('response', (dialog, response) => {
                if (response === Gtk.ResponseType.OK)
                    this._generateSupportLog(dialog._time);

                if (modal) widget._window.set_modal(true);

                this.set_sensitive(true);
                dialog._time = null;
                dialog.hide();
            });
        }

        /**
         * Generates the support log. User is notified to remove or censor any
         * information he/she considers to be private.
         *
         * @async
         * @author Andy Holmes <andrew.g.r.holmes@gmail.com> (the original code
         * was extended to include more data).
         * @param {GLib.DateTime} time - Restricts log entries displayed to
         * those after this time.
         */
        async _generateSupportLog(time) {
            try {
                const gschema = (id) =>
                    new Gio.Settings({
                        settings_schema:
                            Gio.SettingsSchemaSource.get_default().lookup(
                                id,
                                true
                            )
                    });

                const [file, stream] = Gio.File.new_tmp('docket.XXXXXX');
                const logFile = stream.get_output_stream();
                const widgetName = `${this._metadata.name} v${this._metadata.version}`;

                const iconTheme = gschema(
                    'org.gnome.desktop.interface'
                ).get_string('icon-theme');

                const gtkTheme = gschema(
                    'org.gnome.desktop.interface'
                ).get_string('gtk-theme');

                let shellTheme;

                try {
                    shellTheme = gschema(
                        'org.gnome.shell.extensions.user-theme'
                    ).get_string('name');

                    if (!shellTheme) throw new Error();
                } catch (e) {
                    shellTheme = 'Default / Unknown';
                }

                const monitors = Gdk.Display.get_default().get_monitors();
                const total = monitors.get_n_items();
                let display = '';

                for (let i = 0; i < total; i++) {
                    const item = monitors.get_item(i);

                    display +=
                        item.geometry.width * item.scale_factor +
                        'x' +
                        item.geometry.height * item.scale_factor +
                        '@' +
                        item.scale_factor +
                        'x';

                    if (i !== total - 1) display += ', ';
                }

                const logHeader =
                    widgetName +
                    '\n' +
                    GLib.get_os_info('PRETTY_NAME') +
                    '\n' +
                    'GNOME Shell ' +
                    Config.PACKAGE_VERSION +
                    '\n' +
                    'gjs ' +
                    system.version +
                    '\n' +
                    (Adw ? 'Libadwaita ' + Adw.VERSION_S + '\n' : '') +
                    'Language: ' +
                    GLib.getenv('LANG') +
                    '\n' +
                    'XDG Session Type: ' +
                    GLib.getenv('XDG_SESSION_TYPE') +
                    '\n' +
                    'GDM Session Type: ' +
                    GLib.getenv('GDMSESSION') +
                    '\n' +
                    'Shell Theme: ' +
                    shellTheme +
                    '\n' +
                    'Icon Theme: ' +
                    iconTheme +
                    '\n' +
                    'GTK Theme: ' +
                    gtkTheme +
                    '\n' +
                    'Display: ' +
                    display +
                    '\n\n';

                await Utils.writeBytesAsync_(
                    logFile,
                    new GLib.Bytes(logHeader),
                    0,
                    null
                );

                const process = new Gio.Subprocess({
                    flags:
                        Gio.SubprocessFlags.STDOUT_PIPE |
                        Gio.SubprocessFlags.STDERR_MERGE,
                    argv: ['journalctl', '--no-host', '--since', time]
                });

                process.init(null);

                logFile.splice_async(
                    process.get_stdout_pipe(),
                    Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (source, result) => {
                        try {
                            source.splice_finish(result);
                        } catch (e) {
                            logError(e);
                        }
                    }
                );

                await Utils.waitCheckAsync_(process, null);

                Gio.AppInfo.launch_default_for_uri_async(
                    file.get_uri(),
                    null,
                    null,
                    null
                );
            } catch (e) {
                logError(e);
            }
        }
    }
);
