'use strict';

import { BackendAdapter } from './backend.js';
import { AuthManager } from './auth.js';
import { GraphApi } from './graph-api.js';
import { TaskModel } from './task-model.js';

/**
 * Microsoft Graph backend adapter.
 *
 * Wraps the existing AuthManager and GraphApi classes behind the
 * BackendAdapter interface, making Microsoft To Do a pluggable backend.
 */
export class GraphBackend extends BackendAdapter {
    constructor() {
        super();
        this._authManager = new AuthManager();
        this._api = null;
    }

    /**
     * @returns {string} Backend identifier
     */
    get id() {
        return 'microsoft';
    }

    // ── Auth ─────────────────────────────────────────────────────────

    /**
     * Load tokens from GNOME Keyring. If tokens are available, instantiate
     * the GraphApi so the backend is ready for API calls.
     * @returns {Promise<boolean>} true if tokens were loaded
     */
    async loadTokens() {
        const loaded = await this._authManager.loadTokens();
        if (loaded && this._authManager.isAuthenticated())
            this._ensureApi();
        return loaded;
    }

    /**
     * Start Microsoft device code flow.
     * @returns {Promise<{userCode, verificationUri, message, pollPromise}>}
     */
    async startAuthFlow() {
        const flow = await this._authManager.startDeviceCodeFlow();
        // Wrap the poll promise so we create the GraphApi once auth completes
        const originalPollPromise = flow.pollPromise;
        flow.pollPromise = originalPollPromise.then(() => {
            this._ensureApi();
        });
        return flow;
    }

    /**
     * @returns {boolean} Whether we have valid Microsoft credentials
     */
    isAuthenticated() {
        return this._authManager.isAuthenticated();
    }

    /**
     * Clear all Microsoft tokens from memory and GNOME Keyring.
     * @returns {Promise<void>}
     */
    async clearAuth() {
        await this._authManager.clearTokens();
        if (this._api) {
            this._api.destroy();
            this._api = null;
        }
    }

    /**
     * Get the underlying AuthManager instance.
     * Needed by prefs.js and other components that interact directly
     * with the auth layer (e.g. to show sign-in UI).
     * @returns {AuthManager}
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
    }

    // ── Task Lists ───────────────────────────────────────────────────

    /**
     * Fetch all Microsoft To Do task lists, tagging each with _backendId.
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
     * Create a new Microsoft To Do task list.
     * @param {string} name - Display name
     * @returns {Promise<object>} Created list with _backendId
     */
    async createTaskList(name) {
        this._ensureApi();
        const list = await this._api.createTaskList(name);
        list._backendId = this.id;
        return list;
    }

    /**
     * Rename a Microsoft To Do task list.
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
     * Delete a Microsoft To Do task list.
     * @param {string} listId
     * @returns {Promise<void>}
     */
    async deleteTaskList(listId) {
        this._ensureApi();
        await this._api.deleteTaskList(listId);
    }

    // ── Tasks ────────────────────────────────────────────────────────

    /**
     * List tasks in a task list (with checklistItems expanded).
     * @param {string} listId
     * @returns {Promise<object[]>}
     */
    async listTasks(listId) {
        this._ensureApi();
        return this._api.listTasks(listId);
    }

    /**
     * Create a task. Converts title + opts into Graph API payload via TaskModel.
     * @param {string} listId
     * @param {string} title
     * @param {object} [opts]
     * @returns {Promise<object>} Created task (internal model)
     */
    async createTask(listId, title, opts = {}) {
        this._ensureApi();
        const payload = TaskModel.toCreatePayload(title, opts);
        return this._api.createTask(listId, payload);
    }

    /**
     * Update a task with a raw Graph API patch body.
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
     * Uses TaskModel.toUpdatePayload to build the Graph patch.
     * @param {string} listId
     * @param {string} taskId
     * @returns {Promise<object>} Updated task (internal model)
     */
    async completeTask(listId, taskId) {
        this._ensureApi();
        const patch = TaskModel.toUpdatePayload({status: 'completed'});
        return this._api.updateTask(listId, taskId, patch);
    }

    /**
     * Mark a task as not started.
     * @param {string} listId
     * @param {string} taskId
     * @returns {Promise<object>} Updated task (internal model)
     */
    async uncompleteTask(listId, taskId) {
        this._ensureApi();
        const patch = TaskModel.toUpdatePayload({status: 'notStarted'});
        return this._api.updateTask(listId, taskId, patch);
    }

    /**
     * Update a task's title.
     * Passes raw {title} patch directly (matches how sync-engine.js calls it).
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
     * Uses TaskModel.toUpdatePayload to build the Graph patch.
     * @param {string} listId
     * @param {string} taskId
     * @param {Date|null} dueDate - New due date, or null to clear
     * @returns {Promise<object>} Updated task (internal model)
     */
    async updateTaskDueDate(listId, taskId, dueDate) {
        this._ensureApi();
        const patch = TaskModel.toUpdatePayload({dueDateTime: dueDate});
        return this._api.updateTask(listId, taskId, patch);
    }

    // ── Checklist / Subtask ──────────────────────────────────────────

    /**
     * Toggle a checklist item's checked state.
     * Delegates directly to GraphApi.updateChecklistItem().
     * @param {string} listId
     * @param {string} taskId
     * @param {string} itemId
     * @param {object} patch - {isChecked: boolean}
     * @returns {Promise<object>} Updated checklist item
     */
    async toggleChecklistItem(listId, taskId, itemId, patch) {
        this._ensureApi();
        return this._api.updateChecklistItem(listId, taskId, itemId, patch);
    }

    /**
     * Create a checklist item (subtask) under a parent task.
     * Uses Graph API's checklistItems endpoint.
     * @param {string} listId
     * @param {string} taskId - Parent task ID
     * @param {string} title - Checklist item display name
     * @returns {Promise<object>} Created checklist item
     */
    async createSubtask(listId, taskId, title) {
        this._ensureApi();
        return this._api.createChecklistItem(listId, taskId, {displayName: title});
    }

    // ── Delta Sync ───────────────────────────────────────────────────

    /**
     * Delta query for incremental sync.
     * @param {string} listId
     * @param {string|null} token - Previous deltaLink URL (full URL) or null
     * @returns {Promise<{tasks: object[], deltaLink: string|null}>}
     */
    async deltaQuery(listId, token) {
        this._ensureApi();
        return this._api.deltaQuery(listId, token);
    }

    /**
     * Microsoft Graph supports delta queries.
     * @returns {boolean}
     */
    supportsDelta() {
        return true;
    }

    /**
     * GSettings key used to persist Microsoft delta tokens.
     * @returns {string}
     */
    getDeltaTokenKey() {
        return 'delta-tokens';
    }

    // ── Private ──────────────────────────────────────────────────────

    /**
     * Lazily create the GraphApi instance, ensuring we have an auth manager.
     */
    _ensureApi() {
        if (!this._api) {
            if (!this._authManager)
                throw new Error('GraphBackend has been destroyed');
            this._api = new GraphApi(this._authManager);
        }
    }
}
