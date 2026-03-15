# Docket

A GNOME Shell extension that displays your tasks from **Microsoft To Do** and **Todoist** next to the calendar widget in the date menu. Both backends can run simultaneously — tasks from all authenticated services appear in a unified view.

![Docket screenshot](screenshot.png)

## Features

### Multi-Backend Support
- **Microsoft To Do** — OAuth2 device code flow via Microsoft Graph API
- **Todoist** — API token authentication via Todoist REST/Sync API
- Both backends active simultaneously — no need to choose one or the other
- Tasks from all services merged into a single, unified task list view

### Task Management
- **Quick-add tasks** with an inline text entry ("Add a task...")
- **Inline calendar date picker** — set due dates on new tasks before adding them (Today / Clear shortcuts included)
- **Mark tasks as completed/uncompleted** via checkbox
- **Delete tasks** with a per-task delete button (trash icon)
- **Edit task titles** inline with a per-task edit button (pencil icon)
- **Checklist/subtask support** — expand tasks to view and toggle checklist items (Graph) or subtasks (Todoist)

### Task Organization
- **Switch between task lists** using header navigation arrows or the dropdown menu
- **Merge all task lists** into a single combined view
- **Filter tasks by category** — Past, Today, Tomorrow, Next 7 Days, Scheduled, Unscheduled, Not Cancelled, Started
- **Sort tasks** by name, due date, or priority
- **Group overdue tasks** under a unified "Past" header
- **Hide completed tasks** — four modes:
  - Never
  - Immediately
  - After a period of time (configurable seconds/minutes/hours/days)
  - After a specific time of day (configurable hour:minute)
- **Hide empty/completed task lists** from the list switcher
- **Hide header** when only one task list exists
- **Reorder task lists** via drag-and-drop in Settings
- **Toggle task list visibility** — disable specific lists from appearing

### Offline Support
- **Disk-cached tasks** — tasks persist to `~/.cache/docket/task-cache.json` so they're available immediately on startup and during network outages
- **Offline banner** — amber "No internet" notification with relative timestamp of last successful sync
- **Automatic recovery** — resumes syncing when connectivity returns

### Sync Engine
- **Delta/incremental sync** — only fetches changes since last sync (Graph delta queries, Todoist sync tokens)
- **Background polling** — syncs every 30 seconds while the panel is open, every 5 minutes (configurable) when closed
- **Full sync on startup** — loads cache instantly, then fetches latest from network
- **Multi-backend CRUD routing** — each task list is tagged with its backend, so creates/updates/deletes route to the correct API automatically

### UI
- Lives in the GNOME Shell date menu, next to the calendar widget
- Matches the height of the calendar widget automatically
- Scrollable task list with lazy loading
- Keyboard accessible (focus navigation, enter to activate)
- RTL layout support
- Compatible with custom GNOME Shell themes

## Installation

### Dependencies

- GNOME Shell 48 or 49
- libsoup3
- libsecret (GNOME Keyring)

### Build from Source

Install build dependencies for your distro:

**Ubuntu 24.04+**
```bash
sudo apt install meson ninja-build gettext libglib2.0-bin libglib2.0-dev-bin gir1.2-soup-3.0 gir1.2-secret-1
```

**Fedora 40+**
```bash
sudo dnf install meson ninja-build gettext glib2-devel libsoup3 libsecret
```

**CachyOS / Arch Linux**
```bash
sudo pacman -S meson ninja gettext glib2 libsoup3 libsecret
```

Then build and install:

```bash
git clone https://github.com/DanielTylerReece/Docket.git
cd Docket
meson setup builddir --prefix="$HOME/.local"
meson install -C builddir
```

Restart GNOME Shell (log out/in on Wayland, or Alt+F2 → `r` on X11) and enable via the GNOME Extensions app.

To rebuild after changes:

```bash
meson setup builddir --prefix="$HOME/.local" --wipe && meson install -C builddir
```

## Setup

### Microsoft To Do

1. Open the extension preferences (GNOME Extensions app → Docket → Settings)
2. Click **Sign In** under Microsoft Account
3. Complete the device code flow — the code is copied to your clipboard automatically
4. Your Microsoft To Do task lists will appear

### Todoist

1. Open the extension preferences
2. Under **Todoist Account**, paste your API token
   - Find your token at: Todoist → Settings → Integrations → Developer
3. Click **Save Token** — the token is validated against the Todoist API before saving
4. Your Todoist projects will appear as task lists

Both accounts can be connected at the same time. Sign out individually from either service in Settings.

![Docket settings](screenshot-settings.png)

## Settings

| Setting | Description |
|---|---|
| Merge task lists | Combine all lists into a single view |
| Group past tasks | Group overdue tasks under a "Past" header |
| Hide header for singular task lists | Hide the list switcher when only one list exists |
| Hide empty completed task lists | Don't show lists that are empty or fully completed |
| Hide completed tasks | Never / Immediately / After time period / After time of day |
| Show only selected categories | Enable category-based task filtering |
| Task list order | Drag to reorder lists in Settings |
| Disabled task lists | Toggle visibility of individual lists |
| Sync interval | Background polling interval in minutes (default: 5) |

## Architecture

```
extension.js          ← UI: panel widget, task rendering, quick-add, calendar picker
  ↓
sync-engine.js        ← Cache, delta sync, polling, offline detection, CRUD routing
  ↓
graph-backend.js      ← Microsoft Graph adapter (BackendAdapter interface)
todoist-backend.js    ← Todoist adapter (BackendAdapter interface)
  ↓
graph-api.js          ← Graph To Do REST API + delta queries
todoist-api.js        ← Todoist REST API v1 + Sync API
  ↓
graph-client.js       ← HTTP client for Graph (Soup3, retry, auth headers)
todoist-client.js     ← HTTP client for Todoist (Soup3, retry, rate limiting)
  ↓
auth.js               ← Microsoft OAuth2 device code flow + libsecret storage
todoist-auth.js       ← Todoist API token + libsecret storage
  ↓
task-model.js         ← Unified data model, Graph/Todoist converters, serialization
backend.js            ← Abstract BackendAdapter interface
utils.js              ← Constants, debounce, sorting helpers
prefs.js              ← Settings UI (GTK4/Adwaita)
```

## Credits

Originally forked from [Task Widget](https://gitlab.com/jmiskinis/gnome-shell-extension-task-widget) by Juozas Miskinis. Rewritten to use Microsoft Graph API and Todoist API instead of Evolution Data Server.

## License

GPL-2.0
