# GUI Guide — RulerHorseback Todo

## What this app is

This is the **desktop GUI** for the todo system.  
The web worker exists only for account/credit sync and AI validation. The **main app is the GUI**.

## Core goal

Help the user finish or lose todos before the deadline, while keeping credit tracking automatic.

## Main screens

### Header
- Shows the **active todo count** (`x / 35`)
- Shows **credit balance**
- Shows **pending / done / lost / due counts**
- Shows a warning when you are near the 35 active todo cap

### Upcoming list
- Shows only active todos
- Sorted by deadline
- Each row has:
  - ✓ Mark Done
  - ✗ Mark Lost
  - Edit
  - Delete

### View All
- Shows all todos
- Status filter:
  - Pending
  - Done
  - Lost
  - Due
- Resolution text is shown for completed/lost items

### Mark Done modal
- Opens when you click ✓
- Requires a description
- Local junk filter checks the description first
- AI validation then scores it
- Score >= 7 → **+1 credit**
- Score < 7 → **-1 credit**
- The todo is marked DONE either way

### Mark Lost modal
- Opens when you click ✗
- Requires a reason
- Same local + AI validation as Mark Done
- The todo is marked LOST either way

## Credit rules

### AI validation
- **Score >= 7** → +1 credit
- **Score < 7** → -1 credit
- This happens immediately after submit
- The balance can go negative on the AI -1

### Batch credits
- Every **10 done** → +5 credits
- Every **5 lost** → -10 credits
- Every **due** → -12 credits
- Batch penalties do not apply if the balance is already 0

## Status logic

- `completed = 1` → DONE
- `lost = 1` → LOST
- `completed = 0 AND lost = 0 AND deadline passed` → DUE
- `completed = 0 AND lost = 0 AND deadline still ahead` → Pending

## Active cap

- Max **35 active todos**
- Active means:
  - not completed
  - not lost
  - not due-processed
  - deadline still ahead
- The add button is disabled when you reach 35

## Categories

- Categories already exist in the GUI
- You can filter upcoming todos by category
- You can create/delete categories
- The category dropdown is part of the todo form

## AI validation flow

1. User clicks Mark Done or Mark Lost
2. GUI opens the modal
3. User enters a description
4. Rust local junk filter runs first
5. GUI calls the worker AI endpoint
6. Worker checks the 1-minute rate limit
7. Worker calls OpenRouter fallback chain
8. AI returns score 0–12 + reason
9. Worker applies +/-1 credit immediately
10. GUI receives the score and updates the header

## Build / run commands

### Build the desktop app
```bash
cd /Users/nosensetxt/mvp/rulerhorseback-todo-gui/src-tauri
cargo tauri build
```

### Run in development
```bash
cd /Users/nosensetxt/mvp/rulerhorseback-todo-gui/src-tauri
cargo tauri dev
```

### Deploy the worker
```bash
cd /Users/nosensetxt/mvp/rulerhorseback-todo-gui/management
wrangler publish
```

## File map

- `ui/app.js` — GUI logic
- `ui/style.css` — GUI styling
- `src-tauri/src/todos.rs` — todo commands and validation
- `src-tauri/src/credits.rs` — credit helpers
- `src-tauri/src/db.rs` — database setup
- `management/worker/index.ts` — worker endpoints
- `management/schema.sql` — D1 schema

## What is NOT part of the GUI

- No web dashboard
- No extra category system
- No undo flow
- No separate “summary count” screen
- No credit history screen
- No notifications
- No export/backup

This guide reflects the current code state after the June update.
