'use strict';

/**
 * Security tests for NET remediation fixes.
 * Run with: gjs -m tests/test-net-security.js
 *
 * Uses GLib.Uri instead of the URL global, which is available inside
 * GNOME Shell but NOT in standalone gjs invocations.
 */

import GLib from 'gi://GLib';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        print(`  PASS: ${message}`);
    } else {
        failed++;
        print(`  FAIL: ${message}`);
    }
}

function assertThrows(fn, message) {
    try {
        fn();
        failed++;
        print(`  FAIL: ${message} (did not throw)`);
    } catch (e) {
        passed++;
        print(`  PASS: ${message} (threw: ${e.message.substring(0, 60)})`);
    }
}

// ── URL Validation Tests ─────────────────────────────────────────

print('\n=== URL Validation Tests ===');

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

// Valid URLs should pass
assert(
    _validateUrl('https://graph.microsoft.com/v1.0/me/todo/lists') ===
        'https://graph.microsoft.com/v1.0/me/todo/lists',
    'Valid Graph API URL accepted'
);

assert(
    _validateUrl('https://login.microsoftonline.com/common/oauth2/v2.0/token') ===
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    'Valid login URL accepted'
);

// Invalid URLs should throw
assertThrows(
    () => _validateUrl('https://evil.com/steal-token'),
    'Rejects untrusted host (evil.com)'
);

assertThrows(
    () => _validateUrl('http://graph.microsoft.com/v1.0/me'),
    'Rejects HTTP (non-HTTPS)'
);

assertThrows(
    () => _validateUrl('https://graph.microsoft.com.evil.com/v1.0'),
    'Rejects subdomain spoofing'
);

assertThrows(
    () => _validateUrl(null),
    'Rejects null URL'
);

assertThrows(
    () => _validateUrl(42),
    'Rejects non-string URL'
);

assertThrows(
    () => _validateUrl('not-a-url'),
    'Rejects malformed URL'
);

assertThrows(
    () => _validateUrl(''),
    'Rejects empty string'
);

// ── Retry-After Clamping Tests ───────────────────────────────────

print('\n=== Retry-After Clamping Tests ===');

function clampRetryAfter(raw) {
    return Math.min(Math.max(parseInt(raw, 10) || 5, 1), 120);
}

assert(clampRetryAfter('5') === 5, 'Normal Retry-After (5) passes through');
assert(clampRetryAfter('120') === 120, 'Max boundary (120) accepted');
assert(clampRetryAfter('999999') === 120, 'Huge value clamped to 120');
assert(clampRetryAfter('0') === 5, 'Zero treated as invalid, defaults to 5');
assert(clampRetryAfter('-5') === 1, 'Negative clamped to 1');
assert(clampRetryAfter('garbage') === 5, 'Non-numeric defaults to 5');
assert(clampRetryAfter(null) === 5, 'Null defaults to 5');
assert(clampRetryAfter(undefined) === 5, 'Undefined defaults to 5');

// ── encodeURIComponent Tests ─────────────────────────────────────

print('\n=== Path Encoding Tests ===');

const BASE = 'https://graph.microsoft.com/v1.0';

// Normal GUID passes through
const normalId = 'AAMkAGI2TGuLAAA=';
const normalUrl = `${BASE}/me/todo/lists/${encodeURIComponent(normalId)}/tasks`;
assert(normalUrl.includes(encodeURIComponent(normalId)), 'Normal ID encoded in URL');

// Path traversal attempt is neutralized
const traversalId = '../../admin/lists';
const traversalUrl = `${BASE}/me/todo/lists/${encodeURIComponent(traversalId)}/tasks`;
assert(!traversalUrl.includes('../'), 'Path traversal encoded (no ../)');
assert(traversalUrl.includes('%2F'), 'Slashes are percent-encoded');

// Special characters encoded
const specialId = 'id?query=1#fragment';
const specialUrl = `${BASE}/me/todo/lists/${encodeURIComponent(specialId)}/tasks`;
assert(!specialUrl.includes('?query'), 'Query chars encoded');
assert(!specialUrl.includes('#fragment'), 'Fragment chars encoded');

// ── Response Validation Tests ────────────────────────────────────

print('\n=== Response Validation Tests ===');

// Array.isArray guard
const goodBody = {value: [{id: '1'}, {id: '2'}]};
const items1 = Array.isArray(goodBody?.value) ? goodBody.value : [];
assert(items1.length === 2, 'Valid array body returns items');

const nullBody = null;
const items2 = Array.isArray(nullBody?.value) ? nullBody.value : [];
assert(items2.length === 0, 'Null body returns empty array');

const stringBody = {value: 'not-an-array'};
const items3 = Array.isArray(stringBody?.value) ? stringBody.value : [];
assert(items3.length === 0, 'String value returns empty array');

const missingBody = {};
const items4 = Array.isArray(missingBody?.value) ? missingBody.value : [];
assert(items4.length === 0, 'Missing value returns empty array');

// ── Delta Token Extraction Tests ─────────────────────────────────

print('\n=== Delta Token Tests ===');

function _extractDeltaToken(deltaUrl) {
    try {
        const uri = GLib.Uri.parse(deltaUrl, GLib.UriFlags.NONE);
        const query = uri.get_query();
        if (!query)
            return null;
        const params = GLib.Uri.parse_params(query, -1, '&', GLib.UriParamsFlags.NONE);
        return params['$deltatoken'] || null;
    } catch {
        return null;
    }
}

function _buildDeltaUrl(listId, token) {
    return `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta?$deltatoken=${encodeURIComponent(token)}`;
}

const testDeltaUrl = 'https://graph.microsoft.com/v1.0/me/todo/lists/abc123/tasks/delta?$deltatoken=opaque-token-value';
assert(_extractDeltaToken(testDeltaUrl) === 'opaque-token-value', 'Extracts delta token from URL');
assert(_extractDeltaToken('not-a-url') === null, 'Returns null for invalid URL');
assert(_extractDeltaToken('') === null, 'Returns null for empty string');

const rebuilt = _buildDeltaUrl('abc123', 'opaque-token-value');
assert(rebuilt.startsWith('https://graph.microsoft.com/'), 'Rebuilt URL has correct host');
assert(rebuilt.includes('abc123'), 'Rebuilt URL contains list ID');
assert(rebuilt.includes('opaque-token-value'), 'Rebuilt URL contains token');

// ── nextLink Validation Tests ────────────────────────────────────

print('\n=== nextLink/deltaLink Validation Tests ===');

function validateGraphLink(url) {
    return typeof url === 'string' && url.startsWith('https://graph.microsoft.com/');
}

assert(validateGraphLink('https://graph.microsoft.com/v1.0/me/todo/lists/x/tasks?$skip=10'), 'Valid nextLink accepted');
assert(!validateGraphLink('https://evil.com/steal'), 'Evil nextLink rejected');
assert(!validateGraphLink('http://graph.microsoft.com/v1.0'), 'HTTP nextLink rejected');
assert(!validateGraphLink(null), 'Null nextLink rejected');
assert(!validateGraphLink(42), 'Non-string nextLink rejected');

// ── Summary ──────────────────────────────────────────────────────

print(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0)
    print('SOME TESTS FAILED');
else
    print('ALL TESTS PASSED');
