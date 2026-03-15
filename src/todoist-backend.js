'use strict';

import { BackendAdapter } from './backend.js';
import { TodoistAuthManager } from './todoist-auth.js';
import { TodoistApi } from './todoist-api.js';
import { TaskModel } from './task-model.js';

/**
 * Todoist backend adapter.
 *
 * Wraps TodoistAuthManager and TodoistApi behind the BackendAdapter interface,
 * making Todoist a pluggable backend alongside Microsoft Graph.
 *
 * Key differences from GraphBackend:
 *   - Auth is API-token based (no device code flow) — token set via prefs.
 *   - Delta sync is global (not per-list) — we track a single sync token
 *     and filter results by project_id.
 *   - Checklist items are subtasks (full tasks), not a separate resource.
 */
export class TodoistBackend extends BackendAdapter {
    constructor() {
        super();
        this._authManager = new TodoistAuthManager();
        this._api = null;
        this._syncToken = null;
    }

    /**
     * @returns {string} Backend identifier
     */
    get id() {
        return 'todoist';
    }

    // ── Auth ─────────────────────────────────────────────────────────

    /**
     * Load stored API token from GNOME Keyring. If a token is available,
     * instantiate the TodoistApi so the backend is ready for API calls.
     * @returns {Promise<boolean>} true if a token was loaded
     */
    async loadTokens() {
        const loaded = await this._authManager.loadTokens();
        if (loaded && this._authManager.isAuthenticated())
            this._ensureApi();
        return loaded;
    }

    /**
     * Todoist uses API token auth — there is no interactive device code flow.
     * The token is configured in the prefs page via TodoistAuthManager.storeToken().
     * @throws {Error} Always — directs user to Settings
     */
    async startAuthFlow() {
        throw new Error('Todoist uses API token auth — configure in Settings');
    }

    /**
     * @returns {boolean} Whether we have a valid Todoist API token
     */
    isAuthenticated() {
        return this._authManager.isAuthenticated();
    }

    /**
     * Clear all Todoist credentials from memory and GNOME Keyring.
     * @returns {Promise<void>}
     */
    async clearAuth() {
        await this._authManager.clearTokens();
        if (this._api) {
            this._api.destroy();
            this._api = null;
        }
        this._syncToken = null;
    }

    /**
     * Get the underlying TodoistAuthManager instance.
     * Needed by prefs.js for the API token entry UI.
     * @returns {TodoistAuthManager}
     */
    getAuthManager() {
        return this._authManager;
    }

    /**
     * Clean up all resources.
     */
    destroy() {
        if (this._api) {
            this._api.destroy();
            this._api = null;
        }
        if (this._authManager) {
            this._authManager.destroy();
            this._authManager = null;
        }
        this._syncToken = null;
    }

    // ── Task Lists ───────────────────────────────────────────────────

    /**
     * Fetch all Todoist projects (task lists), tagging each with _backendId.
     * @returns {Promise<object[]>}
     */
    async listTaskLists() {
        this._ensureApi();
        const lists = await this._api.listTaskLists();
        for (const list of lists)
            list._backendId = this.id;
        return lists;
    }

    /**
     * Create a new Todoist project (task list).
     * @param {string} name
     * @returns {Promise<object>} Created list with _backendId
     */
    async createTaskList(name) {
        this._ensureApi();
        const list = await this._api.createTaskList(name);
        list._backendId = this.id;
        return list;
    }

    /**
     * Rename a Todoist project (task list).
     * @param {string} listId
     * @param {string} newName
     * @returns {Promise<object>} Updated list with _backendId
     */
    async renameTaskList(listId, newName) {
        this._ensureApi();
        const list = await this._api.renameTaskList(listId, newName);
        list._backendId = this.id;
        return list;
    }

    /**
     * Delete a Todoist project (task list).
     * @param {string} listId
     * @returns {Promise<void>}
     */
    async deleteTaskList(listId) {
        this._ensureApi();
        await this._api.deleteTaskList(listId);
    }

    // ── Tasks ────────────────────────────────────────────────────────

    /**
     * List tasks in a Todoist project.
     * @param {string} listId - Project ID
     * @returns {Promise<object[]>}
     */
    async listTasks(listId) {
        this._ensureApi();
        return this._api.listTasks(listId);
    }

    /**
     * Create a task in a Todoist project.
     * @param {string} listId - Project ID
     * @param {string} title
     * @param {object} [opts] - Optional fields (dueDateTime, etc.)
     * @returns {Promise<object>} Created task (internal model)
     */
    async createTask(listId, title, opts = {}) {
        this._ensureApi();
        return this._api.createTask(listId, {title, ...opts});
    }

    /**
     * Update a task with a partial patch.
     * TodoistApi.updateTask handles title, status (complete/uncomplete),
     * and other field changes internally.
     * @param {string} listId
     * @param {string} taskId
     * @param {object} patch
     * @returns {Promise<object>} Updated task (internal model)
     */
    async updateTask(listId, taskId, patch) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, patch);
    }

    /**
     * Delete a task.
     * @param {string} listId
     * @param {string} taskId
     * @returns {Promise<void>}
     */
    async deleteTask(listId, taskId) {
        this._ensureApi();
        await this._api.deleteTask(listId, taskId);
    }

    /**
     * Mark a task as completed.
     * Delegates to TodoistApi.updateTask which internally handles
     * POST /close + re-fetch to return the updated task model.
     * @param {string} listId
     * @param {string} taskId
     * @returns {Promise<object>} Updated task (internal model)
     */
    async completeTask(listId, taskId) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, {status: 'completed'});
    }

    /**
     * Mark a task as not started (uncomplete).
     * Delegates to TodoistApi.updateTask which internally handles
     * POST /reopen + re-fetch to return the updated task model.
     * @param {string} listId
     * @param {string} taskId
     * @returns {Promise<object>} Updated task (internal model)
     */
    async uncompleteTask(listId, taskId) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, {status: 'notStarted'});
    }

    /**
     * Update a task's title.
     * @param {string} listId
     * @param {string} taskId
     * @param {string} newTitle
     * @returns {Promise<object>} Updated task (internal model)
     */
    async updateTaskTitle(listId, taskId, newTitle) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, {title: newTitle});
    }

    /**
     * Update a task's due date.
     * @param {string} listId
     * @param {string} taskId
     * @param {Date|null} dueDate - New due date, or null to clear
     * @returns {Promise<object>} Updated task (internal model)
     */
    async updateTaskDueDate(listId, taskId, dueDate) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, {dueDate});
    }

    // ── Checklist / Subtask ──────────────────────────────────────────

    /**
     * Toggle a checklist item's checked state.
     *
     * Todoist subtasks are full tasks (not a separate checklist resource),
     * so we complete/uncomplete the subtask itself via updateTask.
     * The itemId IS the subtask's task ID.
     *
     * @param {string} listId
     * @param {string} taskId - Parent task ID (unused — subtask is self-contained)
     * @param {string} itemId - Subtask task ID
     * @param {object} patch - {isChecked: boolean}
     * @returns {Promise<object>} Updated subtask (internal model)
     */
    async toggleChecklistItem(listId, taskId, itemId, patch) {
        this._ensureApi();
        const status = patch && patch.isChecked ? 'completed' : 'notStarted';
        return this._api.updateTask(listId, itemId, {status});
    }

    /**
     * Create a subtask (child task) under a parent task.
     * Todoist subtasks are full tasks with parent_id set.
     * @param {string} listId - Project ID
     * @param {string} taskId - Parent task ID
     * @param {string} title - Subtask title
     * @returns {Promise<object>} Created subtask (internal model)
     */
    async createSubtask(listId, taskId, title) {
        this._ensureApi();
        return this._api.createSubtask(listId, taskId, title);
    }

    async deleteSubtask(listId, _taskId, subtaskId) {
        // Todoist subtasks are regular tasks — delete by subtask ID
        this._ensureApi();
        return this._api.deleteTask(listId, subtaskId);
    }

    // ── Delta Sync ───────────────────────────────────────────────────

    /**
     * Delta sync using the Todoist Sync API.
     *
     * Todoist's sync is global (not per-list), so we use a single stored
     * sync token and filter returned items by project_id to match the
     * requested list.
     *
     * Deleted items are returned with `_removed: true` so the SyncEngine
     * can prune them from its cache.
     *
     * @param {string} listId - Project ID to filter results to
     * @param {string|null} token - Previous sync token (unused — we track internally)
     * @returns {Promise<{tasks: object[], deltaLink: string|null}>}
     */
    async deltaQuery(listId, token) {
        this._ensureApi();

        // Use the SyncEngine-provided token (persisted in GSettings) if available,
        // fall back to our in-memory token, then '*' for full sync
        const syncToken = token || this._syncToken || '*';
        const result = await this._api.deltaSync(syncToken);
        this._syncToken = result.syncToken;

        // Filter items to the requested project and convert to internal model
        const tasks = (result.items || [])
            .filter(i => String(i.project_id) === String(listId))
            .map(i => {
                if (i.is_deleted)
                    return {id: String(i.id), _removed: true};
                return TaskModel.fromTodoistJson(i, listId);
            });

        return {tasks, deltaLink: result.syncToken};
    }

    /**
     * Todoist supports delta/incremental sync via the Sync API.
     * @returns {boolean}
     */
    supportsDelta() {
        return true;
    }

    /**
     * GSettings key used to persist Todoist delta tokens.
     * @returns {string}
     */
    getDeltaTokenKey() {
        return 'todoist-delta-tokens';
    }

    // ── Private ──────────────────────────────────────────────────────

    /**
     * Lazily create the TodoistApi instance, ensuring we have an auth manager.
     */
    _ensureApi() {
        if (!this._api) {
            if (!this._authManager)
                throw new Error('TodoistBackend has been destroyed');
            this._api = new TodoistApi(this._authManager);
        }
    }
}
