// Test 2.2: Verify device code request returns all expected fields
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const loop = new GLib.MainLoop(null, false);
const CLIENT_ID = 'f4139154-f6d0-40bf-88e9-3e5ec774c47c';

async function test() {
    try {
        const session = new Soup.Session();
        const params = Soup.form_encode_hash({
            'client_id': CLIENT_ID,
            'scope': 'Tasks.ReadWrite offline_access User.Read',
        });
        const message = Soup.Message.new_from_encoded_form(
            'POST', 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
            params
        );

        const data = await new Promise((resolve, reject) => {
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

        const required = ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval', 'message'];
        const missing = required.filter(k => !(k in data));

        if (missing.length === 0) {
            console.log('PASS: Device code request returns all fields');
            console.log(`  user_code: ${data.user_code}`);
            console.log(`  verification_uri: ${data.verification_uri}`);
            console.log(`  interval: ${data.interval}s, expires_in: ${data.expires_in}s`);
        } else {
            console.error(`FAIL: Missing fields: ${missing.join(', ')}`);
            console.error(`  Response: ${text.substring(0, 300)}`);
        }
    } catch (e) {
        console.error(`FAIL: ${e.message}`);
    }
    loop.quit();
}

test();
loop.runAsync();
