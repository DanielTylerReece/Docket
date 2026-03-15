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
    /**
     * @param {Map<string, BackendAdapter>} backends - backendId → adapter instance
     * @param {Gio.Settings|null} settings - GSettings instance (null for tests)
     */
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

        // Signal handlers
        this._signals = {
            'tasks-changed': [],
            'lists-changed': [],
            'auth-required': [],
            'offline': [],
            'online': [],
        };
    }

    // ── Initialization ──────────────────────────────────────────────

    /**
     * Load disk cache first (instant UI), then fetch from network.
     * On network failure, keeps showing cached data and emits 'offline'.
     */
    async initialize() {
        // Show cached data immediately
        const hadCache = this._loadCacheFromDisk();
        if (hadCache) {
            this._emit('lists-changed');
            this._emit('tasks-changed');
        }

        // Load persisted delta tokens
        this._loadDeltaTokens();

        // Try network fetch
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

    /**
     * Delta sync all lists across all authenticated backends.
     */
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

    /**
     * Full re-fetch from all backends, replacing the cache entirely.
     */
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

    /** @returns {object[]} Cached task lists (merged from all backends) */
    getTaskLists() {
        return this._taskLists;
    }

    /**
     * @param {string} listId
     * @returns {object[]} Cached tasks for the given list
     */
    getTasks(listId) {
        return this._tasks.get(listId) || [];
    }

    /** @returns {Date|null} Last successful network sync timestamp */
    getLastSyncTime() {
        return this._lastSyncTime;
    }

    /** @returns {boolean} Whether we're currently in offline mode */
    get isOffline() {
        return this._isOffline;
    }

    // ── Task List CRUD ─────────────────────────────────────────────

    /**
     * Create a new task list in the specified backend.
     * @param {string} backendId - Which backend to create the list in
     * @param {string} name - Display name for the new list
     * @returns {Promise<object>} Created task list
     */
    async createTaskList(backendId, name) {
        const backend = this._backends.get(backendId);
        if (!backend)
            throw new Error(`Backend '${backendId}' not registered`);
        const list = await backend.createTaskList(name);
        this._taskLists.push(list);
        this._listBackendMap.set(list.id, backendId);
        this._tasks.set(list.id, []);
        this._saveCacheToDisk();
        this._emit('lists-changed');
        return list;
    }

    /**
     * Rename a task list.
     * @param {string} listId
     * @param {string} newName
     * @returns {Promise<object>} Updated task list
     */
    async renameTaskList(listId, newName) {
        const backend = this._getBackendForList(listId);
        const updated = await backend.renameTaskList(listId, newName);
        // Update local cache
        const idx = this._taskLists.findIndex(l => l.id === listId);
        if (idx >= 0) {
            this._taskLists[idx].displayName = newName;
        }
        this._saveCacheToDisk();
        this._emit('lists-changed');
        return updated;
    }

    /**
     * Delete a task list.
     * @param {string} listId
     */
    async deleteTaskList(listId) {
        const backend = this._getBackendForList(listId);
        await backend.deleteTaskList(listId);
        // Remove from local cache
        this._taskLists = this._taskLists.filter(l => l.id !== listId);
        this._tasks.delete(listId);
        this._listBackendMap.delete(listId);
        // Clean up delta tokens for this list
        const backendId = backend.id;
        this._deltaTokens.delete(`${backendId}:${listId}`);
        this._saveDeltaTokens();
        this._saveCacheToDisk();
        this._emit('lists-changed');
    }

    // ── Task CRUD ────────────────────────────────────────────────────

    /**
     * Create a task in the specified list, routed to the correct backend.
     * @param {string} listId
     * @param {string} title
     * @param {object} [opts] - Optional fields (dueDateTime, importance, etc.)
     * @returns {Promise<object>} Created task (internal model)
     */
    async createTask(listId, title, opts = {}) {
        const backend = this._getBackendForList(listId);
        const task = await backend.createTask(listId, title, opts);
        const tasks = this._tasks.get(listId) || [];
        tasks.push(task);
        this._tasks.set(listId, tasks);
        this._saveCacheToDisk();
        this._emit('tasks-changed');
        return task;
    }

    /**
     * Mark a task as completed.
     */
    async completeTask(listId, taskId) {
        const backend = this._getBackendForList(listId);
        const updated = await backend.completeTask(listId, taskId);
        this._updateTaskInCache(listId, updated);
        this._saveCacheToDisk();
        this._emit('tasks-changed');
        return updated;
    }

    /**
     * Mark a task as not started (uncomplete).
     */
    async uncompleteTask(listId, taskId) {
        const backend = this._getBackendForList(listId);
        const updated = await backend.uncompleteTask(listId, taskId);
        this._updateTaskInCache(listId, updated);
        this._saveCacheToDisk();
        this._emit('tasks-changed');
        return updated;
    }

    /**
     * Update a task's title.
     * @param {string} listId
     * @param {string} taskId
     * @param {string} newTitle
     */
    async updateTaskTitle(listId, taskId, newTitle) {
        const backend = this._getBackendForList(listId);
        await backend.updateTaskTitle(listId, taskId, newTitle);
        // Update local cache optimistically
        const tasks = this._tasks.get(listId) || [];
        const task = tasks.find(t => t.id === taskId);
        if (task) task.title = newTitle;
        this._saveCacheToDisk();
        this._emit('tasks-changed');
    }

    /**
     * Delete a task.
     */
    async deleteTask(listId, taskId) {
        const backend = this._getBackendForList(listId);
        await backend.deleteTask(listId, taskId);
        const tasks = this._tasks.get(listId) || [];
        this._tasks.set(listId, tasks.filter(t => t.id !== taskId));
        this._saveCacheToDisk();
        this._emit('tasks-changed');
    }

    /**
     * Toggle a checklist item's checked state.
     */
    async toggleChecklistItem(listId, taskId, itemId) {
        const backend = this._getBackendForList(listId);
        const tasks = this._tasks.get(listId) || [];
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        const item = task.checklistItems?.find(ci => ci.id === itemId);
        if (!item) return;

        const updated = await backend.toggleChecklistItem(listId, taskId, itemId, {isChecked: !item.isChecked});

        // Update local cache
        item.isChecked = updated.isChecked;
        item.checkedDateTime = updated.checkedDateTime
            ? new Date(updated.checkedDateTime)
            : null;
        this._saveCacheToDisk();
        this._emit('tasks-changed');
    }

    // ── Polling ─────────────────────────────────────────────────────

    /**
     * Start periodic polling.
     * @param {number} intervalSeconds
     */
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

    /**
     * Stop periodic polling.
     */
    stopPolling() {
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = 0;
        }
    }

    // ── Signals ─────────────────────────────────────────────────────

    /**
     * Connect to a signal.
     * @param {string} signal - 'tasks-changed'|'lists-changed'|'auth-required'|'offline'|'online'
     * @param {Function} callback
     */
    connect(signal, callback) {
        if (this._signals[signal])
            this._signals[signal].push(callback);
    }

    // ── Lifecycle ───────────────────────────────────────────────────

    /**
     * Cleanup SyncEngine's own state. Does NOT destroy backends (extension.js owns them).
     */
    destroy() {
        this._destroyed = true;
        this.stopPolling();
        this._tasks.clear();
        this._taskLists = [];
        this._deltaTokens.clear();
        this._listBackendMap.clear();
    }

    // ── Private: Backend Routing ────────────────────────────────────

    /**
     * Look up which backend owns a given list.
     * @param {string} listId
     * @returns {BackendAdapter}
     */
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

    /**
     * Fetch all lists and tasks from every authenticated backend.
     * Replaces in-memory cache entirely.
     */
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

    /**
     * Delta sync a single list via its backend.
     * @param {BackendAdapter} backend
     * @param {string} listId
     * @returns {Promise<boolean>} true if tasks changed
     */
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

        // Merge delta changes into existing task list
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

        // Group tokens by backend
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

    /**
     * @returns {string} Path to the on-disk task cache JSON file
     */
    _getCachePath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'docket', 'task-cache.json']);
    }

    /**
     * Load cached task data from disk.
     * @returns {boolean} true if cache was loaded successfully
     */
    _loadCacheFromDisk() {
        try {
            const path = this._getCachePath();
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok) return false;

            const decoder = new TextDecoder('utf-8');
            const json = decoder.decode(contents);
            const data = JSON.parse(json);

            if (data.version !== CACHE_VERSION) return false;

            // Rebuild task lists
            this._taskLists = Array.isArray(data.taskLists) ? data.taskLists : [];

            // Rebuild list → backend mapping
            this._listBackendMap.clear();
            for (const list of this._taskLists) {
                if (list._backendId)
                    this._listBackendMap.set(list.id, list._backendId);
            }

            // Rebuild tasks with proper deserialization
            this._tasks.clear();
            if (data.tasks && typeof data.tasks === 'object') {
                for (const [listId, serializedTasks] of Object.entries(data.tasks)) {
                    if (!Array.isArray(serializedTasks)) continue;
                    const tasks = serializedTasks.map(t => TaskModel.deserialize(t));
                    this._tasks.set(listId, tasks);
                }
            }

            // Restore last sync time
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

    /**
     * Save current task data to disk cache. Non-fatal on failure.
     */
    _saveCacheToDisk() {
        try {
            const path = this._getCachePath();
            const dir = GLib.path_get_dirname(path);
            GLib.mkdir_with_parents(dir, 0o755);

            // Serialize tasks
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

    /**
     * Heuristic to detect network-level errors vs. API/auth errors.
     * @param {Error} e
     * @returns {boolean}
     */
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

    _emit(signal) {
        if (this._signals[signal]) {
            for (const cb of this._signals[signal]) {
                try {
                    cb();
                } catch (e) {
                    console.error(`[sync-engine] signal '${signal}' handler error: ${e.message}`);
                }
            }
        }
    }
}
