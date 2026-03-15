# Feature 1: List Management — Implementation Report

## Phase 1: Research Findings

### Current Dropdown Menu (`_onTaskListMenuOpen`)
- Located at line ~1032 in extension.js
- Iterates `this._taskLists` (array of `{uid, name, backendId}`)
- Creates `PopupMenu.PopupMenuItem` for each list with backend icon
- Adds separator + "All Tasks" item at bottom
- Active list gets `PopupMenu.Ornament.DOT`

### SyncEngine CRUD Pattern
- `_getBackendForList(listId)` routes to correct backend via `_listBackendMap`
- Existing CRUD: `createTask`, `completeTask`, `uncompleteTask`, `updateTaskTitle`, `deleteTask`
- After each operation: updates local cache, saves to disk, emits signal
- Need to add: `createTaskList`, `renameTaskList`, `deleteTaskList`

### API Endpoints Available

**Microsoft Graph:**
- Create list: `POST /me/todo/lists` with `{displayName: "name"}`
- Rename list: `PATCH /me/todo/lists/{id}` with `{displayName: "newName"}`
- Delete list: `DELETE /me/todo/lists/{id}`
- GraphHttpClient supports: get, post, patch, delete

**Todoist REST API v1:**
- Create project: `POST /api/v1/projects` with `{name: "name"}`
- Rename project: `POST /api/v1/projects/{id}` with `{name: "newName"}`
- Delete project: `DELETE /api/v1/projects/{id}`
- TodoistHttpClient supports: get, post, delete (no patch method, but POST works for updates)

### Backend Adapter Pattern
- `backend.js`: Abstract base class with `listTaskLists()` — need to add `createTaskList`, `renameTaskList`, `deleteTaskList`
- `graph-backend.js`: Wraps `GraphApi`, tags lists with `_backendId: 'microsoft'`
- `todoist-backend.js`: Wraps `TodoistApi`, tags lists with `_backendId: 'todoist'`

### Inline Edit Pattern (for task titles)
- `_onEditTask(checkbox)` in extension.js (line ~2114)
- Sets `this._editingTask = true` to block tree rebuilds
- Hides label, inserts `St.Entry` in same parent container
- Enter = save (calls `syncEngine.updateTaskTitle`), Escape = cancel
- Cleanup function handles widget destruction safely

### GNOME Shell ModalDialog
- Import: `import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js'`
- Constructor: `new ModalDialog.ModalDialog({styleClass: '...'})`
- Content box: `this.contentLayout` (St.BoxLayout)
- Buttons: `this.addButton({label, action, key, default})`
- Open: `dialog.open(global.get_current_time())`
- Close: `dialog.close(global.get_current_time())`

## Phase 2: Implementation Plan

### 1. API Layer Changes
- **graph-api.js**: Add `createTaskList(name)`, `renameTaskList(id, name)`, `deleteTaskList(id)`
- **todoist-api.js**: Add `createTaskList(name)`, `renameTaskList(id, name)`, `deleteTaskList(id)`

### 2. Backend Adapter Changes
- **backend.js**: Add abstract methods `createTaskList`, `renameTaskList`, `deleteTaskList`
- **graph-backend.js**: Implement the three methods delegating to GraphApi
- **todoist-backend.js**: Implement the three methods delegating to TodoistApi

### 3. SyncEngine Changes
- **sync-engine.js**: Add `createTaskList(backendId, name)`, `renameTaskList(listId, newName)`, `deleteTaskList(listId)`
- Each updates cache + emits 'lists-changed'

### 4. UI Changes (extension.js)
- Import ModalDialog
- Modify `_onTaskListMenuOpen` to:
  - Add edit/delete icon buttons to each list item
  - Add "Create new list..." item at bottom (after All Tasks)
- Add `_onCreateTaskList()`: Opens ModalDialog with text entry
- Add `_onEditTaskList(taskList, item)`: Inline rename (similar to _onEditTask)
- Add `_onDeleteTaskList(taskList)`: Confirmation then delete

### 5. CSS Changes (stylesheet.css)
- Styles for list edit/delete buttons in dropdown
- Styles for create-list dialog

## Phase 3: Implementation

See git diff for full implementation details.

## Phase 4: Validation

Build result and review — documented below after implementation.
