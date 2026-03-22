'use strict';

import GLib from 'gi://GLib';
import { TaskModel } from './task-model.js';

const CACHE_VERSION = 1;

/**
 * Backend-agnostic sync engine for task data.
 *
 * Manages merged task list/task cache from multiple BackendAdapters,
 * delta sync, polling, offline disk cache, and CRUD routing.
 *
 * SyncEngine does NOT import any backend-specific modules — all backend
 * logic lives inside BackendAdapter implementations passed via constructor.
 */
export class SyncEngine {
    constructor(backends, settings = null) {
        this._backends = backends;
        this._settings = settings;

        // Cache — merged across all backends
        this._taskLists = [];             // [{id, displayName, _backendId, ...}]
        this._tasks = new Map();           // listId → [task, ...]
        this._listBackendMap = new Map();  // listId → backendId (for CRUD routing)
        this._deltaTokens = new Map();     // 'backendId:listId' → deltaLink/token

        // Offline state
        this._isOffline = false;
        this._lastSyncTime = null;

        // Polling
        this._pollSourceId = 0;
        this._destroyed = false;

        // Optimistic update operation queue
        this._opQueue = [];
        this._processingQueue = false;
        this._queueTimerIds = [];

        // Signal handlers
        this._signals = {
            'tasks-changed': [],
            'lists-changed': [],
            'auth-required': [],
            'offline': [],
            'online': [],
            'operation-failed': [],
        };
    }

    // ── Initialization ──────────────────────────────────────────────

    async initialize() {
        const hadCache = this._loadCacheFromDisk();
        if (hadCache) {
            this._emit('lists-changed');
            this._emit('tasks-changed');
        }

        this._loadDeltaTokens();

        try {
            await this._fetchAllFromBackends();
            this._saveCacheToDisk();

            if (this._isOffline) {
                this._isOffline = false;
                this._emit('online');
            }

            this._emit('lists-changed');
            this._emit('tasks-changed');
        } catch (e) {
            if (this._isNetworkError(e)) {
                if (!this._isOffline) {
                    this._isOffline = true;
                    this._emit('offline');
                }
                // Keep showing cached data — no re-emit needed
                if (!hadCache)
                    console.error('[sync-engine] initialize: offline with no cache');
            } else if (e.message === 'auth-required') {
                this._emit('auth-required');
            } else {
                console.error(`[sync-engine] initialize error: ${e.message}`);
            }
        }
    }

    // ── Sync ────────────────────────────────────────────────────────

    async sync() {
        try {
            let changed = false;

            for (const [backendId, backend] of this._backends) {
                if (!backend.isAuthenticated()) continue;

                const backendLists = this._taskLists.filter(
                    l => this._listBackendMap.get(l.id) === backendId
                );

                for (const list of backendLists) {
                    if (backend.supportsDelta()) {
                        const didChange = await this._deltaSync(backend, list.id);
                        if (didChange) changed = true;
                    }
                }
            }

            if (changed) {
                this._saveCacheToDisk();
                this._emit('tasks-changed');
            }

            // Came back online
            if (this._isOffline) {
                this._isOffline = false;
                this._emit('online');
            }
        } catch (e) {
            if (this._isNetworkError(e)) {
                if (!this._isOffline) {
                    this._isOffline = true;
                    this._emit('offline');
                }
            } else if (e.message === 'auth-required') {
                this._emit('auth-required');
            } else {
                console.error(`[sync-engine] sync error: ${e.message}`);
            }
        }
    }

    async fullSync() {
        try {
            await this._fetchAllFromBackends();
            this._saveCacheToDisk();

            if (this._isOffline) {
                this._isOffline = false;
                this._emit('online');
            }

            this._emit('lists-changed');
            this._emit('tasks-changed');
        } catch (e) {
            if (this._isNetworkError(e)) {
                if (!this._isOffline) {
                    this._isOffline = true;
                    this._emit('offline');
                }
            } else if (e.message === 'auth-required') {
                this._emit('auth-required');
            } else {
                console.error(`[sync-engine] fullSync error: ${e.message}`);
            }
        }
    }

    // ── Accessors ───────────────────────────────────────────────────

    getTaskLists() {
        return this._taskLists;
    }

    getTasks(listId) {
        return this._tasks.get(listId) || [];
    }

    getLastSyncTime() {
        return this._lastSyncTime;
    }

    get isOffline() {
        return this._isOffline;
    }

    // ── Task List CRUD ─────────────────────────────────────────────

    async createTaskList(backendId, name) {
        const backend = this._backends.get(backendId);
        if (!backend)
            throw new Error(`Backend '${backendId}' not registered`);

        const tempId = `_temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const placeholderList = {id: tempId, displayName: name, _backendId: backendId};
        this._taskLists.push(placeholderList);
        this._listBackendMap.set(tempId, backendId);
        this._tasks.set(tempId, []);
        this._saveCacheToDisk();
        this._emit('lists-changed');

        this._enqueueOperation({
            description: `Create list "${name}"`,
            execute: async () => {
                const list = await backend.createTaskList(name);
                const idx = this._taskLists.findIndex(l => l.id === tempId);
                if (idx >= 0)
                    this._taskLists[idx] = list;
                this._listBackendMap.delete(tempId);
                this._listBackendMap.set(list.id, backendId);
                const tempTasks = this._tasks.get(tempId) || [];
                this._tasks.delete(tempId);
                this._tasks.set(list.id, tempTasks);
                this._saveCacheToDisk();
                this._emit('lists-changed');
            },
            rollback: () => {
                this._taskLists = this._taskLists.filter(l => l.id !== tempId);
                this._tasks.delete(tempId);
                this._listBackendMap.delete(tempId);
                this._saveCacheToDisk();
                this._emit('lists-changed');
            },
        });

        return placeholderList;
    }

    async renameTaskList(listId, newName) {
        const backend = this._getBackendForList(listId);

        const idx = this._taskLists.findIndex(l => l.id === listId);
        const oldName = idx >= 0 ? this._taskLists[idx].displayName : newName;

        if (idx >= 0)
            this._taskLists[idx].displayName = newName;
        this._saveCacheToDisk();
        this._emit('lists-changed');

        this._enqueueOperation({
            description: `Rename list to "${newName}"`,
            execute: () => backend.renameTaskList(listId, newName),
            rollback: () => {
                const i = this._taskLists.findIndex(l => l.id === listId);
                if (i >= 0)
                    this._taskLists[i].displayName = oldName;
                this._saveCacheToDisk();
                this._emit('lists-changed');
            },
        });
    }

    async deleteTaskList(listId) {
        const backend = this._getBackendForList(listId);
        const backendId = backend.id;

        const removedList = this._taskLists.find(l => l.id === listId);
        const removedTasks = this._tasks.get(listId) || [];
        const removedDeltaKey = `${backendId}:${listId}`;
        const removedDeltaToken = this._deltaTokens.get(removedDeltaKey);

        this._taskLists = this._taskLists.filter(l => l.id !== listId);
        this._tasks.delete(listId);
        this._listBackendMap.delete(listId);
        this._deltaTokens.delete(removedDeltaKey);
        this._saveDeltaTokens();
        this._saveCacheToDisk();
        this._emit('lists-changed');

        this._enqueueOperation({
            description: `Delete list "${removedList?.displayName || listId}"`,
            execute: () => backend.deleteTaskList(listId),
            rollback: () => {
                if (removedList)
                    this._taskLists.push(removedList);
                this._tasks.set(listId, removedTasks);
                this._listBackendMap.set(listId, backendId);
                if (removedDeltaToken)
                    this._deltaTokens.set(removedDeltaKey, removedDeltaToken);
                this._saveDeltaTokens();
                this._saveCacheToDisk();
                this._emit('lists-changed');
            },
        });
    }

    // ── Task CRUD ────────────────────────────────────────────────────

    async createTask(listId, title, opts = {}) {
        const backend = this._getBackendForList(listId);

        const tempId = `_temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const placeholderTask = {
            id: tempId,
            listId,
            title,
            status: 'notStarted',
            importance: opts.importance || 'normal',
            dueDateTime: opts.dueDateTime || null,
            checklistItems: [],
            _isOptimistic: true,
        };
        Object.defineProperties(placeholderTask, {
            '_uid':      { get() { return this.id; } },
            '_due':      { get() { return this.dueDateTime; } },
            '_taskList': { get() { return this.listId; } },
        });
        const tasks = this._tasks.get(listId) || [];
        tasks.push(placeholderTask);
        this._tasks.set(listId, tasks);
        this._saveCacheToDisk();
        this._emit('tasks-changed');

        this._enqueueOperation({
            description: `Create task "${title}"`,
            execute: async () => {
                const realTask = await backend.createTask(listId, title, opts);
                const current = this._tasks.get(listId) || [];
                const idx = current.findIndex(t => t.id === tempId);
                if (idx >= 0)
                    current[idx] = realTask;
                this._tasks.set(listId, current);
                this._saveCacheToDisk();
                this._emit('tasks-changed');
            },
            rollback: () => {
                const current = this._tasks.get(listId) || [];
                this._tasks.set(listId, current.filter(t => t.id !== tempId));
                this._saveCacheToDisk();
                this._emit('tasks-changed');
            },
        });

        return placeholderTask;
    }

    async completeTask(listId, taskId) {
        const backend = this._getBackendForList(listId);

        const tasks = this._tasks.get(listId) || [];
        const task = tasks.find(t => t.id === taskId);
        const oldStatus = task ? task.status : 'notStarted';
        const taskTitle = task ? task.title : taskId;

        if (task) task.status = 'completed';
        this._saveCacheToDisk();
        this._emit('tasks-changed');

        this._enqueueOperation({
            description: `Complete task "${taskTitle}"`,
            execute: async () => {
                const updated = await backend.completeTask(listId, taskId);
                this._updateTaskInCache(listId, updated);
                this._saveCacheToDisk();
            },
            rollback: () => {
                const current = this._tasks.get(listId) || [];
                const t = current.find(t => t.id === taskId);
                if (t) t.status = oldStatus;
                this._saveCacheToDisk();
                this._emit('tasks-changed');
            },
        });
    }

    async uncompleteTask(listId, taskId) {
        const backend = this._getBackendForList(listId);

        const tasks = this._tasks.get(listId) || [];
        const task = tasks.find(t => t.id === taskId);
        const oldStatus = task ? task.status : 'completed';
        const taskTitle = task ? task.title : taskId;

        if (task) task.status = 'notStarted';
        this._saveCacheToDisk();
        this._emit('tasks-changed');

        this._enqueueOperation({
            description: `Uncomplete task "${taskTitle}"`,
            execute: async () => {
                const updated = await backend.uncompleteTask(listId, taskId);
                this._updateTaskInCache(listId, updated);
                this._saveCacheToDisk();
            },
            rollback: () => {
                const current = this._tasks.get(listId) || [];
                const t = current.find(t => t.id === taskId);
                if (t) t.status = oldStatus;
                this._saveCacheToDisk();
                this._emit('tasks-changed');
            },
        });
    }

    async updateTaskTitle(listId, taskId, newTitle) {
        const backend = this._getBackendForList(listId);

        const tasks = this._tasks.get(listId) || [];
        const task = tasks.find(t => t.id === taskId);
        const oldTitle = task ? task.title : newTitle;

        if (task) task.title = newTitle;
        this._saveCacheToDisk();
        this._emit('tasks-changed');

        this._enqueueOperation({
            description: `Rename task to "${newTitle}"`,
            execute: () => backend.updateTaskTitle(listId, taskId, newTitle),
            rollback: () => {
                const current = this._tasks.get(listId) || [];
                const t = current.find(t => t.id === taskId);
                if (t) t.title = oldTitle;
                this._saveCacheToDisk();
                this._emit('tasks-changed');
            },
        });
    }

    async updateTaskDueDate(listId, taskId, dueDate) {
        const backend = this._getBackendForList(listId);

        const tasks = this._tasks.get(listId) || [];
        const task = tasks.find(t => t.id === taskId);
        const oldDueDate = task ? task.dueDateTime : null;
        const taskTitle = task ? task.title : taskId;

        if (task) task.dueDateTime = dueDate;
        this._saveCacheToDisk();
        this._emit('tasks-changed');

        this._enqueueOperation({
            description: `Update due date for "${taskTitle}"`,
            execute: () => backend.updateTaskDueDate(listId, taskId, dueDate),
            rollback: () => {
                const current = this._tasks.get(listId) || [];
                const t = current.find(t => t.id === taskId);
                if (t) t.dueDateTime = oldDueDate;
                this._saveCacheToDisk();
                this._emit('tasks-changed');
            },
        });
    }

    async deleteTask(listId, taskId) {
        const backend = this._getBackendForList(listId);

        const tasks = this._tasks.get(listId) || [];
        const removedTask = tasks.find(t => t.id === taskId);

        this._tasks.set(listId, tasks.filter(t => t.id !== taskId));
        this._saveCacheToDisk();
        this._emit('tasks-changed');

        this._enqueueOperation({
            description: `Delete task "${removedTask?.title || taskId}"`,
            execute: () => backend.deleteTask(listId, taskId),
            rollback: () => {
                if (removedTask) {
                    const current = this._tasks.get(listId) || [];
                    current.push(removedTask);
                    this._tasks.set(listId, current);
                    this._saveCacheToDisk();
                    this._emit('tasks-changed');
                }
            },
        });
    }

    async createSubtask(listId, taskId, title) {
        const backend = this._getBackendForList(listId);

        const tempId = `_temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const tasks = this._tasks.get(listId) || [];
        const parentTask = tasks.find(t => t.id === taskId);
        if (parentTask) {
            if (!parentTask.checklistItems) parentTask.checklistItems = [];
            parentTask.checklistItems.push({
                id: tempId,
                displayName: title,
                isChecked: false,
                checkedDateTime: null,
            });
        }
        this._saveCacheToDisk();
        this._emit('tasks-changed');

        this._enqueueOperation({
            description: `Create subtask "${title}"`,
            execute: async () => {
                await backend.createSubtask(listId, taskId, title);
                await this.fullSync();
            },
            rollback: () => {
                const current = this._tasks.get(listId) || [];
                const parent = current.find(t => t.id === taskId);
                if (parent && parent.checklistItems) {
                    parent.checklistItems = parent.checklistItems.filter(
                        ci => ci.id !== tempId
                    );
                }
                this._saveCacheToDisk();
                this._emit('tasks-changed');
            },
        });
    }

    async deleteSubtask(listId, taskId, subtaskId) {
        const backend = this._getBackendForList(listId);
        const tasks = this._tasks.get(listId) || [];
        const task = tasks.find(t => t.id === taskId);

        let removedItem = null;
        let removedIndex = -1;
        if (task && task.checklistItems) {
            removedIndex = task.checklistItems.findIndex(ci => ci.id === subtaskId);
            if (removedIndex !== -1)
                removedItem = task.checklistItems.splice(removedIndex, 1)[0];
        }

        this._saveCacheToDisk();
        this._emit('tasks-changed');

        this._enqueueOperation({
            description: `Delete subtask "${removedItem?.displayName || subtaskId}"`,
            execute: () => backend.deleteSubtask(listId, taskId, subtaskId),
            rollback: () => {
                if (removedItem && task && task.checklistItems) {
                    task.checklistItems.splice(removedIndex, 0, removedItem);
                    this._saveCacheToDisk();
                    this._emit('tasks-changed');
                }
            },
        });
    }

    async toggleChecklistItem(listId, taskId, itemId) {
        const backend = this._getBackendForList(listId);
        const tasks = this._tasks.get(listId) || [];
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        const item = task.checklistItems?.find(ci => ci.id === itemId);
        if (!item) return;

        const oldIsChecked = item.isChecked;
        const oldCheckedDateTime = item.checkedDateTime;
        const newIsChecked = !item.isChecked;
        const itemName = item.displayName || itemId;

        item.isChecked = newIsChecked;
        item.checkedDateTime = newIsChecked ? new Date() : null;
        this._saveCacheToDisk();
        this._emit('tasks-changed');

        this._enqueueOperation({
            description: `Toggle subtask "${itemName}"`,
            execute: async () => {
                const updated = await backend.toggleChecklistItem(
                    listId, taskId, itemId, {isChecked: newIsChecked}
                );
                item.isChecked = updated.isChecked;
                item.checkedDateTime = updated.checkedDateTime
                    ? new Date(updated.checkedDateTime)
                    : null;
                this._saveCacheToDisk();
            },
            rollback: () => {
                const current = this._tasks.get(listId) || [];
                const t = current.find(t => t.id === taskId);
                const ci = t?.checklistItems?.find(ci => ci.id === itemId);
                if (ci) {
                    ci.isChecked = oldIsChecked;
                    ci.checkedDateTime = oldCheckedDateTime;
                }
                this._saveCacheToDisk();
                this._emit('tasks-changed');
            },
        });
    }

    // ── Polling ─────────────────────────────────────────────────────

    startPolling(intervalSeconds) {
        this.stopPolling();
        this._pollSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, intervalSeconds, () => {
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                this.sync().catch(e =>
                    console.error(`[sync-engine] poll error: ${e.message}`)
                );
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    stopPolling() {
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = 0;
        }
    }

    // ── Signals ─────────────────────────────────────────────────────

    connect(signal, callback) {
        if (this._signals[signal])
            this._signals[signal].push(callback);
    }

    // ── Lifecycle ───────────────────────────────────────────────────

    destroy() {
        this._destroyed = true;
        this.stopPolling();

            for (const timerId of this._queueTimerIds) {
            GLib.source_remove(timerId);
        }
        this._queueTimerIds = [];
        this._opQueue = [];
        this._processingQueue = false;

        this._tasks.clear();
        this._taskLists = [];
        this._deltaTokens.clear();
        this._listBackendMap.clear();
    }

    // ── Private: Optimistic Operation Queue ────────────────────────

    _delay(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._queueTimerIds = this._queueTimerIds.filter(t => t !== id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._queueTimerIds.push(id);
        });
    }

    _enqueueOperation({description, execute, rollback, retries = 3, baseDelay = 1000}) {
        this._opQueue.push({description, execute, rollback, retries, baseDelay, attempt: 0});
        this._processQueue();
    }

    async _processQueue() {
        if (this._processingQueue) return;
        this._processingQueue = true;

        while (this._opQueue.length > 0) {
            if (this._destroyed) break;

            const op = this._opQueue[0];
            try {
                await op.execute();
                this._opQueue.shift(); // success — remove from queue
            } catch (e) {
                op.attempt++;
                console.warn(
                    `[sync-engine] Operation failed (attempt ${op.attempt}/${op.retries}): ` +
                    `${op.description} — ${e.message}`
                );

                if (op.attempt >= op.retries) {
                    this._opQueue.shift();
                    try {
                        op.rollback();
                    } catch (re) {
                        console.error(`[sync-engine] Rollback error: ${re.message}`);
                    }
                    this._emit('operation-failed', op.description);
                } else {
                    // Exponential backoff: 1s, 2s, 4s, ...
                    const delay = op.baseDelay * Math.pow(2, op.attempt - 1);
                    await this._delay(delay);
                }
            }
        }

        this._processingQueue = false;
    }

    // ── Private: Backend Routing ────────────────────────────────────

    _getBackendForList(listId) {
        const backendId = this._listBackendMap.get(listId);
        if (!backendId)
            throw new Error(`No backend found for list ${listId}`);
        const backend = this._backends.get(backendId);
        if (!backend)
            throw new Error(`Backend '${backendId}' not registered`);
        return backend;
    }

    // ── Private: Network Fetch ──────────────────────────────────────

    async _fetchAllFromBackends() {
        const newLists = [];
        const newTasks = new Map();
        const newListBackendMap = new Map();

        for (const [backendId, backend] of this._backends) {
            if (!backend.isAuthenticated()) continue;

            const lists = await backend.listTaskLists();
            for (const list of lists) {
                newListBackendMap.set(list.id, backendId);
                newLists.push(list);
            }

            for (const list of lists) {
                const tasks = await backend.listTasks(list.id);
                newTasks.set(list.id, tasks);
            }
        }

        this._taskLists = newLists;
        this._tasks = newTasks;
        this._listBackendMap = newListBackendMap;
        this._lastSyncTime = new Date();
    }

    // ── Private: Delta Sync ─────────────────────────────────────────

    async _deltaSync(backend, listId) {
        const tokenKey = `${backend.id}:${listId}`;
        const deltaToken = this._deltaTokens.get(tokenKey) || null;
        let result;

        try {
            result = await backend.deltaQuery(listId, deltaToken);
        } catch (e) {
            // Delta token expired (e.g. 410 Gone) — full refresh for this list
            if (deltaToken) {
                console.log(`[sync-engine] Delta token invalid for ${backend.id}:${listId}, doing full refresh`);
                this._deltaTokens.delete(tokenKey);
                result = await backend.deltaQuery(listId, null);
                this._tasks.set(listId, result.tasks.filter(t => !t._removed));
                if (result.deltaLink)
                    this._deltaTokens.set(tokenKey, result.deltaLink);
                this._saveDeltaTokens();
                return true;
            }
            throw e;
        }

        if (result.tasks.length === 0) {
            if (result.deltaLink)
                this._deltaTokens.set(tokenKey, result.deltaLink);
            return false;
        }

            const current = this._tasks.get(listId) || [];
        const taskMap = new Map(current.map(t => [t.id, t]));

        for (const t of result.tasks) {
            if (t._removed)
                taskMap.delete(t.id);
            else
                taskMap.set(t.id, t);
        }

        this._tasks.set(listId, [...taskMap.values()]);

        if (result.deltaLink)
            this._deltaTokens.set(tokenKey, result.deltaLink);

        this._saveDeltaTokens();
        return true;
    }

    // ── Private: Delta Token Persistence ────────────────────────────

    _loadDeltaTokens() {
        if (!this._settings) return;

        for (const [backendId, backend] of this._backends) {
            const key = backend.getDeltaTokenKey();
            if (!key) continue;

            try {
                const json = this._settings.get_string(key);
                if (json) {
                    const obj = JSON.parse(json);
                    for (const [listId, token] of Object.entries(obj)) {
                        if (typeof token === 'string' && token.length > 0)
                            this._deltaTokens.set(`${backendId}:${listId}`, token);
                    }
                }
            } catch {
                // Corrupted — force full sync for this backend
                try {
                    this._settings.set_string(key, '');
                } catch { /* ignore */ }
            }
        }
    }

    _saveDeltaTokens() {
        if (!this._settings) return;

            const byBackend = new Map();
        for (const [compositeKey, token] of this._deltaTokens) {
            const sepIdx = compositeKey.indexOf(':');
            if (sepIdx < 0) continue;
            const backendId = compositeKey.substring(0, sepIdx);
            const listId = compositeKey.substring(sepIdx + 1);

            if (!byBackend.has(backendId))
                byBackend.set(backendId, {});
            byBackend.get(backendId)[listId] = token;
        }

        for (const [backendId, backend] of this._backends) {
            const key = backend.getDeltaTokenKey();
            if (!key) continue;

            try {
                const obj = byBackend.get(backendId) || {};
                this._settings.set_string(key, JSON.stringify(obj));
            } catch { /* ignore */ }
        }
    }

    // ── Private: Disk Cache ─────────────────────────────────────────

    _getCachePath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'docket', 'task-cache.json']);
    }

    _loadCacheFromDisk() {
        try {
            const path = this._getCachePath();
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok) return false;

            const decoder = new TextDecoder('utf-8');
            const json = decoder.decode(contents);
            const data = JSON.parse(json);

            if (data.version !== CACHE_VERSION) return false;

            this._taskLists = Array.isArray(data.taskLists) ? data.taskLists : [];

            this._listBackendMap.clear();
            for (const list of this._taskLists) {
                if (list._backendId)
                    this._listBackendMap.set(list.id, list._backendId);
            }

            this._tasks.clear();
            if (data.tasks && typeof data.tasks === 'object') {
                for (const [listId, serializedTasks] of Object.entries(data.tasks)) {
                    if (!Array.isArray(serializedTasks)) continue;
                    const tasks = serializedTasks.map(t => TaskModel.deserialize(t));
                    this._tasks.set(listId, tasks);
                }
            }

            if (data.lastSync)
                this._lastSyncTime = new Date(data.lastSync);

            console.log(`[sync-engine] Loaded cache: ${this._taskLists.length} lists, ${this._tasks.size} task groups`);
            return true;
        } catch (e) {
            // Corrupt or missing cache — start fresh
            console.log(`[sync-engine] No cache loaded: ${e.message}`);
            return false;
        }
    }

    _saveCacheToDisk() {
        try {
            const path = this._getCachePath();
            const dir = GLib.path_get_dirname(path);
            GLib.mkdir_with_parents(dir, 0o755);

            const tasksObj = {};
            for (const [listId, tasks] of this._tasks) {
                tasksObj[listId] = tasks.map(t => TaskModel.serialize(t));
            }

            const data = {
                version: CACHE_VERSION,
                lastSync: this._lastSyncTime ? this._lastSyncTime.toISOString() : null,
                taskLists: this._taskLists,
                tasks: tasksObj,
            };

            const json = JSON.stringify(data);
            GLib.file_set_contents(path, json);
        } catch (e) {
            // Cache save failure is non-fatal
            console.error(`[sync-engine] Failed to save cache: ${e.message}`);
        }
    }

    // ── Private: Cache Helpers ──────────────────────────────────────

    _updateTaskInCache(listId, updated) {
        const tasks = this._tasks.get(listId) || [];
        const idx = tasks.findIndex(t => t.id === updated.id);
        if (idx >= 0)
            tasks[idx] = updated;
        else
            tasks.push(updated);
        this._tasks.set(listId, tasks);
    }

    // ── Private: Network Error Detection ────────────────────────────

    _isNetworkError(e) {
        const msg = (e.message || '').toLowerCase();
        return msg.includes('network') ||
               msg.includes('resolve') ||
               msg.includes('connect') ||
               msg.includes('timeout') ||
               msg.includes('unreachable') ||
               msg.includes('host not found') ||
               msg.includes('could not connect') ||
               msg.includes('no route') ||
               msg.includes('dns');
    }

    // ── Private: Signal Emission ────────────────────────────────────

    _emit(signal, ...args) {
        if (this._signals[signal]) {
            for (const cb of this._signals[signal]) {
                try {
                    cb(...args);
                } catch (e) {
                    console.error(`[sync-engine] signal '${signal}' handler error: ${e.message}`);
                }
            }
        }
    }
}
