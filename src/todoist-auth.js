'use strict';

import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

const TOKEN_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.docket.todoist.tokens',
    Secret.SchemaFlags.NONE,
    {'type': Secret.SchemaAttributeType.STRING}
);

const API_BASE = 'https://api.todoist.com/api/v1';

/**
 * Todoist API token auth manager.
 *
 * Much simpler than Microsoft auth — tokens never expire, no refresh
 * mechanism needed. User pastes API token in prefs, validated via
 * lightweight GET to /api/v1/projects.
 */
export class TodoistAuthManager {
    constructor() {
        this._token = null;
        this._session = new Soup.Session();
    }

    async loadTokens() {
        try {
            const token = await this._secretLookup({'type': 'api-token'});
            if (token) {
                this._token = token;
                return true;
            }
            return false;
        } catch (e) {
            console.error(`[todoist-auth] Failed to load token: ${e.message}`);
            throw e;
        }
    }

    async storeToken(apiToken) {
        await this._validateToken(apiToken);
        await this._secretStore({'type': 'api-token'}, apiToken);
        this._token = apiToken;
    }

    getAccessToken() {
        if (!this._token)
            throw new Error('auth-required');
        return this._token;
    }

    isAuthenticated() {
        return this._token !== null;
    }

    async clearTokens() {
        this._token = null;
        try {
            await this._secretClear({'type': 'api-token'});
        } catch (e) {
            // Token may not exist in keyring
        }
    }

    destroy() {
        this._token = null;
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }

    // ── Private ─────────────────────────────────────────────────────

    // Soup3 in GJS requires the 4-arg callback form for send_and_read_async
    _validateToken(token) {
        return new Promise((resolve, reject) => {
            if (!this._session) {
                reject(new Error('Session destroyed'));
                return;
            }

            const msg = Soup.Message.new('GET', `${API_BASE}/projects`);
            msg.get_request_headers().append('Authorization', `Bearer ${token}`);

            this._session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, null,
                (_session, result) => {
                    try {
                        this._session.send_and_read_finish(result);
                        const status = msg.get_status();
                        if (status === 200) {
                            resolve();
                        } else if (status === 401 || status === 403) {
                            reject(new Error('Invalid Todoist API token'));
                        } else {
                            reject(new Error(`Token validation failed: HTTP ${status}`));
                        }
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    // ── libsecret wrappers (promisified) ────────────────────────────

    _secretStore(attributes, secret) {
        return new Promise((resolve, reject) => {
            Secret.password_store(
                TOKEN_SCHEMA,
                attributes,
                Secret.COLLECTION_DEFAULT,
                'Docket Todoist API Token',
                secret,
                null,
                (source, result) => {
                    try {
                        Secret.password_store_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _secretLookup(attributes) {
        return new Promise((resolve, reject) => {
            Secret.password_lookup(
                TOKEN_SCHEMA,
                attributes,
                null,
                (source, result) => {
                    try {
                        resolve(Secret.password_lookup_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _secretClear(attributes) {
        return new Promise((resolve, reject) => {
            Secret.password_clear(
                TOKEN_SCHEMA,
                attributes,
                null,
                (source, result) => {
                    try {
                        Secret.password_clear_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }
}
