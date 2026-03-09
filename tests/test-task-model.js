// Test 4.1-4.4: TaskModel — fromGraphJson, toCreatePayload, toUpdatePayload, sorts, filters
import GLib from 'gi://GLib';
import { TaskModel, sortByName, sortByDueDate, sortByPriority } from '../src/task-model.js';

const loop = new GLib.MainLoop(null, false);

function assert(name, condition) {
    if (condition) {
        console.log(`PASS: ${name}`);
        return true;
    } else {
        console.error(`FAIL: ${name}`);
        return false;
    }
}

async function test() {
    let passed = 0;
    let failed = 0;
    const check = (name, cond) => { if (assert(name, cond)) passed++; else failed++; };

    // ── 4.1: fromGraphJson ──────────────────────────────────────────

    const graphTask = {
        id: 'AAMk123',
        title: 'Buy groceries',
        status: 'notStarted',
        importance: 'high',
        createdDateTime: '2026-03-09T10:00:00Z',
        lastModifiedDateTime: '2026-03-09T10:05:00Z',
        body: {content: 'Milk, eggs', contentType: 'text'},
        dueDateTime: {dateTime: '2026-03-15T00:00:00', timeZone: 'UTC'},
        completedDateTime: null,
        categories: ['Shopping'],
        checklistItems: [
            {id: 'item1', displayName: 'Milk', isChecked: false},
            {id: 'item2', displayName: 'Eggs', isChecked: true, checkedDateTime: '2026-03-09T12:00:00Z'},
        ],
    };

    const task = TaskModel.fromGraphJson(graphTask, 'list-abc');

    check('fromGraphJson: id', task.id === 'AAMk123');
    check('fromGraphJson: listId', task.listId === 'list-abc');
    check('fromGraphJson: title', task.title === 'Buy groceries');
    check('fromGraphJson: status', task.status === 'notStarted');
    check('fromGraphJson: importance', task.importance === 'high');
    check('fromGraphJson: dueDateTime is Date', task.dueDateTime instanceof Date);
    check('fromGraphJson: dueDateTime value', task.dueDateTime.getUTCDate() === 15);
    check('fromGraphJson: completedDateTime null', task.completedDateTime === null);
    check('fromGraphJson: body', task.body === 'Milk, eggs');
    check('fromGraphJson: categories', task.categories[0] === 'Shopping');
    check('fromGraphJson: checklistItems count', task.checklistItems.length === 2);
    check('fromGraphJson: checklistItems[1].isChecked', task.checklistItems[1].isChecked === true);

    // Backward compat aliases
    check('fromGraphJson: _uid alias', task._uid === 'AAMk123');
    check('fromGraphJson: _due alias', task._due === task.dueDateTime);
    check('fromGraphJson: _taskList alias', task._taskList === 'list-abc');

    // Null/missing fields
    const minimal = TaskModel.fromGraphJson({id: 'x', title: 'Minimal'}, 'list-1');
    check('fromGraphJson: minimal task', minimal.title === 'Minimal');
    check('fromGraphJson: minimal dueDateTime', minimal.dueDateTime === null);
    check('fromGraphJson: minimal categories', minimal.categories.length === 0);
    check('fromGraphJson: minimal checklistItems', minimal.checklistItems.length === 0);

    // ── 4.2: Status/importance mapping ──────────────────────────────

    const completed = TaskModel.fromGraphJson({id: 'c1', title: 'Done', status: 'completed',
        completedDateTime: {dateTime: '2026-03-10T14:00:00', timeZone: 'UTC'}}, 'l1');
    check('status completed', completed.status === 'completed');
    check('completedDateTime parsed', completed.completedDateTime instanceof Date);

    // ── 4.3: Sort functions ─────────────────────────────────────────

    const tasks = [
        TaskModel.fromGraphJson({id: '1', title: 'Zebra', importance: 'low', dueDateTime: {dateTime: '2026-03-20T00:00:00', timeZone: 'UTC'}}, 'l'),
        TaskModel.fromGraphJson({id: '2', title: 'Apple', importance: 'high', dueDateTime: {dateTime: '2026-03-10T00:00:00', timeZone: 'UTC'}}, 'l'),
        TaskModel.fromGraphJson({id: '3', title: 'Mango', importance: 'normal'}, 'l'), // no due date
    ];

    const byName = [...tasks].sort(sortByName);
    check('sortByName: Apple first', byName[0].title === 'Apple');
    check('sortByName: Zebra last', byName[2].title === 'Zebra');

    const byDue = [...tasks].sort(sortByDueDate);
    check('sortByDueDate: earliest first', byDue[0].title === 'Apple');
    check('sortByDueDate: no-due-date last', byDue[2].title === 'Mango');

    const byPri = [...tasks].sort(sortByPriority);
    check('sortByPriority: high first', byPri[0].title === 'Apple');
    check('sortByPriority: low last', byPri[2].title === 'Zebra');

    // ── 4.4: toCreatePayload / toUpdatePayload ──────────────────────

    const createPayload = TaskModel.toCreatePayload('New task', {
        importance: 'high',
        dueDateTime: new Date('2026-04-01T00:00:00Z'),
        body: 'Some notes',
        categories: ['Work'],
    });
    check('toCreatePayload: title', createPayload.title === 'New task');
    check('toCreatePayload: importance', createPayload.importance === 'high');
    check('toCreatePayload: dueDateTime.timeZone', createPayload.dueDateTime.timeZone === 'UTC');
    check('toCreatePayload: body.contentType', createPayload.body.contentType === 'text');
    check('toCreatePayload: categories', createPayload.categories[0] === 'Work');

    const updatePayload = TaskModel.toUpdatePayload({status: 'completed', title: 'Updated'});
    check('toUpdatePayload: status', updatePayload.status === 'completed');
    check('toUpdatePayload: title', updatePayload.title === 'Updated');
    check('toUpdatePayload: no extra keys', !('importance' in updatePayload));

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    loop.quit();
}

test();
loop.runAsync();
