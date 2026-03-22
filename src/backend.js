'use strict';

/**
 * Abstract base class for task backend adapters.
 *
 * Each backend (Microsoft Graph, Todoist, etc.) implements this interface
 * so the SyncEngine and UI can work with any provider uniformly.
 */
export class BackendAdapter {
    get id() {
        throw new Error('not implemented');
    }

    // ── Auth ─────────────────────────────────────────────────────────

    async loadTokens() {
        throw new Error('not implemented');
    }

    async startAuthFlow(callback) {
        throw new Error('not implemented');
    }

    isAuthenticated() {
        throw new Error('not implemented');
    }

    async clearAuth() {
        throw new Error('not implemented');
    }

    getAuthManager() {
        throw new Error('not implemented');
    }

    destroy() {
        throw new Error('not implemented');
    }

    // ── Task Lists ───────────────────────────────────────────────────

    async listTaskLists() {
        throw new Error('not implemented');
    }

    async createTaskList(name) {
        throw new Error('not implemented');
    }

    async renameTaskList(listId, newName) {
        throw new Error('not implemented');
    }

    async deleteTaskList(listId) {
        throw new Error('not implemented');
    }

    // ── Tasks ────────────────────────────────────────────────────────

    async listTasks(listId) {
        throw new Error('not implemented');
    }

    async createTask(listId, title, opts) {
        throw new Error('not implemented');
    }

    async updateTask(listId, taskId, patch) {
        throw new Error('not implemented');
    }

    async deleteTask(listId, taskId) {
        throw new Error('not implemented');
    }

    async completeTask(listId, taskId) {
        throw new Error('not implemented');
    }

    async uncompleteTask(listId, taskId) {
        throw new Error('not implemented');
    }

    async updateTaskTitle(listId, taskId, title) {
        throw new Error('not implemented');
    }

    async updateTaskDueDate(listId, taskId, dueDate) {
        throw new Error('not implemented');
    }

    // ── Checklist / Subtask ──────────────────────────────────────────

    async toggleChecklistItem(listId, taskId, itemId, patch) {
        throw new Error('not implemented');
    }

    async createSubtask(listId, taskId, title) {
        throw new Error('not implemented');
    }

    async deleteSubtask(listId, taskId, subtaskId) {
        throw new Error('not implemented');
    }

    // ── Delta Sync ───────────────────────────────────────────────────

    async deltaQuery(listId, token) {
        throw new Error('not implemented');
    }

    supportsDelta() {
        throw new Error('not implemented');
    }

    getDeltaTokenKey() {
        throw new Error('not implemented');
    }
}
