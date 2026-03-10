'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { GraphApi } from './graph-api.js';
import { TaskModel } from './task-model.js';

function _extractDeltaToken(deltaUrl) {
    try {
        const uri = GLib.Uri.parse(deltaUrl, GLib.UriFlags.NONE);
        const query = uri.get_query();
        if (!query) return null;
        const params = GLib.Uri.parse_params(query, -1, '&', GLib.UriParamsFlags.NONE);
        return params['$deltatoken'] || null;
    } catch {
        return null;
    }
}

function _buildDeltaUrl(listId, token) {
    return `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta?$deltatoken=${encodeURIComponent(token)}`;
}

/**
 * Sync engine for Microsoft To Do via Graph API.
 * Manages task list/task cache, delta sync, polling, and mutation operations.
 */
export class SyncEngine {
    /**
     * @param {import('./auth.js').AuthManager} authManager
     * @param {Gio.Settings|null} settings - GSettings instance (null for tests)
     */
    constructor(authManager, settings = null) {
        this._auth = authManager;
        this._settings = settings;
        this._api = new GraphApi(authManager);

        // Cache
        this._taskLists = [];           // [{id, displayName, ...}]
        this._tasks = new Map();         // listId → [task, ...]
        this._deltaTokens = new Map();   // listId → deltaLink URL

        // Polling
        this._pollSourceId = 0;
        this._destroyed = false;

        // Signal handlers
        this._signals = {
            'tasks-changed': [],
            'lists-changed': [],
            'auth-required': [],
        };
    }

    /**
     * Initial fetch of all lists and tasks.
     */
    async initialize() {
        await this._fetchLists();
        await this._fetchAllTasks();
        this._emit('lists-changed');
        this._emit('tasks-changed');
    }

    /**
     * Delta sync all lists (incremental — used for background polling).
     */
    async sync() {
        try {
            let changed = false;
            for (const list of this._taskLists) {
                const didChange = await this._deltaSync(list.id);
                if (didChange) changed = true;
            }
            if (changed)
                this._emit('tasks-changed');
        } catch (e) {
            if (e.message === 'auth-required')
                this._emit('auth-required');
            else
                console.error(`[sync-engine] sync error: ${e.message}`);
        }
    }

    /**
     * Full re-fetch of all tasks, replacing the cache entirely.
     * Use on panel open to catch remote deletions that delta may miss.
     */
    async fullSync() {
        try {
            await this._fetchAllTasks();
            this._emit('tasks-changed');
        } catch (e) {
            if (e.message === 'auth-required')
                this._emit('auth-required');
            else
                console.error(`[sync-engine] fullSync error: ${e.message}`);
        }
    }

    /**
     * @returns {object[]} Cached task lists
     */
    getTaskLists() {
        return this._taskLists;
    }

    /**
     * @param {string} listId
     * @returns {object[]} Cached tasks for the given list
     */
    getTasks(listId) {
        return this._tasks.get(listId) || [];
    }

    /**
     * Create a task and update cache.
     * @param {string} listId
     * @param {string} title
     * @param {object} [opts] - Optional fields (dueDateTime, importance, etc.)
     * @returns {Promise<object>} Created task (internal model)
     */
    async createTask(listId, title, opts = {}) {
        const payload = TaskModel.toCreatePayload(title, opts);
        const task = await this._api.createTask(listId, payload);
        const tasks = this._tasks.get(listId) || [];
        tasks.push(task);
        this._tasks.set(listId, tasks);
        this._emit('tasks-changed');
        return task;
    }

    /**
     * Mark a task as completed.
     */
    async completeTask(listId, taskId) {
        const patch = TaskModel.toUpdatePayload({status: 'completed'});
        const updated = await this._api.updateTask(listId, taskId, patch);
        this._updateTaskInCache(listId, updated);
        this._emit('tasks-changed');
        return updated;
    }

    /**
     * Mark a task as not started (uncomplete).
     */
    async uncompleteTask(listId, taskId) {
        const patch = TaskModel.toUpdatePayload({status: 'notStarted'});
        const updated = await this._api.updateTask(listId, taskId, patch);
        this._updateTaskInCache(listId, updated);
        this._emit('tasks-changed');
        return updated;
    }

    /**
     * Update a task's title.
     * @param {string} listId
     * @param {string} taskId
     * @param {string} newTitle
     */
    async updateTaskTitle(listId, taskId, newTitle) {
        const updated = await this._api.updateTask(listId, taskId, {title: newTitle});
        this._updateTaskInCache(listId, updated);
        this._emit('tasks-changed');
    }

    /**
     * Delete a task.
     */
    async deleteTask(listId, taskId) {
        await this._api.deleteTask(listId, taskId);
        const tasks = this._tasks.get(listId) || [];
        this._tasks.set(listId, tasks.filter(t => t.id !== taskId));
        this._emit('tasks-changed');
    }

    /**
     * Toggle a checklist item's checked state.
     */
    async toggleChecklistItem(listId, taskId, itemId) {
        const tasks = this._tasks.get(listId) || [];
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        const item = task.checklistItems.find(ci => ci.id === itemId);
        if (!item) return;

        const updated = await this._api.updateChecklistItem(
            listId, taskId, itemId, {isChecked: !item.isChecked}
        );

        // Update local cache
        item.isChecked = updated.isChecked;
        item.checkedDateTime = updated.checkedDateTime
            ? new Date(updated.checkedDateTime)
            : null;
        this._emit('tasks-changed');
    }

    /**
     * Start periodic polling.
     * @param {number} intervalSeconds
     */
    startPolling(intervalSeconds) {
        this.stopPolling();
        this._pollSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, intervalSeconds, () => {
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                this.sync().catch(e =>
                    console.error(`[sync-engine] poll error: ${e.message}`)
                );
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    /**
     * Stop periodic polling.
     */
    stopPolling() {
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = 0;
        }
    }

    /**
     * Connect to a signal.
     * @param {string} signal - 'tasks-changed'|'lists-changed'|'auth-required'
     * @param {Function} callback
     */
    connect(signal, callback) {
        if (this._signals[signal])
            this._signals[signal].push(callback);
    }

    /**
     * Cleanup all timers and resources.
     */
    destroy() {
        this._destroyed = true;
        this.stopPolling();
        this._api.destroy();
        this._tasks.clear();
        this._taskLists = [];
        this._deltaTokens.clear();
    }

    // ── Private ─────────────────────────────────────────────────────

    async _fetchLists() {
        this._taskLists = await this._api.listTaskLists();
        this._loadDeltaTokens();
    }

    async _fetchAllTasks() {
        for (const list of this._taskLists) {
            const result = await this._api.deltaQuery(list.id);
            this._tasks.set(list.id, result.tasks.filter(t => !t._removed));
            if (result.deltaLink)
                this._deltaTokens.set(list.id, result.deltaLink);
        }
        this._saveDeltaTokens();
    }

    async _deltaSync(listId) {
        const deltaToken = this._deltaTokens.get(listId) || null;
        let result;

        try {
            result = await this._api.deltaQuery(listId, deltaToken);
        } catch (e) {
            // Delta token expired (410 Gone) or invalid — full replace
            if (deltaToken) {
                console.log('[sync-engine] Delta token invalid for a task list, doing full refresh');
                this._deltaTokens.delete(listId);
                result = await this._api.deltaQuery(listId, null);
                this._tasks.set(listId, result.tasks.filter(t => !t._removed));
                if (result.deltaLink)
                    this._deltaTokens.set(listId, result.deltaLink);
                this._saveDeltaTokens();
                return true;
            }
            throw e;
        }

        if (result.tasks.length === 0) {
            if (result.deltaLink)
                this._deltaTokens.set(listId, result.deltaLink);
            return false;
        }

        const current = this._tasks.get(listId) || [];
        const taskMap = new Map(current.map(t => [t.id, t]));

        for (const t of result.tasks) {
            if (t._removed)
                taskMap.delete(t.id);
            else
                taskMap.set(t.id, t);
        }

        this._tasks.set(listId, [...taskMap.values()]);

        if (result.deltaLink)
            this._deltaTokens.set(listId, result.deltaLink);

        this._saveDeltaTokens();
        return true;
    }

    _updateTaskInCache(listId, updated) {
        const tasks = this._tasks.get(listId) || [];
        const idx = tasks.findIndex(t => t.id === updated.id);
        if (idx >= 0)
            tasks[idx] = updated;
        else
            tasks.push(updated);
        this._tasks.set(listId, tasks);
    }

    _emit(signal) {
        if (this._signals[signal]) {
            for (const cb of this._signals[signal]) {
                try { cb(); } catch (e) {
                    console.error(`[sync-engine] signal ${signal} handler error: ${e.message}`);
                }
            }
        }
    }

    _loadDeltaTokens() {
        if (!this._settings) return;
        try {
            const json = this._settings.get_string('delta-tokens');
            if (json) {
                const obj = JSON.parse(json);
                for (const [listId, token] of Object.entries(obj)) {
                    if (typeof token === 'string' && token.length > 0)
                        this._deltaTokens.set(listId, _buildDeltaUrl(listId, token));
                }
            }
        } catch (e) {
            // Corrupted — clear and force full sync
            this._settings.set_string('delta-tokens', '');
        }
    }

    _saveDeltaTokens() {
        if (!this._settings) return;
        try {
            const obj = {};
            for (const [k, v] of this._deltaTokens) {
                const token = _extractDeltaToken(v);
                if (token)
                    obj[k] = token;
            }
            this._settings.set_string('delta-tokens', JSON.stringify(obj));
        } catch (e) { /* ignore */ }
    }
}
