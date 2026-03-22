'use strict';

import { BackendAdapter } from './backend.js';
import { AuthManager } from './auth.js';
import { GraphApi } from './graph-api.js';
import { TaskModel } from './task-model.js';

/**
 * Microsoft Graph backend adapter.
 *
 * Wraps AuthManager and GraphApi behind the BackendAdapter interface.
 */
export class GraphBackend extends BackendAdapter {
    constructor() {
        super();
        this._authManager = new AuthManager();
        this._api = null;
    }

    get id() {
        return 'microsoft';
    }

    // ── Auth ─────────────────────────────────────────────────────────

    async loadTokens() {
        const loaded = await this._authManager.loadTokens();
        if (loaded && this._authManager.isAuthenticated())
            this._ensureApi();
        return loaded;
    }

    async startAuthFlow() {
        const flow = await this._authManager.startDeviceCodeFlow();
        const originalPollPromise = flow.pollPromise;
        flow.pollPromise = originalPollPromise.then(() => {
            this._ensureApi();
        });
        return flow;
    }

    isAuthenticated() {
        return this._authManager.isAuthenticated();
    }

    async clearAuth() {
        await this._authManager.clearTokens();
        if (this._api) {
            this._api.destroy();
            this._api = null;
        }
    }

    /**
     * Needed by prefs.js for direct auth layer interaction.
     */
    getAuthManager() {
        return this._authManager;
    }

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

    async listTaskLists() {
        this._ensureApi();
        const lists = await this._api.listTaskLists();
        for (const list of lists)
            list._backendId = this.id;
        return lists;
    }

    async createTaskList(name) {
        this._ensureApi();
        const list = await this._api.createTaskList(name);
        list._backendId = this.id;
        return list;
    }

    async renameTaskList(listId, newName) {
        this._ensureApi();
        const list = await this._api.renameTaskList(listId, newName);
        list._backendId = this.id;
        return list;
    }

    async deleteTaskList(listId) {
        this._ensureApi();
        await this._api.deleteTaskList(listId);
    }

    // ── Tasks ────────────────────────────────────────────────────────

    async listTasks(listId) {
        this._ensureApi();
        return this._api.listTasks(listId);
    }

    async createTask(listId, title, opts = {}) {
        this._ensureApi();
        const payload = TaskModel.toCreatePayload(title, opts);
        return this._api.createTask(listId, payload);
    }

    async updateTask(listId, taskId, patch) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, patch);
    }

    async deleteTask(listId, taskId) {
        this._ensureApi();
        await this._api.deleteTask(listId, taskId);
    }

    async completeTask(listId, taskId) {
        this._ensureApi();
        const patch = TaskModel.toUpdatePayload({status: 'completed'});
        return this._api.updateTask(listId, taskId, patch);
    }

    async uncompleteTask(listId, taskId) {
        this._ensureApi();
        const patch = TaskModel.toUpdatePayload({status: 'notStarted'});
        return this._api.updateTask(listId, taskId, patch);
    }

    async updateTaskTitle(listId, taskId, newTitle) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, {title: newTitle});
    }

    async updateTaskDueDate(listId, taskId, dueDate) {
        this._ensureApi();
        const patch = TaskModel.toUpdatePayload({dueDateTime: dueDate});
        return this._api.updateTask(listId, taskId, patch);
    }

    // ── Checklist / Subtask ──────────────────────────────────────────

    async toggleChecklistItem(listId, taskId, itemId, patch) {
        this._ensureApi();
        return this._api.updateChecklistItem(listId, taskId, itemId, patch);
    }

    async createSubtask(listId, taskId, title) {
        this._ensureApi();
        return this._api.createChecklistItem(listId, taskId, {displayName: title});
    }

    async deleteSubtask(listId, taskId, subtaskId) {
        this._ensureApi();
        return this._api.deleteChecklistItem(listId, taskId, subtaskId);
    }

    // ── Delta Sync ───────────────────────────────────────────────────

    async deltaQuery(listId, token) {
        this._ensureApi();
        return this._api.deltaQuery(listId, token);
    }

    supportsDelta() {
        return true;
    }

    getDeltaTokenKey() {
        return 'delta-tokens';
    }

    // ── Private ──────────────────────────────────────────────────────

    _ensureApi() {
        if (!this._api) {
            if (!this._authManager)
                throw new Error('GraphBackend has been destroyed');
            this._api = new GraphApi(this._authManager);
        }
    }
}
