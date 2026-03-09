// Test 3.1: GET /me/todo/lists with GraphHttpClient
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { AuthManager } from '../src/auth.js';
import { GraphHttpClient } from '../src/graph-client.js';

const loop = new GLib.MainLoop(null, false);

async function bootstrapAuth() {
    const auth = new AuthManager();
    // Load refresh token from curl test tokens
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
    try {
        const auth = await bootstrapAuth();
        const client = new GraphHttpClient(auth);

        const res = await client.get('https://graph.microsoft.com/v1.0/me/todo/lists');

        if (res.status === 200 && Array.isArray(res.body.value)) {
            console.log(`PASS: GET /me/todo/lists — ${res.body.value.length} lists`);
            for (const list of res.body.value)
                console.log(`  - ${list.displayName} (${list.id.substring(0, 20)}...)`);
        } else {
            console.error(`FAIL: status=${res.status}, body=${JSON.stringify(res.body).substring(0, 200)}`);
        }

        client.destroy();
        auth.destroy();
    } catch (e) {
        console.error(`FAIL: ${e.message}`);
    }
    loop.quit();
}

test();
loop.runAsync();
