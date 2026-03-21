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
