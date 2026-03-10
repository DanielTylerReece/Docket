'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


export const _debounceTimeoutIds = new Map();
export const ELLIPSIS_CHAR_ = '\u2026';
export const ARC_UP_LEFT_CHAR_ = '\u256F';
export const ARC_UP_RIGHT_CHAR_ = '\u2570';
export const EM_DASH_CHAR_ = '\u2014';
export const MINUTES_PER_HOUR_ = 60;
export const MINUTES_PER_DAY_ = MINUTES_PER_HOUR_ * 24;
export const MSECS_IN_DAY_ = MINUTES_PER_DAY_ * 60 * 1000;
export const LL_THRESHOLD_ = 100;

export const TIME_UNITS_ = {
    seconds: 0,
    minutes: 1,
    hours: 2,
    days: 3
};

export const HIDE_COMPLETED_TASKS_ = {
    never: 0,
    immediately: 1,
    'after-time-period': 2,
    'after-specified-time': 3
};

export const HIDE_COMPLETED_TASKS_IS_TIME_DEPENDENT_ = (value) => {
    return [
        HIDE_COMPLETED_TASKS_['after-time-period'],
        HIDE_COMPLETED_TASKS_['after-specified-time']
    ].includes(value);
};

/**
 * Sorts task lists according to the given order of their uids. If task list
 * uid is not in the list, move it to the end of the list.
 *
 * @param {string[]} order - A list of task list uids.
 * @param {object} a - Task list object.
 * @param {object} b - Task list object.
 * @returns {int} Negative, zero or positive value to facilitate sorting.
 */
export function customSort_(order, a, b) {
    if (order.indexOf(a.uid) === -1) return 1;

    if (order.indexOf(b.uid) === -1) return -1;

    return order.indexOf(a.uid) - order.indexOf(b.uid);
}

/**
 * Requests an asynchronous write of bytes into the stream.
 *
 * @param {Gio.OutputStream} output - Stream to write bytes to.
 * @param {ByteArray} bytes - The bytes to write.
 * @param {number} priority - The io priority of the request.
 * @param {Gio.Cancellable} [cancellable] - Cancellable object.
 * @returns {Promise<number>} Number of bytes written to the stream.
 */
export function writeBytesAsync_(output, bytes, priority, cancellable = null) {
    return new Promise((resolve, reject) => {
        output.write_bytes_async(bytes, priority, cancellable, (file, res) => {
            try {
                resolve(file.write_bytes_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Waits for the subprocess to terminate and checks its exit status.
 *
 * @param {Gio.Subprocess} process - Process.
 * @param {Gio.Cancellable} [cancellable] - Cancellable object.
 * @returns {Promise<boolean>} `true` if successful.
 */
export function waitCheckAsync_(process, cancellable = null) {
    return new Promise((resolve, reject) => {
        process.wait_check_async(cancellable, (self, result) => {
            try {
                if (!self.wait_check_finish(result)) {
                    const status = self.get_exit_status();

                    throw new Gio.IOErrorEnum({
                        code: Gio.io_error_from_errno(status),
                        message: GLib.strerror(status)
                    });
                }

                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * A simple debounce function. Returns a function, that, as long as it
 * continues to be invoked, will not be triggered. The function will be called
 * after it stops being called for `wait` milliseconds.
 *
 * @param {Function} func - Function to debounce.
 * @param {string} id - Function id.
 * @param {number} wait - Milliseconds to wait before calling the function.
 * @param {boolean} [immediate] - If true, trigger the function on the
 * leading edge, instead of the trailing.
 * @returns {Function} The `func` function with all its arguments.
 */
export function debounce_(func, id, wait, immediate = false) {
    return (...args) => {
        const later = () => {
            GLib.source_remove(_debounceTimeoutIds.get(id));
            _debounceTimeoutIds.delete(id);

            if (!immediate) func(...args);
        };

        if (_debounceTimeoutIds.get(id))
            GLib.source_remove(_debounceTimeoutIds.get(id));

        _debounceTimeoutIds.set(
            id,
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, later)
        );

        if (immediate && !_debounceTimeoutIds.get(id)) func(...args);
    };
}

/**
 * Removes any remaining timeouts created by the `debounce_` function.
 */
export function removeDebounceTimeouts_() {
    for (const sourceId of _debounceTimeoutIds.values())
        GLib.source_remove(sourceId);
    _debounceTimeoutIds.clear();
}

/**
 * Clear all user-specific data from GSettings after sign-out.
 * @param {Gio.Settings} settings
 */
export function clearAccountData_(settings) {
    settings.reset('delta-tokens');
    settings.reset('task-list-order');
    settings.reset('disabled-task-lists');
    settings.reset('last-active');
}
