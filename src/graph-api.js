'use strict';

import { GraphHttpClient } from './graph-client.js';
import { TaskModel } from './task-model.js';

const BASE = 'https://graph.microsoft.com/v1.0';

/**
 * High-level Microsoft Graph To Do API wrapper.
 */
export class GraphApi {
    constructor(authManager) {
        this._client = new GraphHttpClient(authManager);
    }

    /**
     * List all task lists.
     * @returns {Promise<object[]>} Array of {id, displayName, wellknownListName, isOwner, isShared}
     */
    async listTaskLists() {
        const res = await this._client.get(`${BASE}/me/todo/lists`);
        this._checkStatus(res, 200);
        return res.body.value;
    }

    /**
     * List tasks in a task list, with checklistItems expanded.
     * @param {string} listId
     * @returns {Promise<object[]>} Array of internal task model objects
     */
    async listTasks(listId) {
        let tasks = [];
        let url = `${BASE}/me/todo/lists/${listId}/tasks?$expand=checklistItems`;

        // Handle pagination
        while (url) {
            const res = await this._client.get(url);
            this._checkStatus(res, 200);
            for (const g of res.body.value)
                tasks.push(TaskModel.fromGraphJson(g, listId));
            url = res.body['@odata.nextLink'] || null;
        }

        return tasks;
    }

    /**
     * Create a task in a task list.
     * @param {string} listId
     * @param {object} taskData - Graph API task creation body
     * @returns {Promise<object>} Created task (internal model)
     */
    async createTask(listId, taskData) {
        const res = await this._client.post(
            `${BASE}/me/todo/lists/${listId}/tasks`, taskData
        );
        this._checkStatus(res, 201);
        return TaskModel.fromGraphJson(res.body, listId);
    }

    /**
     * Update a task.
     * @param {string} listId
     * @param {string} taskId
     * @param {object} patch - Graph API task PATCH body
     * @returns {Promise<object>} Updated task (internal model)
     */
    async updateTask(listId, taskId, patch) {
        const res = await this._client.patch(
            `${BASE}/me/todo/lists/${listId}/tasks/${taskId}`, patch
        );
        this._checkStatus(res, 200);
        return TaskModel.fromGraphJson(res.body, listId);
    }

    /**
     * Delete a task.
     * @param {string} listId
     * @param {string} taskId
     */
    async deleteTask(listId, taskId) {
        const res = await this._client.delete(
            `${BASE}/me/todo/lists/${listId}/tasks/${taskId}`
        );
        this._checkStatus(res, 204);
    }

    /**
     * Create a checklist item on a task.
     * @param {string} listId
     * @param {string} taskId
     * @param {object} item - {displayName: string}
     * @returns {Promise<object>} Created checklist item
     */
    async createChecklistItem(listId, taskId, item) {
        const res = await this._client.post(
            `${BASE}/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`,
            item
        );
        this._checkStatus(res, 201);
        return res.body;
    }

    /**
     * Update a checklist item.
     * @param {string} listId
     * @param {string} taskId
     * @param {string} itemId
     * @param {object} patch - {isChecked: boolean} or other fields
     * @returns {Promise<object>} Updated checklist item
     */
    async updateChecklistItem(listId, taskId, itemId, patch) {
        const res = await this._client.patch(
            `${BASE}/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${itemId}`,
            patch
        );
        this._checkStatus(res, 200);
        return res.body;
    }

    /**
     * Delta query for a task list.
     * @param {string} listId
     * @param {string} [deltaToken] - Previous deltaLink URL (full URL)
     * @returns {Promise<{tasks: object[], deltaLink: string}>}
     */
    async deltaQuery(listId, deltaToken = null) {
        let url = deltaToken || `${BASE}/me/todo/lists/${listId}/tasks/delta`;
        let tasks = [];

        while (url) {
            const res = await this._client.get(url);
            this._checkStatus(res, 200);

            for (const g of res.body.value) {
                // Delta responses may include @removed for deleted tasks
                if (g['@removed']) {
                    tasks.push({id: g.id, _removed: true});
                } else {
                    tasks.push(TaskModel.fromGraphJson(g, listId));
                }
            }

            if (res.body['@odata.deltaLink']) {
                return {tasks, deltaLink: res.body['@odata.deltaLink']};
            }
            url = res.body['@odata.nextLink'] || null;
        }

        // Should not reach here — last page always has deltaLink
        return {tasks, deltaLink: null};
    }

    destroy() {
        this._client.destroy();
    }

    _checkStatus(res, expected) {
        if (res.status !== expected)
            throw new Error(`Graph API error: expected ${expected}, got ${res.status}: ${JSON.stringify(res.body).substring(0, 200)}`);
    }
}
