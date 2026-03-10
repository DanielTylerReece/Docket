// Test 5.2: Delta query — initial sync → create task → delta returns only new task
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { AuthManager } from '../src/auth.js';
import { GraphApi } from '../src/graph-api.js';

const loop = new GLib.MainLoop(null, false);

async function bootstrapAuth() {
    const auth = new AuthManager();
    const file = Gio.File.new_for_path('/tmp/docket-test-tokens.json');
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
    const api = new GraphApi(auth);
    let taskId;

    try {
        const lists = await api.listTaskLists();
        const listId = lists[0].id;

        // Initial delta — gets all tasks + deltaLink
        const initial = await api.deltaQuery(listId);
        check('initial delta returns tasks', Array.isArray(initial.tasks));
        check('initial delta has deltaLink', !!initial.deltaLink);
        console.log(`  Initial delta: ${initial.tasks.length} tasks`);

        // Create a task
        const created = await api.createTask(listId, {
            title: '[TEST-5.2] Delta test task',
        });
        taskId = created.id;
        console.log(`  Created task: ${taskId.substring(0, 30)}...`);

        // Wait briefly for Graph API propagation
        await wait(2);

        // Delta with token — should return only the new task (and possibly others)
        const delta = await api.deltaQuery(listId, initial.deltaLink);
        check('delta after create has tasks', delta.tasks.length > 0);
        const found = delta.tasks.find(t => t.title === '[TEST-5.2] Delta test task');
        check('delta contains created task', !!found);
        check('delta has new deltaLink', !!delta.deltaLink);
        console.log(`  Delta returned: ${delta.tasks.length} changed tasks`);

        // Cleanup
        await api.deleteTask(listId, taskId);
        taskId = null;
        check('cleanup delete', true);

    } catch (e) {
        console.error(`FAIL: Exception: ${e.message}`);
        failed++;
    }

    api.destroy();
    auth.destroy();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    loop.quit();
}

test();
loop.runAsync();
