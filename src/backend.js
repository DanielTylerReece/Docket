'use strict';

/**
 * Abstract base class for task backend adapters.
 *
 * Each backend (Microsoft Graph, Todoist, etc.) implements this interface
 * so the SyncEngine and UI can work with any provider uniformly.
 *
 * All methods throw 'not implemented' unless overridden by a subclass.
 */
export class BackendAdapter {
    /**
     * Unique backend identifier string (e.g. 'microsoft', 'todoist').
     * @returns {string}
     */
    get id() {
        throw new Error('not implemented');
    }

    // ── Auth ─────────────────────────────────────────────────────────

    /**
     * Load stored tokens/credentials from persistent storage.
     * @returns {Promise<boolean>} true if tokens were loaded successfully
     */
    async loadTokens() {
        throw new Error('not implemented');
    }

    /**
     * Start the authentication flow (device code, OAuth redirect, etc.).
     * @param {Function} callback - Called with flow-specific data (user code, URL, etc.)
     * @returns {Promise<object>} Flow-specific result object
     */
    async startAuthFlow(callback) {
        throw new Error('not implemented');
    }

    /**
     * Check whether the backend currently has valid credentials.
     * @returns {boolean}
     */
    isAuthenticated() {
        throw new Error('not implemented');
    }

    /**
     * Clear all stored credentials and sign out.
     * @returns {Promise<void>}
     */
    async clearAuth() {
        throw new Error('not implemented');
    }

    /**
     * Get the underlying auth manager instance (backend-specific).
     * Used by components that need direct access (e.g. prefs page).
     * @returns {object}
     */
    getAuthManager() {
        throw new Error('not implemented');
    }

    /**
     * Clean up all resources (timers, HTTP sessions, credentials from memory).
     */
    destroy() {
        throw new Error('not implemented');
    }

    // ── Task Lists ───────────────────────────────────────────────────

    /**
     * Fetch all task lists from the backend.
     * Each returned list object MUST include `_backendId: this.id`.
     * @returns {Promise<object[]>} Array of task list objects
     */
    async listTaskLists() {
        throw new Error('not implemented');
    }

    /**
     * Create a new task list.
     * @param {string} name - Display name for the new list
     * @returns {Promise<object>} Created task list object (must include _backendId)
     */
    async createTaskList(name) {
        throw new Error('not implemented');
    }

    /**
     * Rename a task list.
     * @param {string} listId
     * @param {string} newName
     * @returns {Promise<object>} Updated task list object
     */
    async renameTaskList(listId, newName) {
        throw new Error('not implemented');
    }

    /**
     * Delete a task list.
     * @param {string} listId
     * @returns {Promise<void>}
     */
    async deleteTaskList(listId) {
        throw new Error('not implemented');
    }

    // ── Tasks ────────────────────────────────────────────────────────

    /**
     * Fetch all tasks in a given task list.
     * @param {string} listId
     * @returns {Promise<object[]>} Array of internal task model objects
     */
    async listTasks(listId) {
        throw new Error('not implemented');
    }

    /**
     * Create a new task in a task list.
     * @param {string} listId
     * @param {string} title
     * @param {object} [opts] - Optional fields (dueDateTime, importance, etc.)
     * @returns {Promise<object>} Created task (internal model)
     */
    async createTask(listId, title, opts) {
        throw new Error('not implemented');
    }

    /**
     * Update a task with a partial patch.
     * @param {string} listId
     * @param {string} taskId
     * @param {object} patch - Fields to update
     * @returns {Promise<object>} Updated task (internal model)
     */
    async updateTask(listId, taskId, patch) {
        throw new Error('not implemented');
    }

    /**
     * Delete a task.
     * @param {string} listId
     * @param {string} taskId
     * @returns {Promise<void>}
     */
    async deleteTask(listId, taskId) {
        throw new Error('not implemented');
    }

    /**
     * Mark a task as completed.
     * @param {string} listId
     * @param {string} taskId
     * @returns {Promise<object>} Updated task (internal model)
     */
    async completeTask(listId, taskId) {
        throw new Error('not implemented');
    }

    /**
     * Mark a task as not started (uncomplete).
     * @param {string} listId
     * @param {string} taskId
     * @returns {Promise<object>} Updated task (internal model)
     */
    async uncompleteTask(listId, taskId) {
        throw new Error('not implemented');
    }

    /**
     * Update a task's title.
     * @param {string} listId
     * @param {string} taskId
     * @param {string} title - New title
     * @returns {Promise<object>} Updated task (internal model)
     */
    async updateTaskTitle(listId, taskId, title) {
        throw new Error('not implemented');
    }

    /**
     * Update a task's due date.
     * @param {string} listId
     * @param {string} taskId
     * @param {Date|null} dueDate - New due date, or null to clear
     * @returns {Promise<object>} Updated task (internal model)
     */
    async updateTaskDueDate(listId, taskId, dueDate) {
        throw new Error('not implemented');
    }

    // ── Checklist / Subtask ──────────────────────────────────────────

    /**
     * Toggle a checklist item's checked state.
     * @param {string} listId
     * @param {string} taskId
     * @param {string} itemId
     * @param {object} patch - e.g. {isChecked: boolean}
     * @returns {Promise<object>} Updated checklist item
     */
    async toggleChecklistItem(listId, taskId, itemId, patch) {
        throw new Error('not implemented');
    }

    // ── Delta Sync ───────────────────────────────────────────────────

    /**
     * Perform a delta query for incremental sync.
     * @param {string} listId
     * @param {string|null} token - Previous delta token (null for full fetch)
     * @returns {Promise<{tasks: object[], deltaLink: string|null}>}
     */
    async deltaQuery(listId, token) {
        throw new Error('not implemented');
    }

    /**
     * Whether this backend supports delta/incremental sync.
     * @returns {boolean}
     */
    supportsDelta() {
        throw new Error('not implemented');
    }

    /**
     * GSettings key name used to persist delta tokens for this backend.
     * @returns {string}
     */
    getDeltaTokenKey() {
        throw new Error('not implemented');
    }
}
