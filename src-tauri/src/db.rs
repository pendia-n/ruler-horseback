use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

static DB_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_db_path(path: PathBuf) {
    let mut p = DB_PATH.lock().unwrap();
    *p = Some(path);
}

fn default_db_path() -> PathBuf {
    if let Some(home) = dirs::data_local_dir() {
        let dir = home.join("rulerhorseback");
        std::fs::create_dir_all(&dir).ok();
        dir.join("rulerhorseback.db")
    } else {
        PathBuf::from("rulerhorseback.db")
    }
}

pub fn get_conn() -> Result<Connection, String> {
    let path = {
        let p = DB_PATH.lock().unwrap();
        p.clone().unwrap_or_else(default_db_path)
    };

    let conn = Connection::open(&path).map_err(|e| format!("DB connection failed: {}", e))?;

    // WAL mode for better concurrent access
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("PRAGMA setup failed: {}", e))?;

    Ok(conn)
}

pub fn init_db() -> Result<(), String> {
    let conn = get_conn()?;

    conn.execute_batch(
        "
        PRAGMA foreign_keys = OFF;

        -- Drop ALL old tables to eliminate any stale FK constraints from previous versions
        DROP TABLE IF EXISTS credit_transactions;
        DROP TABLE IF EXISTS users;
        DROP TABLE IF EXISTS todos;
        DROP TABLE IF EXISTS categories;
        DROP TABLE IF EXISTS delete_log;

        -- No local users table — auth is on D1 via worker API

        CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            deadline TEXT NOT NULL,
            edit_count INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 0,
            category_id INTEGER DEFAULT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT DEFAULT '#6366f1',
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(user_id, name)
        );

        CREATE TABLE IF NOT EXISTS delete_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            cost INTEGER NOT NULL DEFAULT 0,
            todo_title TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_todos_user_deadline ON todos(user_id, deadline);
        CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed);
        CREATE INDEX IF NOT EXISTS idx_todos_category ON todos(category_id);
        CREATE INDEX IF NOT EXISTS idx_delete_log_user_created ON delete_log(user_id, created_at);
        "
    ).map_err(|e| format!("Schema init failed: {}", e))?;

    Ok(())
}
