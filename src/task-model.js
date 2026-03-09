'use strict';

/**
 * Data model for Microsoft Graph To Do tasks.
 * Converts between Graph JSON and the internal model used by the extension UI.
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

            // Aliases for backward compat with UI code that reads EDS-style properties
            get _uid() { return this.id; },
            get _due() { return this.dueDateTime; },
            get _taskList() { return this.listId; },
        };
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
