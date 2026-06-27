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
# rulerhorseback

A **Tauri v2** desktop todo app — rebuilt from [snakedesk](#snakedesk-md) in **Rust + Web UI** with a fresh **light theme**.

Binary: `src-tauri/target/release/rulerhorseback` (~5.1 MB)

---

## Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | **Tauri v2** (Rust) — native WebView, no Electron |
| Frontend | Vanilla HTML/CSS/JS (no build step) |
| Backend | Rust via Tauri commands |
| Database | **MySQL** (same credentials as original) |

---

## Features

| Feature | Behavior |
|---------|----------|
| **Auth** | Auto-detects register vs login on username (300ms debounce) |
| **Register** | Password: ≥7 chars, 1 uppercase, 1 digit |
| **Upcoming** | Shows max **7** upcoming todos with live countdown |
| **Countdown** | JS timer updates every 3 seconds |
| **Overdue** | Auto-removed from upcoming list |
| **Add Todo** | Title, description, date picker, time (HH:MM) |
| **Edit Todo** | Title, description, date+time; **deadline editable once only** |
| **View All** | Modal with all todos, overdue highlighted in red |
| **Session** | User ID persisted in `localStorage` |

---

## Database

**Database**: `snakedesk`
**Tables**: `users`, `todos`

```bash
# Run migration (already applied):
mysql -u nosensetxt -pqweasdzxc < migrations/001_initial.sql
```

### Schema

```sql
CREATE TABLE users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE todos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    deadline DATETIME NOT NULL,
    edit_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
```

---

## Dev

```bash
# Rust toolchain (once):
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"

# Install deps:
npm install

# Dev mode (hot reload):
npm run dev

# Build release:
npm run build
# Output: src-tauri/target/release/rulerhorseback
#       src-tauri/target/release/bundle/macos/rulerhorseback.app
```

---

## UI Theme

| Token | Value |
|-------|-------|
| Background | `#f8f9fa` |
| Surface | `#ffffff` |
| Primary | `#6366f1` (indigo) |
| Text | `#1e293b` |
| Error/Overdue | `#ef4444` |
| Success | `#22c55e` |
| Border | `#e2e8f0` |
| Radius | `10px` |
| Font | System stack (SF Pro, Segoe UI) |

---

## Project Structure

```
rulerhorseback/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── src/
│   │   ├── main.rs          # Entry point
│   │   ├── lib.rs           # Tauri setup + command registration
│   │   ├── db.rs            # MySQL connection pool
│   │   ├── auth.rs          # register, login, check_username
│   │   └── todos.rs         # CRUD + countdown helpers
│   ├── capabilities/
│   │   └── default.json
│   └── icons/
│       ├── icon.png         # 333x333 (source)
│       ├── 32x32.png
│       └── 128x128.png
├── ui/
│   ├── index.html
│   ├── style.css            # Light theme, ~500 lines
│   └── app.js               # Full SPA: auth + dashboard + modals
├── migrations/
│   └── 001_initial.sql
└── package.json
```

---

## API (Tauri Commands)

All commands return `Result<T, String>` (errors as strings).

### Auth
| Command | Args | Returns |
|---------|------|---------|
| `check_username` | `username: String` | `"login"` or `"register"` |
| `register_user` | `username, password` | `AuthResult` |
| `login_user` | `username, password` | `AuthResult` |

### Todos
| Command | Args | Returns |
|---------|------|---------|
| `get_upcoming_todos` | `user_id: u32` | `Vec<Todo>` (max 7, deadline >= now) |
| `get_all_todos` | `user_id: u32` | `Vec<TodoWithStatus>` (all, with countdown) |
| `get_todo` | `id: u32` | `Todo` |
| `add_todo` | `user_id, title, description, deadline` | `bool` |
| `update_todo` | `id, title, description, deadline, edit_count, current_deadline` | `bool` |

---

## Key UX Rules (replicated from original)

1. **Upcoming list = 7 items max** — enforced by SQL `LIMIT 7`
2. **Overdue items deleted** — SQL filter `deadline >= NOW()`, not just hidden
3. **Countdown updates every 3s** — JS `setInterval`
4. **Deadline editable once** — `edit_count` column checked in both Rust backend and JS frontend
5. **Username debounce 300ms** — JS `setTimeout`
6. **Register password rules** — validated in both frontend (hints) and Rust backend
==========
# RulerHorseback Todo GUI — Desktop Todo App (Tauri + Rust + SQLite)

Live at: API worker at `https://rulerhorseback-api.pendia-community.workers.dev`

## What It Is

A **native desktop todo application** built with Tauri v2 (Rust backend + HTML/CSS/JS frontend). Features credit-based monetization: 50 free credits on registration, edits cost credits (1st free, 4cr edits 2-5, 10cr 6th+), deletes cost credits (10cr <7/week, 50cr 7+/week). Users purchase credit packs via a Cloudflare Worker storefront with Stripe.

## Tech Stack

| Layer | Technology |
|---|---|
| **Desktop** | Tauri v2 (Rust backend) |
| **Local DB** | SQLite via rusqlite |
| **Frontend** | Vanilla HTML/CSS/JS |
| **API Storefront** | Cloudflare Worker (Hono + D1) + Stripe |

## Key Features

- Todo CRUD with categories and color labels
- Credit-based monetization: edits/deletes cost credits
- 50 free credits on registration
- Stripe credit packs: $4/100cr, $10/300cr, $25/1000cr
- Upcoming todo list with live countdown
- View All Todos modal with search/filter (90% window)
- Overdue highlighting with completed toggle
- Local-first SQLite — no cloud dependency for core app
- Credit purchases go through a Cloudflare Worker API with D1
