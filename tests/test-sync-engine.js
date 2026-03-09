// Test 6.3: Full SyncEngine — initialize → sync → createTask → completeTask → cache → destroy
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { AuthManager } from '../src/auth.js';
import { SyncEngine } from '../src/sync-engine.js';

const loop = new GLib.MainLoop(null, false);

async function bootstrapAuth() {
    const auth = new AuthManager();
    const file = Gio.File.new_for_path('/tmp/task-widget-test-tokens.json');
    const [ok, contents] = file.load_contents(null);
    const tokens = JSON.parse(new TextDecoder('utf-8').decode(contents));
    await auth._storeTokenResponse({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in || 3600,
    });
    return auth;
}

function wait(seconds) {
    return new Promise(resolve => {
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function test() {
    let passed = 0;
    let failed = 0;
    const check = (name, cond) => {
        if (cond) { console.log(`PASS: ${name}`); passed++; }
        else { console.error(`FAIL: ${name}`); failed++; }
    };

    const auth = await bootstrapAuth();
    const engine = new SyncEngine(auth, null);

    let tasksChangedCount = 0;
    let listsChangedCount = 0;
    engine.connect('tasks-changed', () => tasksChangedCount++);
    engine.connect('lists-changed', () => listsChangedCount++);

    try {
        // Initialize
        await engine.initialize();
        const lists = engine.getTaskLists();
        check('initialize: has lists', lists.length > 0);
        check('initialize: lists-changed fired', listsChangedCount > 0);
        check('initialize: tasks-changed fired', tasksChangedCount > 0);

        const listId = lists[0].id;
        const initialCount = engine.getTasks(listId).length;
        console.log(`  List: ${lists[0].displayName}, tasks: ${initialCount}`);

        // Create task
        const created = await engine.createTask(listId, '[TEST-6.3] SyncEngine test');
        check('createTask: returns task', created.id && created.title === '[TEST-6.3] SyncEngine test');
        check('createTask: tasks-changed fired', tasksChangedCount > 1);

        const afterCreateCount = engine.getTasks(listId).length;
        check('createTask: cache updated', afterCreateCount === initialCount + 1);

        // Complete task
        const completed = await engine.completeTask(listId, created.id);
        check('completeTask: status', completed.status === 'completed');

        // Sync (delta)
        tasksChangedCount = 0;
        await engine.sync();
        // Delta may or may not return changes (depends on propagation time)
        check('sync: no crash', true);

        // Delete task (cleanup)
        await engine.deleteTask(listId, created.id);
        const afterDeleteCount = engine.getTasks(listId).length;
        check('deleteTask: cache updated', afterDeleteCount === initialCount);

        // Polling test (start + stop, no crash)
        engine.startPolling(60); // 60s interval, won't actually fire
        engine.stopPolling();
        check('polling: start/stop no crash', true);

    } catch (e) {
        console.error(`FAIL: Exception: ${e.message}`);
        failed++;
    }

    engine.destroy();
    auth.destroy();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    loop.quit();
}

test();
loop.runAsync();
