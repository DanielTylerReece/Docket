'use strict';

/**
 * Converts between backend JSON (Graph API, Todoist) and the internal
 * task model used by the extension UI.
 */
export class TaskModel {
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

            get _uid() { return this.id; },
            get _due() { return this.dueDateTime; },
            // getter-only — never assign to _taskList directly
            get _taskList() { return this.listId; },
        };
    }

    /**
     * Priority mapping (Todoist values are inverted from display):
     *   4 = p1 (urgent/red)  -> 'high'
     *   3 = p2 (orange)      -> 'high'
     *   2 = p3 (yellow)      -> 'normal'
     *   1 = p4 (default)     -> 'low'
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
            checklistItems: [],
            _parentTaskId: item.parent_id ? String(item.parent_id) : null,
            _order: item.child_order ?? item.order,
            _isRecurring: item.due?.is_recurring || false,
            _sectionId: item.section_id ? String(item.section_id) : null,
        };

        if (item.due) {
            if (item.due.datetime)
                task.dueDateTime = new Date(item.due.datetime);
            else if (item.due.date)
                task.dueDateTime = new Date(item.due.date + 'T00:00:00Z');
        }

        Object.defineProperties(task, {
            '_uid':      { get() { return this.id; } },
            '_due':      { get() { return this.dueDateTime; } },
            '_taskList': { get() { return this.listId; } },
        });

        return task;
    }

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
     * Serialize a task for JSON storage (offline cache).
     * Getter aliases (_uid, _due, _taskList) are non-enumerable
     * and won't appear in JSON.stringify.
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
            _parentTaskId: task._parentTaskId || null,
            _order: task._order ?? null,
            _isRecurring: task._isRecurring || false,
            _sectionId: task._sectionId || null,
        };
    }

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

        Object.defineProperties(task, {
            '_uid':      { get() { return this.id; } },
            '_due':      { get() { return this.dueDateTime; } },
            '_taskList': { get() { return this.listId; } },
        });

        return task;
    }
}

export function sortByName(a, b) {
    const ta = (a.title || '').toLowerCase();
    const tb = (b.title || '').toLowerCase();

    if (!a.title) return 1;
    if (!b.title) return -1;

    return ta.localeCompare(tb);
}

/**
 * Earliest due date first. Tasks with no due date go last.
 */
export function sortByDueDate(a, b) {
    if (!a.dueDateTime && !b.dueDateTime)
        return sortByPriority(a, b);

    if (!b.dueDateTime) return -1;
    if (!a.dueDateTime) return 1;

    return a.dueDateTime.getTime() - b.dueDateTime.getTime();
}

/**
 * Maps: high=1, normal=5, low=9 (iCal priority convention).
 */
export function sortByPriority(a, b) {
    const map = {high: 1, normal: 5, low: 9};
    const pa = map[a.importance] || 5;
    const pb = map[b.importance] || 5;

    if (pa === pb) return sortByName(a, b);

    return pa - pb;
}
