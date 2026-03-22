'use strict';

import { BackendAdapter } from './backend.js';
import { TodoistAuthManager } from './todoist-auth.js';
import { TodoistApi } from './todoist-api.js';
import { TaskModel } from './task-model.js';

/**
 * Todoist backend adapter.
 *
 * Key differences from GraphBackend:
 *   - Auth is API-token based (no device code flow) — token set via prefs.
 *   - Delta sync is global (not per-list) — single sync token, filtered by project_id.
 *   - Checklist items are subtasks (full tasks), not a separate resource.
 */
export class TodoistBackend extends BackendAdapter {
    constructor() {
        super();
        this._authManager = new TodoistAuthManager();
        this._api = null;
        this._syncToken = null;
    }

    get id() {
        return 'todoist';
    }

    // ── Auth ─────────────────────────────────────────────────────────

    async loadTokens() {
        const loaded = await this._authManager.loadTokens();
        if (loaded && this._authManager.isAuthenticated())
            this._ensureApi();
        return loaded;
    }

    async startAuthFlow() {
        throw new Error('Todoist uses API token auth — configure in Settings');
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
        this._syncToken = null;
    }

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
        this._syncToken = null;
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
        return this._api.createTask(listId, {title, ...opts});
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
        return this._api.updateTask(listId, taskId, {status: 'completed'});
    }

    async uncompleteTask(listId, taskId) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, {status: 'notStarted'});
    }

    async updateTaskTitle(listId, taskId, newTitle) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, {title: newTitle});
    }

    async updateTaskDueDate(listId, taskId, dueDate) {
        this._ensureApi();
        return this._api.updateTask(listId, taskId, {dueDate});
    }

    // ── Checklist / Subtask ──────────────────────────────────────────

    async toggleChecklistItem(listId, taskId, itemId, patch) {
        // Todoist subtasks are full tasks — complete/uncomplete the subtask itself
        this._ensureApi();
        const status = patch && patch.isChecked ? 'completed' : 'notStarted';
        return this._api.updateTask(listId, itemId, {status});
    }

    async createSubtask(listId, taskId, title) {
        this._ensureApi();
        return this._api.createSubtask(listId, taskId, title);
    }

    async deleteSubtask(listId, _taskId, subtaskId) {
        this._ensureApi();
        return this._api.deleteTask(listId, subtaskId);
    }

    // ── Delta Sync ───────────────────────────────────────────────────

    /**
     * Todoist sync is global (not per-list), so we use a single stored
     * sync token and filter returned items by project_id.
     */
    async deltaQuery(listId, token) {
        this._ensureApi();

        const syncToken = token || this._syncToken || '*';
        const result = await this._api.deltaSync(syncToken);
        this._syncToken = result.syncToken;

        const tasks = (result.items || [])
            .filter(i => String(i.project_id) === String(listId))
            .map(i => {
                if (i.is_deleted)
                    return {id: String(i.id), _removed: true};
                return TaskModel.fromTodoistJson(i, listId);
            });

        return {tasks, deltaLink: result.syncToken};
    }

    supportsDelta() {
        return true;
    }

    getDeltaTokenKey() {
        return 'todoist-delta-tokens';
    }

    // ── Private ──────────────────────────────────────────────────────

    _ensureApi() {
        if (!this._api) {
            if (!this._authManager)
                throw new Error('TodoistBackend has been destroyed');
            this._api = new TodoistApi(this._authManager);
        }
    }
}
