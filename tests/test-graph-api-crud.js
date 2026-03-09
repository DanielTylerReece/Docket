// Test 5.1: Full GraphApi lifecycle — lists → tasks → create → checklist → update → delete
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { AuthManager } from '../src/auth.js';
import { GraphApi } from '../src/graph-api.js';

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

async function test() {
    let passed = 0;
    let failed = 0;
    const check = (name, cond) => {
        if (cond) { console.log(`PASS: ${name}`); passed++; }
        else { console.error(`FAIL: ${name}`); failed++; }
    };

    const auth = await bootstrapAuth();
    const api = new GraphApi(auth);
    let listId, taskId, itemId;

    try {
        // List task lists
        const lists = await api.listTaskLists();
        check('listTaskLists returns array', Array.isArray(lists) && lists.length > 0);
        listId = lists[0].id;
        console.log(`  Using list: ${lists[0].displayName}`);

        // List tasks
        const tasks = await api.listTasks(listId);
        check('listTasks returns array', Array.isArray(tasks));
        console.log(`  Tasks in list: ${tasks.length}`);

        // Create task
        const created = await api.createTask(listId, {
            title: '[TEST-5.1] GraphApi CRUD',
            importance: 'high',
            body: {content: 'Test notes', contentType: 'text'},
        });
        check('createTask returns task', created.id && created.title === '[TEST-5.1] GraphApi CRUD');
        check('createTask importance', created.importance === 'high');
        taskId = created.id;

        // Create checklist item
        const ci = await api.createChecklistItem(listId, taskId, {
            displayName: 'Subtask A',
        });
        check('createChecklistItem', ci.displayName === 'Subtask A');
        itemId = ci.id;

        // Update checklist item (check it off)
        const updatedCi = await api.updateChecklistItem(listId, taskId, itemId, {
            isChecked: true,
        });
        check('updateChecklistItem isChecked', updatedCi.isChecked === true);

        // Update task (mark complete)
        const updated = await api.updateTask(listId, taskId, {status: 'completed'});
        check('updateTask status', updated.status === 'completed');

        // Delete task
        await api.deleteTask(listId, taskId);
        check('deleteTask success', true);
        taskId = null; // prevent double-delete in cleanup

    } catch (e) {
        console.error(`FAIL: Exception: ${e.message}`);
        failed++;
    }

    // Cleanup: delete task if still exists
    if (taskId) {
        try { await api.deleteTask(listId, taskId); } catch (e) { /* ok */ }
    }

    api.destroy();
    auth.destroy();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    loop.quit();
}

test();
loop.runAsync();
