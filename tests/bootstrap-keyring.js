// Bootstrap: Store tokens from /tmp/docket-test-tokens.json into GNOME Keyring
// so the extension can authenticate on load without device code flow.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { AuthManager } from '../src/auth.js';

const loop = new GLib.MainLoop(null, false);

async function bootstrap() {
    try {
        const auth = new AuthManager();
        const file = Gio.File.new_for_path('/tmp/docket-test-tokens.json');
        const [ok, contents] = file.load_contents(null);
        const tokens = JSON.parse(new TextDecoder('utf-8').decode(contents));

        if (!tokens.refresh_token) {
            console.error('No refresh_token in test tokens file');
            loop.quit();
            return;
        }

        await auth._storeTokenResponse({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in || 3600,
        });

        console.log('Tokens stored in GNOME Keyring for extension use');

        // Verify
        const auth2 = new AuthManager();
        const loaded = await auth2.loadTokens();
        console.log(`Verification: loaded=${loaded}, isAuthenticated=${auth2.isAuthenticated()}`);

        auth.destroy();
        auth2.destroy();
    } catch (e) {
        console.error(`Error: ${e.message}`);
    }
    loop.quit();
}

bootstrap();
loop.runAsync();
