'use strict';

import { GraphHttpClient } from './graph-client.js';
import { TaskModel } from './task-model.js';

const BASE = 'https://graph.microsoft.com/v1.0';

export class GraphApi {
    constructor(authManager) {
        this._client = new GraphHttpClient(authManager);
    }

    async listTaskLists() {
        const res = await this._client.get(`${BASE}/me/todo/lists`);
        this._checkStatus(res, 200);
        return Array.isArray(res.body?.value) ? res.body.value : [];
    }

    async listTasks(listId) {
        let tasks = [];
        let url = `${BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks?$expand=checklistItems`;

        while (url) {
            const res = await this._client.get(url);
            this._checkStatus(res, 200);
            const items = Array.isArray(res.body?.value) ? res.body.value : [];
            for (const g of items)
                tasks.push(TaskModel.fromGraphJson(g, listId));
            const nextUrl = res.body['@odata.nextLink'] || null;
            if (nextUrl && !nextUrl.startsWith('https://graph.microsoft.com/'))
                throw new Error(`Untrusted nextLink: ${nextUrl.substring(0, 80)}`);
            url = nextUrl;
        }

        return tasks;
    }

    async createTask(listId, taskData) {
        const res = await this._client.post(
            `${BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks`, taskData
        );
        this._checkStatus(res, 201);
        return TaskModel.fromGraphJson(res.body, listId);
    }

    async updateTask(listId, taskId, patch) {
        const res = await this._client.patch(
            `${BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, patch
        );
        this._checkStatus(res, 200);
        return TaskModel.fromGraphJson(res.body, listId);
    }

    async deleteTask(listId, taskId) {
        const res = await this._client.delete(
            `${BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`
        );
        this._checkStatus(res, 204);
    }

    async createChecklistItem(listId, taskId, item) {
        const res = await this._client.post(
            `${BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems`,
            item
        );
        this._checkStatus(res, 201);
        return res.body;
    }

    async updateChecklistItem(listId, taskId, itemId, patch) {
        const res = await this._client.patch(
            `${BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems/${encodeURIComponent(itemId)}`,
            patch
        );
        this._checkStatus(res, 200);
        return res.body;
    }

    async deleteChecklistItem(listId, taskId, itemId) {
        const res = await this._client.delete(
            `${BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems/${encodeURIComponent(itemId)}`
        );
        this._checkStatus(res, 204);
    }

    async createTaskList(displayName) {
        const res = await this._client.post(`${BASE}/me/todo/lists`, {displayName});
        this._checkStatus(res, 201);
        return res.body;
    }

    async renameTaskList(listId, displayName) {
        const res = await this._client.patch(
            `${BASE}/me/todo/lists/${encodeURIComponent(listId)}`, {displayName}
        );
        this._checkStatus(res, 200);
        return res.body;
    }

    async deleteTaskList(listId) {
        const res = await this._client.delete(
            `${BASE}/me/todo/lists/${encodeURIComponent(listId)}`
        );
        this._checkStatus(res, 204);
    }

    async deltaQuery(listId, deltaToken = null) {
        let url = deltaToken || `${BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`;
        let tasks = [];

        while (url) {
            const res = await this._client.get(url);
            this._checkStatus(res, 200);

            const items = Array.isArray(res.body?.value) ? res.body.value : [];
            for (const g of items) {
                // Delta responses may include @removed for deleted tasks
                if (g['@removed']) {
                    tasks.push({id: g.id, _removed: true});
                } else {
                    tasks.push(TaskModel.fromGraphJson(g, listId));
                }
            }

            if (res.body['@odata.deltaLink']) {
                const deltaLink = res.body['@odata.deltaLink'];
                if (!deltaLink.startsWith('https://graph.microsoft.com/'))
                    throw new Error(`Untrusted deltaLink: ${deltaLink.substring(0, 80)}`);
                return {tasks, deltaLink};
            }
            const nextUrl = res.body['@odata.nextLink'] || null;
            if (nextUrl && !nextUrl.startsWith('https://graph.microsoft.com/'))
                throw new Error(`Untrusted nextLink: ${nextUrl.substring(0, 80)}`);
            url = nextUrl;
        }

        // Should not reach here — last page always has deltaLink
        return {tasks, deltaLink: null};
    }

    destroy() {
        this._client.destroy();
    }

    _checkStatus(res, expected) {
        if (res.status !== expected) {
            const code = res.body?.error?.code || 'unknown';
            throw new Error(`Graph API error: expected ${expected}, got ${res.status} (${code})`);
        }
    }
}
