'use strict';

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const ALLOWED_HOSTS = new Set([
    'api.todoist.com',
]);

const BASE_URL = 'https://api.todoist.com';

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

export class TodoistHttpClient {
    constructor(authManager) {
        this._auth = authManager;
        this._session = new Soup.Session();
        this._session.timeout = 30;
    }

    async get(path) {
        return this._request('GET', `${BASE_URL}${path}`, null, null);
    }

    async post(path, body) {
        return this._request('POST', `${BASE_URL}${path}`, body, 'application/json');
    }

    async postForm(path, formBody) {
        return this._request('POST', `${BASE_URL}${path}`, formBody, 'application/x-www-form-urlencoded');
    }

    async delete(path) {
        return this._request('DELETE', `${BASE_URL}${path}`, null, null);
    }

    destroy() {
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        this._auth = null;
    }

    async _request(method, url, body, contentType, retryCount = 0) {
        const validatedUrl = _validateUrl(url);
        const token = this._auth.getAccessToken();
        const message = new Soup.Message({method, uri: GLib.Uri.parse(validatedUrl, GLib.UriFlags.NONE)});

        message.get_request_headers().append('Authorization', `Bearer ${token}`);

        if (method === 'POST' || method === 'DELETE')
            message.get_request_headers().append('X-Request-Id', GLib.uuid_string_random());

        if (body !== null && body !== undefined) {
            let bodyBytes;
            if (contentType === 'application/json') {
                bodyBytes = new GLib.Bytes(
                    new TextEncoder().encode(JSON.stringify(body))
                );
            } else {
                bodyBytes = new GLib.Bytes(
                    new TextEncoder().encode(body)
                );
            }
            message.set_request_body_from_bytes(contentType, bodyBytes);
        }

        const response = await this._send(message);

        if (response.status === 401)
            throw new Error('auth-required');

        if (response.status === 429 && retryCount < 3) {
            const backoffMs = [1000, 2000, 4000][retryCount];
            const raw = message.get_response_headers().get_one('Retry-After');
            const retryAfterMs = raw ? Math.min(parseInt(raw, 10) * 1000 || backoffMs, 120000) : backoffMs;
            await this._waitMs(retryAfterMs);
            return this._request(method, url, body, contentType, retryCount + 1);
        }

        if (response.status >= 500 && retryCount < 3) {
            const delayMs = Math.pow(2, retryCount) * 1000;
            await this._waitMs(delayMs);
            return this._request(method, url, body, contentType, retryCount + 1);
        }

        return response;
    }

    _send(message) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null,
                (_session, result) => {
                    try {
                        const bytes = this._session.send_and_read_finish(result);
                        const status = message.get_status();

                        if (status === 204) {
                            resolve({status, body: null});
                            return;
                        }

                        const text = new TextDecoder('utf-8').decode(bytes.get_data());
                        let body = null;
                        try {
                            body = JSON.parse(text);
                        } catch (e) {
                            console.log('Docket: Todoist non-JSON response received');
                            body = {error: 'non_json_response', message: 'Response was not valid JSON'};
                        }
                        resolve({status, body});
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _waitMs(delayMs) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}
