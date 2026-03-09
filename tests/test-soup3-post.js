// Test 2.1: Verify Soup3 can POST form data
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const loop = new GLib.MainLoop(null, false);

async function test() {
    try {
        const session = new Soup.Session();
        const params = Soup.form_encode_hash({
            'client_id': 'test',
            'scope': 'test',
        });
        const message = Soup.Message.new_from_encoded_form(
            'POST', 'https://httpbin.org/post', params
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

        if (data.form && data.form.client_id === 'test' && data.form.scope === 'test') {
            console.log('PASS: Soup3 POST form data works');
        } else {
            console.error(`FAIL: Unexpected response: ${text.substring(0, 200)}`);
        }
    } catch (e) {
        console.error(`FAIL: ${e.message}`);
    }
    loop.quit();
}

test();
loop.runAsync();
