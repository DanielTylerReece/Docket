// Test 2.5: Token refresh using saved tokens from curl validation
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import Gio from 'gi://Gio';

const loop = new GLib.MainLoop(null, false);
const CLIENT_ID = 'f4139154-f6d0-40bf-88e9-3e5ec774c47c';

function sendRequest(session, message) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, null,
            (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    const text = new TextDecoder('utf-8').decode(bytes.get_data());
                    resolve(JSON.parse(text));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

async function test() {
    try {
        // Load tokens from curl test phase
        const file = Gio.File.new_for_path('/tmp/task-widget-test-tokens.json');
        const [ok, contents] = file.load_contents(null);
        const tokens = JSON.parse(new TextDecoder('utf-8').decode(contents));

        if (!tokens.refresh_token) {
            console.error('FAIL: No refresh_token in /tmp/task-widget-test-tokens.json');
            loop.quit();
            return;
        }

        const session = new Soup.Session();
        const params = Soup.form_encode_hash({
            'client_id': CLIENT_ID,
            'scope': 'Tasks.ReadWrite offline_access User.Read',
            'refresh_token': tokens.refresh_token,
            'grant_type': 'refresh_token',
        });
        const message = Soup.Message.new_from_encoded_form(
            'POST', 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
            params
        );

        const data = await sendRequest(session, message);

        if (data.access_token && data.refresh_token) {
            console.log('PASS: Token refresh via Soup3');
            console.log(`  New expires_in: ${data.expires_in}s`);
            console.log(`  New refresh_token: YES`);

            // Update saved tokens
            const newTokens = JSON.stringify({
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                expires_in: data.expires_in,
                token_type: data.token_type,
            }, null, 2);
            const outFile = Gio.File.new_for_path('/tmp/task-widget-test-tokens.json');
            outFile.replace_contents(
                new TextEncoder().encode(newTokens),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
            console.log('  Updated /tmp/task-widget-test-tokens.json');
        } else {
            console.error(`FAIL: ${data.error}: ${data.error_description}`);
        }
    } catch (e) {
        console.error(`FAIL: ${e.message}`);
    }
    loop.quit();
}

test();
loop.runAsync();
