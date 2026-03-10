'use strict';

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const ALLOWED_HOSTS = new Set([
    'graph.microsoft.com',
    'login.microsoftonline.com',
]);

function _validateUrl(url) {
    if (typeof url !== 'string')
        throw new Error('URL must be a string');

    let parsed;
    try {
        parsed = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch {
        throw new Error(`Invalid URL: ${url.substring(0, 50)}`);
    }

    if (parsed.get_scheme() !== 'https')
        throw new Error(`URL must use HTTPS: ${parsed.get_scheme()}`);

    if (!ALLOWED_HOSTS.has(parsed.get_host()))
        throw new Error(`Untrusted host: ${parsed.get_host()}`);

    return url;
}

/**
 * HTTP client for Microsoft Graph API with automatic auth, retry, and backoff.
 */
export class GraphHttpClient {
    constructor(authManager) {
        this._auth = authManager;
        this._session = new Soup.Session();
        this._session.timeout = 30;
    }

    /**
     * @param {string} url - Full URL
     * @returns {Promise<{status: number, body: object}>}
     */
    async get(url) {
        return this._request('GET', url, null);
    }

    /**
     * @param {string} url - Full URL
     * @param {object} body - JSON body
     * @returns {Promise<{status: number, body: object}>}
     */
    async post(url, body) {
        return this._request('POST', url, body);
    }

    /**
     * @param {string} url - Full URL
     * @param {object} body - JSON body
     * @returns {Promise<{status: number, body: object}>}
     */
    async patch(url, body) {
        return this._request('PATCH', url, body);
    }

    /**
     * @param {string} url - Full URL
     * @returns {Promise<{status: number, body: object|null}>}
     */
    async delete(url) {
        return this._request('DELETE', url, null);
    }

    destroy() {
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        this._auth = null;
    }

    // ── Private ─────────────────────────────────────────────────────

    async _request(method, url, body, retryCount = 0) {
        const validatedUrl = _validateUrl(url);
        const token = await this._auth.getAccessToken();
        const message = new Soup.Message({method, uri: GLib.Uri.parse(validatedUrl, GLib.UriFlags.NONE)});
        message.get_request_headers().append('Authorization', `Bearer ${token}`);

        if (body !== null && body !== undefined) {
            const jsonBytes = new GLib.Bytes(
                new TextEncoder().encode(JSON.stringify(body))
            );
            message.set_request_body_from_bytes('application/json', jsonBytes);
        }

        const response = await this._send(message);

        // 401: token expired — invalidate and refresh, retry once
        if (response.status === 401 && retryCount < 1) {
            this._auth.invalidateAccessToken();
            return this._request(method, url, body, retryCount + 1);
        }

        // 429: rate limited — respect Retry-After (clamped to 120s max)
        if (response.status === 429 && retryCount < 3) {
            const raw = message.get_response_headers().get_one('Retry-After') || '5';
            const retryAfter = Math.min(Math.max(parseInt(raw, 10) || 5, 1), 120);
            await this._wait(retryAfter);
            return this._request(method, url, body, retryCount + 1);
        }

        // 5xx: server error — exponential backoff
        if (response.status >= 500 && retryCount < 3) {
            const delay = Math.pow(2, retryCount); // 1s, 2s, 4s
            await this._wait(delay);
            return this._request(method, url, body, retryCount + 1);
        }

        return response;
    }

    _send(message) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();

                        // 204 No Content — no body
                        if (status === 204) {
                            resolve({status, body: null});
                            return;
                        }

                        const text = new TextDecoder('utf-8').decode(bytes.get_data());
                        let body = null;
                        try {
                            body = JSON.parse(text);
                        } catch (e) {
                            console.log('Docket: Non-JSON response received');
                            body = {error: {code: 'non_json_response', message: 'Response was not valid JSON'}};
                        }
                        resolve({status, body});
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _wait(seconds) {
        return new Promise(resolve => {
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}
