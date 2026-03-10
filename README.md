# Docket

A GNOME Shell extension that displays your Microsoft To Do tasks next to the calendar widget in the date menu.

## Features

- View and manage Microsoft To Do tasks from the GNOME Shell top bar
- Quick-add tasks with optional due date via inline calendar picker
- Merge task lists into a single view
- Group tasks by due date
- Mark tasks as completed/uncompleted
- Hide completed and empty task lists
- Toggle task list visibility and reorder
- Delta sync for efficient background updates
- Device code OAuth2 flow for secure Microsoft account sign-in

## Installation

### Dependencies

- GNOME Shell 48 or 49
- libsoup3
- libsecret (GNOME Keyring)

### From Source

```bash
git clone https://github.com/DanielTylerReece/Docket.git
cd docket
meson setup builddir --prefix="$HOME/.local"
meson install -C builddir
```

Then restart GNOME Shell (Alt+F2 → `r` on X11, or log out/in on Wayland) and enable via GNOME Extensions app.

## Setup

1. Open the extension preferences
2. Click **Sign In** under Microsoft Account
3. Complete the device code flow (code is copied to clipboard automatically)
4. Your Microsoft To Do task lists will appear

## Credits

Originally forked from [Task Widget](https://gitlab.com/jmiskinis/gnome-shell-extension-task-widget) by Juozas Miskinis. Rewritten to use Microsoft Graph API instead of Evolution Data Server.

## License

GPL-2.0
