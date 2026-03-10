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

import { AuthManager } from './auth.js';
import { SyncEngine } from './sync-engine.js';
import { TaskModel, sortByName, sortByDueDate, sortByPriority } from './task-model.js';

let HAS_GRAPH = false;
try {
    await import('gi://Soup?version=3.0');
    await import('gi://Secret');
    HAS_GRAPH = true;
} catch (e) {}

export default class TaskWidgetExtension extends Extension {
    /**
     * Called when the extension is enabled.
     *
     * https://gjs.guide/extensions/overview/anatomy.html#extension-js-required
     */
    enable() {
        this._widget = new TaskWidget(this.getSettings(), this.metadata);
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

const TaskWidget = GObject.registerClass(
    class TaskWidget extends St.BoxLayout {
        /**
         * Initializes the widget.
         *
         * @param {Gio.Settings} settings - Extension settings object.
         * @param {object} metadata - Extension metadata.
         */
        _init(settings, metadata) {
            super._init({
                name: 'taskWidget',
                // Re-use style classes. We'll do it in multiple places for
                // better compatibility with custom Shell themes.
                style_class:
                    'datemenu-calendar-column task-widget-column message-list',
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

            labeledIconBox.add_child(this._taskIcon);
            labeledIconBox.add_child(this._statusLabel);
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
                    orientation: Clutter.Orientation.VERTICAL
                });

                this._calendarWidget.add_style_class_name(
                    'task-widget-remove-calendar-margin'
                );

                this._contentBox.add_style_class_name(
                    'task-widget-remove-task-box-padding'
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

                // Initialize Graph API sync engine
                this._authManager = new AuthManager();
                await this._authManager.loadTokens();
                this._syncEngine = new SyncEngine(
                    this._authManager, this._settings
                );

                this._syncEngine.connect('tasks-changed', () => {
                    this._onSyncUpdate();
                });
                this._syncEngine.connect('lists-changed', () => {
                    this._storeTaskLists();
                    this._showActiveTaskList(this._activeTaskList || 0);
                });
                this._syncEngine.connect('auth-required', () => {
                    this._showPlaceholderWithStatus('missing-dependencies');
                });

                try {
                    await this._syncEngine.initialize();
                } catch (e) {
                    if (e.message === 'auth-required') {
                        this._showPlaceholderWithStatus('missing-dependencies');
                        return;
                    }
                    throw e;
                }

                this._storeTaskLists(true);
                this._buildHeader();

                this._buildQuickAddEntry();

                this._scrollView = new St.ScrollView({
                    style_class: 'vfade',
                    clip_to_allocation: true
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
            } catch (e) {
                logError(e);
            }
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

            const taskListNameBox = new St.BoxLayout();
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
            this._headerBox.add_child(this._taskListNameButton);
            this._headerBox.add_child(this._forwardButton);
            this._contentBox.add_child(this._headerBox);
        }

        /**
         * Builds a quick-add entry for creating new tasks.
         */
        _buildQuickAddEntry() {
            this._quickAddEntry = new St.Entry({
                style_class: 'quick-add-entry',
                hint_text: _('Add a task…'),
                can_focus: true,
                x_expand: true,
                style: 'margin: 4px 8px; padding: 4px 8px; border-radius: 6px;'
            });

            this._quickAddEntry.clutter_text.connect(
                'activate',
                this._onQuickAddActivate.bind(this)
            );

            this._contentBox.add_child(this._quickAddEntry);
        }

        /**
         * Handles the Enter key press on the quick-add entry.
         * Creates a new VTODO task in the active task list.
         *
         * @async
         */
        async _onQuickAddActivate() {
            try {
                const text = this._quickAddEntry.get_text().trim();

                if (!text) return;

                const taskList = this._taskLists[this._activeTaskList];

                if (!taskList || !this._syncEngine) return;

                await this._syncEngine.createTask(taskList.uid, text);

                this._quickAddEntry.set_text('');

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
                    .map(list => ({uid: list.id, name: list.displayName}));

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

        /**
         * Handles sync engine update events (tasks changed via delta query).
         */
        _onSyncUpdate() {
            try {
                if (this._activeTaskList === null) return;
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
                tasks = [].concat(
                    ...tasks.map((taskList, i) =>
                        taskList.map((task) => {
                            task._taskList = this._taskLists[i].uid;
                            return task;
                        })
                    )
                );
            }

            for (const task of tasks.sort(
                (a, b) =>
                    sortByDueDate(a, b) ||
                    sortByPriority(a, b) ||
                    sortByName(a, b)
            )) {
                if (!task.title) continue;

                task._taskList = task._taskList ? task._taskList : taskListUid;
                this._rootTasks.push(task);

                // Map checklistItems as subtasks
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

            checkbox.child.insert_child_at_index(indicator, 1);
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

            const subTaskSummary = checkbox.child.get_child_at_index(2);
            checkbox.child.remove_child(subTaskSummary);
            box.add_child(this._buildDueDateLabel(due));

            if (this.text_direction === Clutter.TextDirection.RTL)
                subTaskSummary.set_x_align(Clutter.ActorAlign.START);

            box.add_child(subTaskSummary);
            checkbox.child.insert_child_at_index(box, 2);
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

                // Apply category filter
                const categoryFilter = this._getCategoryFilter();
                if (categoryFilter)
                    tasks = tasks.filter(categoryFilter);

                // Apply completed filter
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

            // Date range filter based on selected categories
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
         * Sets placeholder appearance and text.
         *
         * @param {string} status - String to differentiate between various
         * statuses of the placeholder.
         */
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
                        Gio.ThemedIcon.new('dialog-error-symbolic')
                    );

                    this._statusLabel.set_text(
                        _('Error: Missing Dependencies')
                    );
                    this._statusLabel.add_style_class_name('url-highlighter');

                    this._statusLabel.connect('style-changed', () => {
                        const [hasColor, color] = this._statusLabel
                            .get_theme_node()
                            .lookup_color('link-color', false);

                        this._statusLabel.set_style(`color: ${
                            hasColor
                                ? color.to_string().substr(0, 7)
                                : '#629fea'
                        };
                        text-decoration: underline`);
                    });

                    this._statusLabel.connect('motion-event', () => {
                        global.display.set_cursor(Meta.Cursor.POINTING_HAND);
                        return Clutter.EVENT_PROPAGATE;
                    });

                    this._statusLabel.connect('leave-event', () => {
                        global.display.set_cursor(Meta.Cursor.DEFAULT);
                        return Clutter.EVENT_PROPAGATE;
                    });

                    this._statusLabel.connect('button-release-event', () => {
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

                // Trigger immediate sync and fast polling while menu is open
                if (this._syncEngine) {
                    this._syncEngine.sync().catch(e =>
                        logError(e, 'sync on menu open'));
                    this._syncEngine.startPolling(30);
                }

                const hct = this._settings.get_int('hide-completed-tasks');

                if (Utils.HIDE_COMPLETED_TASKS_IS_TIME_DEPENDENT_(hct)) {
                    this._refreshTimeoutId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT,
                        2,
                        () => {
                            if (!this._idleAddId)
                                this._showActiveTaskList(this._activeTaskList);

                            if (i++ < 60 && this._activeTaskList !== null)
                                return GLib.SOURCE_CONTINUE;
                            else this._onMenuOpen(null, false);
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
                    'task-widget-remove-calendar-margin'
                )
            ) {
                this._calendarWidget.remove_style_class_name(
                    'task-widget-remove-calendar-margin'
                );
            }

            if (
                this._taskListMenu &&
                this._taskListMenu.actor.get_parent() === Main.uiGroup
            )
                Main.uiGroup.remove_child(this._taskListMenu.actor);

            if (this._themeChangedId) {
                St.ThemeContext.get_for_stage(global.stage).disconnect(
                    this._themeChangedId
                );
            }

            if (this._settingsChangedId)
                this._settings.disconnect(this._settingsChangedId);

            if (this._cleanUpId) GLib.source_remove(this._cleanUpId);

            if (this._refreshTimeoutId)
                GLib.source_remove(this._refreshTimeoutId);

            if (this._idleAddId) GLib.source_remove(this._idleAddId);

            if (this._onMenuOpenId) DateMenu.disconnect(this._onMenuOpenId);

            if (this._syncEngine) {
                this._syncEngine.destroy();
                this._syncEngine = null;
            }

            if (this._authManager) {
                this._authManager.destroy();
                this._authManager = null;
            }

            Utils.removeDebounceTimeouts_();
        }
    }
);
