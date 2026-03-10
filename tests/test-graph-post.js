// Test 3.2: Full CRUD via GraphHttpClient — create → update → delete
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { AuthManager } from '../src/auth.js';
import { GraphHttpClient } from '../src/graph-client.js';

const loop = new GLib.MainLoop(null, false);
const BASE = 'https://graph.microsoft.com/v1.0';

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

async function test() {
    let passed = 0;
    let failed = 0;
    const auth = await bootstrapAuth();
    const client = new GraphHttpClient(auth);

    try {
        // Get first list ID
        const lists = await client.get(`${BASE}/me/todo/lists`);
        const listId = lists.body.value[0].id;

        // CREATE
        const createRes = await client.post(
            `${BASE}/me/todo/lists/${listId}/tasks`,
            {title: '[TEST-3.2] GraphHttpClient CRUD', importance: 'high'}
        );
        if (createRes.status === 201 && createRes.body.title === '[TEST-3.2] GraphHttpClient CRUD') {
            console.log('PASS: POST create task');
            passed++;
        } else {
            console.error(`FAIL: POST create — status=${createRes.status}`);
            failed++;
        }
        const taskId = createRes.body.id;

        // UPDATE (mark complete)
        const updateRes = await client.patch(
            `${BASE}/me/todo/lists/${listId}/tasks/${taskId}`,
            {status: 'completed'}
        );
        if (updateRes.status === 200 && updateRes.body.status === 'completed') {
            console.log('PASS: PATCH update task');
            passed++;
        } else {
            console.error(`FAIL: PATCH update — status=${updateRes.status}`);
            failed++;
        }

        // DELETE
        const deleteRes = await client.delete(
            `${BASE}/me/todo/lists/${listId}/tasks/${taskId}`
        );
        if (deleteRes.status === 204) {
            console.log('PASS: DELETE task');
            passed++;
        } else {
            console.error(`FAIL: DELETE — status=${deleteRes.status}`);
            failed++;
        }
    } catch (e) {
        console.error(`FAIL: ${e.message}`);
        failed++;
    }

    client.destroy();
    auth.destroy();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    loop.quit();
}

test();
loop.runAsync();
