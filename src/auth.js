'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import Secret from 'gi://Secret';

const AUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES = 'Tasks.ReadWrite offline_access User.Read';
const CLIENT_ID = 'f4139154-f6d0-40bf-88e9-3e5ec774c47c';

const TOKEN_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.docket.tokens',
    Secret.SchemaFlags.NONE,
    {'token_type': Secret.SchemaAttributeType.STRING}
);

/**
 * Authentication manager for Microsoft Graph API using device code flow.
 * Stores tokens in GNOME Keyring via libsecret.
 */
export class AuthManager {
    constructor() {
        this._session = new Soup.Session();
        this._accessToken = null;
        this._refreshToken = null;
        this._expiresAt = 0; // Unix timestamp in seconds
        this._pollSourceId = 0;
        this._destroyed = false;
        this._refreshPromise = null;
    }

    /**
     * Returns a valid access token, refreshing if needed.
     * @returns {Promise<string>} Bearer access token
     */
    async getAccessToken() {
        // If token expires within 5 minutes, proactively refresh
        const now = GLib.get_real_time() / 1000000;
        if (this._accessToken && this._expiresAt - now > 300)
            return this._accessToken;

        if (this._refreshToken) {
            if (!this._refreshPromise) {
                this._refreshPromise = this._refreshAccessToken()
                    .finally(() => { this._refreshPromise = null; });
            }
            try {
                await this._refreshPromise;
                return this._accessToken;
            } catch (e) {
                // Refresh failed — clear tokens, signal re-auth
                console.error(`[auth] Token refresh failed: ${e.message}`);
                await this.clearTokens();
                throw new Error('auth-required');
            }
        }

        // Try loading from keyring
        await this._loadTokens();
        if (this._accessToken && this._expiresAt - now > 300)
            return this._accessToken;

        if (this._refreshToken) {
            if (!this._refreshPromise) {
                this._refreshPromise = this._refreshAccessToken()
                    .finally(() => { this._refreshPromise = null; });
            }
            await this._refreshPromise;
            return this._accessToken;
        }

        throw new Error('auth-required');
    }

    /**
     * Starts the device code flow.
     * @returns {Promise<{userCode, verificationUri, message, pollPromise}>}
     */
    async startDeviceCodeFlow() {
        const params = Soup.form_encode_hash({
            'client_id': CLIENT_ID,
            'scope': SCOPES,
        });
        const message = Soup.Message.new_from_encoded_form(
            'POST', `${AUTH_BASE}/devicecode`, params
        );

        const data = await this._sendRequest(message);

        const deviceCode = data['device_code'];
        const interval = data['interval'] || 5;
        const expiresIn = data['expires_in'] || 900;

        const pollPromise = this._pollForToken(deviceCode, interval, expiresIn);

        return {
            userCode: data['user_code'],
            verificationUri: data['verification_uri'],
            message: data['message'],
            pollPromise,
        };
    }

    /**
     * Checks if we have stored tokens (sync check — loads from memory cache).
     * Call _loadTokens() first for full check.
     * @returns {boolean}
     */
    isAuthenticated() {
        const now = GLib.get_real_time() / 1000000;
        return !!(this._accessToken && this._expiresAt > now) || !!this._refreshToken;
    }

    /**
     * Loads tokens from GNOME Keyring into memory.
     * @returns {Promise<boolean>} true if tokens were loaded
     */
    async loadTokens() {
        return this._loadTokens();
    }

    /**
     * Clears all stored tokens from memory and GNOME Keyring.
     */
    async clearTokens() {
        this._accessToken = null;
        this._refreshToken = null;
        this._expiresAt = 0;

        try {
            await this._secretClear({'token_type': 'access'});
        } catch (e) { /* ignore */ }
        try {
            await this._secretClear({'token_type': 'refresh'});
        } catch (e) { /* ignore */ }
        try {
            await this._secretClear({'token_type': 'expires_at'});
        } catch (e) { /* ignore */ }
    }

    /**
     * Invalidates the cached access token, forcing a refresh on next use.
     */
    invalidateAccessToken() {
        this._accessToken = null;
        this._expiresAt = 0;
    }

    /**
     * Cleanup — cancel any pending poll timers and clear credentials from memory.
     */
    destroy() {
        this._destroyed = true;
        this._accessToken = null;
        this._refreshToken = null;
        this._expiresAt = 0;
        this._refreshPromise = null;
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = 0;
        }
    }

    // ── Private methods ─────────────────────────────────────────────

    _sendRequest(message) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const text = new TextDecoder('utf-8').decode(bytes.get_data());
                        resolve(JSON.parse(text));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _pollForToken(deviceCode, interval, expiresIn) {
        const deadline = GLib.get_real_time() / 1000000 + expiresIn;

        return new Promise((resolve, reject) => {
            const poll = () => {
                if (this._destroyed) {
                    reject(new Error('destroyed'));
                    return GLib.SOURCE_REMOVE;
                }

                const now = GLib.get_real_time() / 1000000;
                if (now >= deadline) {
                    reject(new Error('Device code expired'));
                    return GLib.SOURCE_REMOVE;
                }

                const params = Soup.form_encode_hash({
                    'client_id': CLIENT_ID,
                    'device_code': deviceCode,
                    'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
                });
                const msg = Soup.Message.new_from_encoded_form(
                    'POST', `${AUTH_BASE}/token`, params
                );

                this._sendRequest(msg).then(async (data) => {
                    if (data['access_token']) {
                        await this._storeTokenResponse(data);
                        resolve();
                        return;
                    }

                    const error = data['error'];
                    if (error === 'authorization_pending') {
                        // Keep polling
                        this._pollSourceId = GLib.timeout_add_seconds(
                            GLib.PRIORITY_DEFAULT, interval, poll
                        );
                        return;
                    }
                    if (error === 'slow_down') {
                        // Increase interval by 5 seconds
                        this._pollSourceId = GLib.timeout_add_seconds(
                            GLib.PRIORITY_DEFAULT, interval + 5, poll
                        );
                        return;
                    }
                    // authorization_declined, expired_token, bad_verification_code
                    reject(new Error(data['error_description'] || error));
                }).catch(reject);

                return GLib.SOURCE_REMOVE;
            };

            // Start first poll after interval
            this._pollSourceId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, interval, poll
            );
        });
    }

    async _refreshAccessToken() {
        if (!this._refreshToken || typeof this._refreshToken !== 'string' || this._refreshToken.length < 10) {
            console.log('[auth] Invalid refresh token — clearing credentials');
            await this.clearTokens();
            throw new Error('auth-required');
        }

        const params = Soup.form_encode_hash({
            'client_id': CLIENT_ID,
            'scope': SCOPES,
            'refresh_token': this._refreshToken,
            'grant_type': 'refresh_token',
        });
        const message = Soup.Message.new_from_encoded_form(
            'POST', `${AUTH_BASE}/token`, params
        );

        const data = await this._sendRequest(message);

        if (data['error'])
            throw new Error(data['error_description'] || data['error']);

        await this._storeTokenResponse(data);
    }

    async _storeTokenResponse(data) {
        this._accessToken = data['access_token'];
        this._refreshToken = data['refresh_token'] || this._refreshToken;
        this._expiresAt = GLib.get_real_time() / 1000000 + (data['expires_in'] || 3600);

        await this._secretStore({'token_type': 'access'}, this._accessToken);
        if (this._refreshToken)
            await this._secretStore({'token_type': 'refresh'}, this._refreshToken);
        await this._secretStore(
            {'token_type': 'expires_at'},
            String(Math.floor(this._expiresAt))
        );
    }

    async _loadTokens() {
        try {
            this._accessToken = await this._secretLookup({'token_type': 'access'});
            this._refreshToken = await this._secretLookup({'token_type': 'refresh'});
            const expiresStr = await this._secretLookup({'token_type': 'expires_at'});
            this._expiresAt = expiresStr ? parseInt(expiresStr, 10) : 0;
            return !!(this._accessToken || this._refreshToken);
        } catch (e) {
            console.error(`[auth] Failed to load tokens: ${e.message}`);
            throw e;  // Let caller handle — may be keyring locked (temporary)
        }
    }

    // ── libsecret wrappers (promisified) ────────────────────────────

    _secretStore(attributes, secret) {
        return new Promise((resolve, reject) => {
            Secret.password_store(
                TOKEN_SCHEMA,
                attributes,
                Secret.COLLECTION_DEFAULT,
                `docket-${attributes['token_type']}`,
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
