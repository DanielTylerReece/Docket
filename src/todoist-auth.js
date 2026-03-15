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
 * Authentication manager for Todoist API.
 *
 * Much simpler than Microsoft auth:
 * - Todoist API tokens never expire — no refresh mechanism needed.
 * - No device code flow — user pastes their API token in prefs.
 * - getAccessToken() is synchronous (just returns stored token).
 * - Validation via lightweight GET to /api/v1/projects.
 *
 * Stores the API token in GNOME Keyring via libsecret.
 */
export class TodoistAuthManager {
    constructor() {
        this._token = null;
        this._session = new Soup.Session();
    }

    /**
     * Load stored API token from GNOME Keyring (libsecret).
     * @returns {Promise<boolean>} true if a token was loaded
     * @throws {Error} if keyring is locked (temporary failure — caller can retry)
     */
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

    /**
     * Validate and store a Todoist API token.
     * Validates by calling GET /api/v1/projects — if 200, token is valid.
     * @param {string} apiToken - Todoist API token from user
     * @returns {Promise<void>}
     * @throws {Error} if token is invalid (401/403) or network error
     */
    async storeToken(apiToken) {
        // Validate the token against the API first
        await this._validateToken(apiToken);

        // Token is valid — store in libsecret
        await this._secretStore({'type': 'api-token'}, apiToken);
        this._token = apiToken;
    }

    /**
     * Get the stored API token. Synchronous — Todoist tokens never expire.
     * @returns {string} The API token
     * @throws {Error} if not authenticated (error message: 'auth-required')
     */
    getAccessToken() {
        if (!this._token)
            throw new Error('auth-required');
        return this._token;
    }

    /**
     * @returns {boolean} Whether a token is currently loaded in memory
     */
    isAuthenticated() {
        return this._token !== null;
    }

    /**
     * Clear stored token from memory and GNOME Keyring.
     * @returns {Promise<void>}
     */
    async clearTokens() {
        this._token = null;
        try {
            await this._secretClear({'type': 'api-token'});
        } catch (e) {
            // Ignore — token may not exist in keyring
        }
    }

    /**
     * Cleanup — abort pending HTTP requests and clear credentials from memory.
     */
    destroy() {
        this._token = null;
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }

    // ── Private methods ─────────────────────────────────────────────

    /**
     * Validate a token by making a lightweight GET /api/v1/projects call.
     * Uses Soup3 callback form (4 args required in GJS).
     * @param {string} token - API token to validate
     * @returns {Promise<void>}
     * @throws {Error} if token is invalid or request fails
     */
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
