// Test 2.4: Store, retrieve, and clear tokens in GNOME Keyring
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';

const loop = new GLib.MainLoop(null, false);

const TEST_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.task-widget.test',
    Secret.SchemaFlags.NONE,
    {'token_type': Secret.SchemaAttributeType.STRING}
);

function secretStore(attributes, secret) {
    return new Promise((resolve, reject) => {
        Secret.password_store(
            TEST_SCHEMA, attributes,
            Secret.COLLECTION_DEFAULT,
            `test-${attributes['token_type']}`,
            secret, null,
            (source, result) => {
                try { Secret.password_store_finish(result); resolve(); }
                catch (e) { reject(e); }
            }
        );
    });
}

function secretLookup(attributes) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(
            TEST_SCHEMA, attributes, null,
            (source, result) => {
                try { resolve(Secret.password_lookup_finish(result)); }
                catch (e) { reject(e); }
            }
        );
    });
}

function secretClear(attributes) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(
            TEST_SCHEMA, attributes, null,
            (source, result) => {
                try { Secret.password_clear_finish(result); resolve(); }
                catch (e) { reject(e); }
            }
        );
    });
}

async function test() {
    let passed = 0;
    let failed = 0;

    try {
        // Store
        await secretStore({'token_type': 'test-access'}, 'my-test-token-12345');
        console.log('PASS: Store token');
        passed++;
    } catch (e) {
        console.error(`FAIL: Store token: ${e.message}`);
        failed++;
    }

    try {
        // Retrieve
        const val = await secretLookup({'token_type': 'test-access'});
        if (val === 'my-test-token-12345') {
            console.log('PASS: Retrieve token');
            passed++;
        } else {
            console.error(`FAIL: Retrieve token: got "${val}"`);
            failed++;
        }
    } catch (e) {
        console.error(`FAIL: Retrieve token: ${e.message}`);
        failed++;
    }

    try {
        // Clear
        await secretClear({'token_type': 'test-access'});
        const val = await secretLookup({'token_type': 'test-access'});
        if (val === null) {
            console.log('PASS: Clear token');
            passed++;
        } else {
            console.error(`FAIL: Clear token: still found "${val}"`);
            failed++;
        }
    } catch (e) {
        console.error(`FAIL: Clear token: ${e.message}`);
        failed++;
    }

    try {
        // Lookup non-existent
        const val = await secretLookup({'token_type': 'nonexistent'});
        if (val === null) {
            console.log('PASS: Lookup non-existent returns null');
            passed++;
        } else {
            console.error(`FAIL: Lookup non-existent: got "${val}"`);
            failed++;
        }
    } catch (e) {
        console.error(`FAIL: Lookup non-existent: ${e.message}`);
        failed++;
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    loop.quit();
}

test();
loop.runAsync();
