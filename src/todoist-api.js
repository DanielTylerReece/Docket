'use strict';

import { TodoistHttpClient } from './todoist-client.js';
import { TaskModel } from './task-model.js';

const REST_BASE = '/api/v1';
const SYNC_BASE = '/api/v1';

/**
 * High-level Todoist API wrapper.
 * Uses REST API v1 for CRUD and Sync API v9 for delta sync.
 */
export class TodoistApi {
    constructor(authManager) {
        this._client = new TodoistHttpClient(authManager);
    }

    /**
     * List all projects (task lists).
     * @returns {Promise<object[]>} Array of {id, displayName, wellknownListName, isOwner, isShared}
     */
    async listTaskLists() {
        const res = await this._client.get(`${REST_BASE}/projects`);
        this._checkStatus(res, 200);
        const projects = Array.isArray(res.body)
            ? res.body
            : (res.body?.results || []);
        return projects.map(p => ({
            id: String(p.id),
            displayName: p.name,
            isOwner: true,
            isShared: p.is_shared || false,
            wellknownListName: p.inbox_project ? 'defaultList' : 'none',
        }));
    }

    /**
     * List tasks in a project.
     * @param {string} listId - Project ID
     * @returns {Promise<object[]>} Array of internal task model objects
     */
    async listTasks(listId) {
        const res = await this._client.get(`${REST_BASE}/tasks?project_id=${encodeURIComponent(listId)}`);
        this._checkStatus(res, 200);
        const items = Array.isArray(res.body)
            ? res.body
            : (res.body?.results || []);
        return items.map(item => TaskModel.fromTodoistJson(item, listId));
    }

    // ── Project (Task List) CRUD ────────────────────────────────────

    /**
     * Create a new project (task list).
     * @param {string} name
     * @returns {Promise<object>} Created project {id, name, ...}
     */
    async createTaskList(name) {
        const res = await this._client.post(`${REST_BASE}/projects`, {name});
        this._checkStatus(res, 200);
        return {
            id: String(res.body.id),
            displayName: res.body.name,
            isOwner: true,
            isShared: res.body.is_shared || false,
            wellknownListName: 'none',
        };
    }

    /**
     * Rename a project (task list).
     * @param {string} listId - Project ID
     * @param {string} name - New name
     * @returns {Promise<object>} Updated project
     */
    async renameTaskList(listId, name) {
        const res = await this._client.post(
            `${REST_BASE}/projects/${encodeURIComponent(listId)}`, {name}
        );
        this._checkStatus(res, 200);
        return {
            id: String(res.body.id),
            displayName: res.body.name,
            isOwner: true,
            isShared: res.body.is_shared || false,
            wellknownListName: 'none',
        };
    }

    /**
     * Delete a project (task list).
     * @param {string} listId - Project ID
     */
    async deleteTaskList(listId) {
        const res = await this._client.delete(
            `${REST_BASE}/projects/${encodeURIComponent(listId)}`
        );
        if (res.status !== 204 && res.status !== 200)
            this._checkStatus(res, 204);
    }

    /**
     * Create a task in a project.
     * @param {string} listId - Project ID
     * @param {object} taskData - {title: string, dueDateTime?: Date, ...}
     * @returns {Promise<object>} Created task (internal model)
     */
    async createTask(listId, taskData) {
        const body = {
            content: taskData.title,
            project_id: listId,
        };

        if (taskData.dueDateTime)
            body.due_date = taskData.dueDateTime.toISOString().split('T')[0];

        const res = await this._client.post(`${REST_BASE}/tasks`, body);
        this._checkStatus(res, 200);
        return TaskModel.fromTodoistJson(res.body, listId);
    }

    /**
     * Create a subtask (child task) under a parent task.
     * @param {string} listId - Project ID
     * @param {string} parentId - Parent task ID
     * @param {string} title - Subtask title
     * @returns {Promise<object>} Created subtask (internal model)
     */
    async createSubtask(listId, parentId, title) {
        const body = {
            content: title,
            project_id: listId,
            parent_id: parentId,
        };
        const res = await this._client.post(`${REST_BASE}/tasks`, body);
        this._checkStatus(res, 200);
        return TaskModel.fromTodoistJson(res.body, listId);
    }

    /**
     * Update a task. Handles title, status (complete/uncomplete) changes.
     * @param {string} listId - Project ID
     * @param {string} taskId - Task ID
     * @param {object} patch - {title?: string, status?: 'completed'|'notStarted', ...}
     * @returns {Promise<object>} Updated task (internal model)
     */
    async updateTask(listId, taskId, patch) {
        const encodedId = encodeURIComponent(taskId);

        // Handle due date update
        if ('dueDate' in patch) {
            const body = patch.dueDate
                ? {due_date: patch.dueDate.toISOString().split('T')[0]}
                : {due_string: 'no date'};
            const res = await this._client.post(`${REST_BASE}/tasks/${encodedId}`, body);
            this._checkStatus(res, 200);

            // If no other changes, return immediately
            if (patch.title === undefined && patch.status === undefined)
                return TaskModel.fromTodoistJson(res.body, listId);
        }

        // Handle title update
        if (patch.title !== undefined) {
            const res = await this._client.post(`${REST_BASE}/tasks/${encodedId}`, {content: patch.title});
            this._checkStatus(res, 200);

            // If no status change, return immediately
            if (patch.status === undefined)
                return TaskModel.fromTodoistJson(res.body, listId);
        }

        // Handle status changes
        if (patch.status === 'completed') {
            const closeRes = await this._client.post(`${REST_BASE}/tasks/${encodedId}/close`, {});
            if (closeRes.status !== 204 && closeRes.status !== 200)
                this._checkStatus(closeRes, 204);
            const getRes = await this._client.get(`${REST_BASE}/tasks/${encodedId}`);
            this._checkStatus(getRes, 200);
            return TaskModel.fromTodoistJson(getRes.body, listId);
        }

        if (patch.status === 'notStarted') {
            const reopenRes = await this._client.post(`${REST_BASE}/tasks/${encodedId}/reopen`, {});
            if (reopenRes.status !== 204 && reopenRes.status !== 200)
                this._checkStatus(reopenRes, 204);
            const getRes = await this._client.get(`${REST_BASE}/tasks/${encodedId}`);
            this._checkStatus(getRes, 200);
            return TaskModel.fromTodoistJson(getRes.body, listId);
        }

        // If we only updated the title, we already returned above.
        // If patch had neither title nor status, fetch and return current state.
        const getRes = await this._client.get(`${REST_BASE}/tasks/${encodedId}`);
        this._checkStatus(getRes, 200);
        return TaskModel.fromTodoistJson(getRes.body, listId);
    }

    /**
     * Delete a task.
     * @param {string} listId - Project ID (unused but kept for API consistency)
     * @param {string} taskId - Task ID
     */
    async deleteTask(listId, taskId) {
        const res = await this._client.delete(`${REST_BASE}/tasks/${encodeURIComponent(taskId)}`);
        if (res.status !== 204 && res.status !== 200)
            this._checkStatus(res, 204);
    }

    /**
     * Mark a task as complete.
     * @param {string} listId - Project ID (unused but kept for API consistency)
     * @param {string} taskId - Task ID
     */
    async completeTask(listId, taskId) {
        const res = await this._client.post(`${REST_BASE}/tasks/${encodeURIComponent(taskId)}/close`, {});
        if (res.status !== 204 && res.status !== 200)
            this._checkStatus(res, 204);
    }

    /**
     * Reopen a completed task.
     * @param {string} listId - Project ID (unused but kept for API consistency)
     * @param {string} taskId - Task ID
     */
    async uncompleteTask(listId, taskId) {
        const res = await this._client.post(`${REST_BASE}/tasks/${encodeURIComponent(taskId)}/reopen`, {});
        if (res.status !== 204 && res.status !== 200)
            this._checkStatus(res, 204);
    }

    /**
     * Delta sync using Todoist Sync API.
     * @param {string} [syncToken='*'] - Previous sync token ('*' for full sync)
     * @returns {Promise<{items: object[], projects: object[], syncToken: string, fullSync: boolean}>}
     */
    async deltaSync(syncToken = '*') {
        const formBody = `sync_token=${encodeURIComponent(syncToken)}&resource_types=${encodeURIComponent('["items","projects"]')}`;
        const res = await this._client.postForm(`${SYNC_BASE}/sync`, formBody);
        this._checkStatus(res, 200);

        const data = res.body;
        return {
            items: data.items || [],
            projects: data.projects || [],
            syncToken: data.sync_token || '*',
            fullSync: data.full_sync || false,
        };
    }

    destroy() {
        this._client.destroy();
    }

    _checkStatus(res, expected) {
        if (res.status !== expected) {
            const errMsg = res.body?.error || res.body?.message || 'unknown';
            throw new Error(`Todoist API error: expected ${expected}, got ${res.status} (${errMsg})`);
        }
    }
}
