'use strict';

import { TodoistHttpClient } from './todoist-client.js';
import { TaskModel } from './task-model.js';

const REST_BASE = '/api/v1';
const SYNC_BASE = '/api/v1';

export class TodoistApi {
    constructor(authManager) {
        this._client = new TodoistHttpClient(authManager);
    }

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

    async listTasks(listId) {
        const res = await this._client.get(`${REST_BASE}/tasks?project_id=${encodeURIComponent(listId)}`);
        this._checkStatus(res, 200);
        const items = Array.isArray(res.body)
            ? res.body
            : (res.body?.results || []);
        return items.map(item => TaskModel.fromTodoistJson(item, listId));
    }

    // ── Project (Task List) CRUD ────────────────────────────────────

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

    async deleteTaskList(listId) {
        const res = await this._client.delete(
            `${REST_BASE}/projects/${encodeURIComponent(listId)}`
        );
        if (res.status !== 204 && res.status !== 200)
            this._checkStatus(res, 204);
    }

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

    async updateTask(listId, taskId, patch) {
        const encodedId = encodeURIComponent(taskId);

        if ('dueDate' in patch) {
            const body = patch.dueDate
                ? {due_date: patch.dueDate.toISOString().split('T')[0]}
                : {due_string: 'no date'};
            const res = await this._client.post(`${REST_BASE}/tasks/${encodedId}`, body);
            this._checkStatus(res, 200);

            if (patch.title === undefined && patch.status === undefined)
                return TaskModel.fromTodoistJson(res.body, listId);
        }

        if (patch.title !== undefined) {
            const res = await this._client.post(`${REST_BASE}/tasks/${encodedId}`, {content: patch.title});
            this._checkStatus(res, 200);

            if (patch.status === undefined)
                return TaskModel.fromTodoistJson(res.body, listId);
        }

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

        const getRes = await this._client.get(`${REST_BASE}/tasks/${encodedId}`);
        this._checkStatus(getRes, 200);
        return TaskModel.fromTodoistJson(getRes.body, listId);
    }

    async deleteTask(listId, taskId) {
        const res = await this._client.delete(`${REST_BASE}/tasks/${encodeURIComponent(taskId)}`);
        if (res.status !== 204 && res.status !== 200)
            this._checkStatus(res, 204);
    }

    async completeTask(listId, taskId) {
        const res = await this._client.post(`${REST_BASE}/tasks/${encodeURIComponent(taskId)}/close`, {});
        if (res.status !== 204 && res.status !== 200)
            this._checkStatus(res, 204);
    }

    async uncompleteTask(listId, taskId) {
        const res = await this._client.post(`${REST_BASE}/tasks/${encodeURIComponent(taskId)}/reopen`, {});
        if (res.status !== 204 && res.status !== 200)
            this._checkStatus(res, 204);
    }

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
