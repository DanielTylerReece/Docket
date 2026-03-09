// Test 2.6: Full AuthManager API — store tokens, retrieve, refresh, clear
//
// This test uses the refresh_token from /tmp/task-widget-test-tokens.json
// to bootstrap the AuthManager without requiring interactive device code flow.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// We need to import from the src directory
import { AuthManager } from '../src/auth.js';

const loop = new GLib.MainLoop(null, false);

async function test() {
    const auth = new AuthManager();
    let passed = 0;
    let failed = 0;

    // Start clean
    await auth.clearTokens();

    // 1. isAuthenticated should be false when no tokens
    if (!auth.isAuthenticated()) {
        console.log('PASS: isAuthenticated() returns false when no tokens');
        passed++;
    } else {
        console.error('FAIL: isAuthenticated() should be false when no tokens');
        failed++;
    }

    // 2. Bootstrap: load refresh token from curl test, store it in keyring
    try {
        const file = Gio.File.new_for_path('/tmp/task-widget-test-tokens.json');
        const [ok, contents] = file.load_contents(null);
        const tokens = JSON.parse(new TextDecoder('utf-8').decode(contents));

        if (!tokens.refresh_token)
            throw new Error('No refresh_token in test file');

        // Manually store refresh token so AuthManager can find it
        auth._refreshToken = tokens.refresh_token;
        // Store in keyring via private method for bootstrapping
        await auth._storeTokenResponse({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: 1, // Expire immediately to force refresh
        });
        console.log('PASS: Bootstrap tokens stored in keyring');
        passed++;
    } catch (e) {
        console.error(`FAIL: Bootstrap: ${e.message}`);
        failed++;
        loop.quit();
        return;
    }

    // 3. loadTokens from keyring
    try {
        // Clear memory, force load from keyring
        auth._accessToken = null;
        auth._refreshToken = null;
        auth._expiresAt = 0;

        const loaded = await auth.loadTokens();
        if (loaded && auth._refreshToken) {
            console.log('PASS: loadTokens() retrieves from keyring');
            passed++;
        } else {
            console.error('FAIL: loadTokens() did not retrieve tokens');
            failed++;
        }
    } catch (e) {
        console.error(`FAIL: loadTokens(): ${e.message}`);
        failed++;
    }

    // 4. getAccessToken — should trigger refresh (token expired)
    try {
        auth._expiresAt = 0; // Force expired
        const token = await auth.getAccessToken();
        if (token && token.length > 50) {
            console.log(`PASS: getAccessToken() refreshed and returned token (${token.length} chars)`);
            passed++;
        } else {
            console.error(`FAIL: getAccessToken() returned invalid token`);
            failed++;
        }
    } catch (e) {
        console.error(`FAIL: getAccessToken(): ${e.message}`);
        failed++;
    }

    // 5. isAuthenticated should now be true
    if (auth.isAuthenticated()) {
        console.log('PASS: isAuthenticated() returns true after refresh');
        passed++;
    } else {
        console.error('FAIL: isAuthenticated() should be true after refresh');
        failed++;
    }

    // 6. clearTokens
    try {
        await auth.clearTokens();
        if (!auth.isAuthenticated()) {
            console.log('PASS: clearTokens() clears all state');
            passed++;
        } else {
            console.error('FAIL: clearTokens() did not clear state');
            failed++;
        }
    } catch (e) {
        console.error(`FAIL: clearTokens(): ${e.message}`);
        failed++;
    }

    // 7. Verify keyring is clean
    try {
        const loaded = await auth.loadTokens();
        if (!auth._accessToken && !auth._refreshToken) {
            console.log('PASS: Keyring cleaned after clearTokens()');
            passed++;
        } else {
            console.error('FAIL: Keyring still has tokens after clear');
            failed++;
        }
    } catch (e) {
        console.error(`FAIL: Keyring check: ${e.message}`);
        failed++;
    }

    auth.destroy();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    loop.quit();
}

test();
loop.runAsync();
