'use strict';

/**
 * Data model for task objects.
 * Converts between backend JSON (Graph API, Todoist) and the internal model
 * used by the extension UI.
 */
export class TaskModel {
    /**
     * Convert a Graph API task JSON object to the internal model.
     * @param {object} g - Graph task JSON
     * @param {string} listId - Parent task list ID
     * @returns {object} Internal task model
     */
    static fromGraphJson(g, listId) {
        return {
            id: g.id,
            listId,
            title: g.title || '',
            status: g.status || 'notStarted',
            importance: g.importance || 'normal',
            dueDateTime: g.dueDateTime
                ? new Date(g.dueDateTime.dateTime + 'Z')
                : null,
            completedDateTime: g.completedDateTime
                ? new Date(g.completedDateTime.dateTime + 'Z')
                : null,
            createdDateTime: g.createdDateTime
                ? new Date(g.createdDateTime)
                : new Date(),
            lastModifiedDateTime: g.lastModifiedDateTime
                ? new Date(g.lastModifiedDateTime)
                : new Date(),
            body: g.body ? g.body.content || '' : '',
            categories: g.categories || [],
            checklistItems: (g.checklistItems || []).map(ci => ({
                id: ci.id,
                displayName: ci.displayName || '',
                isChecked: ci.isChecked || false,
                checkedDateTime: ci.checkedDateTime
                    ? new Date(ci.checkedDateTime)
                    : null,
            })),

            // Aliases used by UI code
            get _uid() { return this.id; },
            get _due() { return this.dueDateTime; },
            get _taskList() { return this.listId; },
        };
    }

    /**
     * Convert a Todoist REST API task JSON object to the internal model.
     *
     * Priority mapping (Todoist values are inverted from display):
     *   4 = p1 (urgent/red)  → 'high'
     *   3 = p2 (orange)      → 'high'
     *   2 = p3 (yellow)      → 'normal'
     *   1 = p4 (default)     → 'low'
     *
     * @param {object} item - Todoist task JSON from REST API v1
     * @param {string} [projectId] - Override project_id (e.g. from list context)
     * @returns {object} Internal task model
     */
    static fromTodoistJson(item, projectId) {
        const task = {
            id: String(item.id),
            listId: projectId || String(item.project_id),
            title: item.content,
            status: (item.checked || item.is_completed) ? 'completed' : 'notStarted',
            importance: item.priority >= 3 ? 'high' : (item.priority === 2 ? 'normal' : 'low'),
            dueDateTime: null,
            completedDateTime: item.completed_at ? new Date(item.completed_at) : null,
            createdDateTime: (item.added_at || item.created_at) ? new Date(item.added_at || item.created_at) : null,
            lastModifiedDateTime: null,
            body: item.description ? {content: item.description, contentType: 'text'} : null,
            categories: item.labels || [],
            checklistItems: [],  // Todoist uses subtasks instead
            _parentTaskId: item.parent_id ? String(item.parent_id) : null,
            _order: item.child_order ?? item.order,
            _isRecurring: item.due?.is_recurring || false,
            _sectionId: item.section_id ? String(item.section_id) : null,
        };

        // Due date — prefer datetime over date-only
        if (item.due) {
            if (item.due.datetime)
                task.dueDateTime = new Date(item.due.datetime);
            else if (item.due.date)
                task.dueDateTime = new Date(item.due.date + 'T00:00:00Z');
        }

        // Getter aliases (match fromGraphJson pattern exactly)
        Object.defineProperties(task, {
            '_uid':      { get() { return this.id; } },
            '_due':      { get() { return this.dueDateTime; } },
            '_taskList': { get() { return this.listId; } },
        });

        return task;
    }

    /**
     * Build a Graph API POST body for creating a new task.
     * @param {string} title - Task title
     * @param {object} [opts] - Optional fields
     * @param {string} [opts.importance] - 'low'|'normal'|'high'
     * @param {Date} [opts.dueDateTime] - Due date
     * @param {string} [opts.body] - Task body/notes
     * @param {string[]} [opts.categories] - Category list
     * @returns {object} Graph API task creation payload
     */
    static toCreatePayload(title, opts = {}) {
        const payload = {title};

        if (opts.importance)
            payload.importance = opts.importance;

        if (opts.dueDateTime) {
            payload.dueDateTime = {
                dateTime: opts.dueDateTime.toISOString().replace('Z', ''),
                timeZone: 'UTC',
            };
        }

        if (opts.body) {
            payload.body = {
                content: opts.body,
                contentType: 'text',
            };
        }

        if (opts.categories)
            payload.categories = opts.categories;

        return payload;
    }

    /**
     * Build a Graph API PATCH body for updating a task.
     * @param {object} changes - Fields to update (same keys as internal model)
     * @returns {object} Graph API task update payload
     */
    static toUpdatePayload(changes) {
        const payload = {};

        if ('title' in changes)
            payload.title = changes.title;

        if ('status' in changes)
            payload.status = changes.status;

        if ('importance' in changes)
            payload.importance = changes.importance;

        if ('dueDateTime' in changes) {
            payload.dueDateTime = changes.dueDateTime
                ? {
                    dateTime: changes.dueDateTime.toISOString().replace('Z', ''),
                    timeZone: 'UTC',
                }
                : null;
        }

        if ('body' in changes) {
            payload.body = {
                content: changes.body,
                contentType: 'text',
            };
        }

        if ('categories' in changes)
            payload.categories = changes.categories;

        return payload;
    }

    /**
     * Serialize a task object for JSON storage (offline cache).
     * Converts Date objects to ISO strings and preserves all data fields.
     * Getter aliases (_uid, _due, _taskList) are non-enumerable and won't
     * appear in JSON.stringify, but we explicitly exclude them for clarity.
     * @param {object} task - Internal task model object
     * @returns {object} Plain object suitable for JSON.stringify
     */
    static serialize(task) {
        return {
            id: task.id,
            listId: task.listId,
            title: task.title,
            status: task.status,
            importance: task.importance,
            dueDateTime: task.dueDateTime?.toISOString() || null,
            completedDateTime: task.completedDateTime?.toISOString() || null,
            createdDateTime: task.createdDateTime?.toISOString() || null,
            lastModifiedDateTime: task.lastModifiedDateTime?.toISOString() || null,
            body: task.body,
            categories: task.categories || [],
            checklistItems: (task.checklistItems || []).map(ci => ({
                id: ci.id,
                displayName: ci.displayName,
                isChecked: ci.isChecked,
                checkedDateTime: ci.checkedDateTime instanceof Date
                    ? ci.checkedDateTime.toISOString()
                    : ci.checkedDateTime || null,
            })),
            // Todoist-specific fields (null for Graph tasks — that's fine)
            _parentTaskId: task._parentTaskId || null,
            _order: task._order ?? null,
            _isRecurring: task._isRecurring || false,
            _sectionId: task._sectionId || null,
        };
    }

    /**
     * Restore a task from JSON storage (offline cache).
     * Converts ISO strings back to Date objects and re-attaches
     * getter aliases (_uid, _due, _taskList) via Object.defineProperties.
     * @param {object} obj - Plain object from JSON.parse
     * @returns {object} Internal task model object
     */
    static deserialize(obj) {
        const task = {
            id: obj.id,
            listId: obj.listId,
            title: obj.title,
            status: obj.status,
            importance: obj.importance,
            dueDateTime: obj.dueDateTime ? new Date(obj.dueDateTime) : null,
            completedDateTime: obj.completedDateTime ? new Date(obj.completedDateTime) : null,
            createdDateTime: obj.createdDateTime ? new Date(obj.createdDateTime) : null,
            lastModifiedDateTime: obj.lastModifiedDateTime ? new Date(obj.lastModifiedDateTime) : null,
            body: obj.body || null,
            categories: obj.categories || [],
            checklistItems: (obj.checklistItems || []).map(ci => ({
                id: ci.id,
                displayName: ci.displayName,
                isChecked: ci.isChecked,
                checkedDateTime: ci.checkedDateTime ? new Date(ci.checkedDateTime) : null,
            })),
            _parentTaskId: obj._parentTaskId || null,
            _order: obj._order ?? null,
            _isRecurring: obj._isRecurring || false,
            _sectionId: obj._sectionId || null,
        };

        // Re-attach getter aliases (same pattern as fromGraphJson)
        Object.defineProperties(task, {
            '_uid':      { get() { return this.id; } },
            '_due':      { get() { return this.dueDateTime; } },
            '_taskList': { get() { return this.listId; } },
        });

        return task;
    }
}

// ── Sort functions for internal model objects ────────────────────────

/**
 * Sort by title alphabetically.
 */
export function sortByName(a, b) {
    const ta = (a.title || '').toLowerCase();
    const tb = (b.title || '').toLowerCase();

    if (!a.title) return 1;
    if (!b.title) return -1;

    return ta.localeCompare(tb);
}

/**
 * Sort by due date (earliest first). Tasks with no due date go last.
 * Ties broken by priority.
 */
export function sortByDueDate(a, b) {
    if (!a.dueDateTime && !b.dueDateTime)
        return sortByPriority(a, b);

    if (!b.dueDateTime) return -1;
    if (!a.dueDateTime) return 1;

    return a.dueDateTime.getTime() - b.dueDateTime.getTime();
}

/**
 * Sort by importance (high > normal > low). Ties broken by name.
 * Maps: high=1, normal=5, low=9 (matches iCal priority convention).
 */
export function sortByPriority(a, b) {
    const map = {high: 1, normal: 5, low: 9};
    const pa = map[a.importance] || 5;
    const pb = map[b.importance] || 5;

    if (pa === pb) return sortByName(a, b);

    return pa - pb;
}
