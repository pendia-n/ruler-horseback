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

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("PRAGMA setup failed: {}", e))?;

    Ok(conn)
}

/// Check if a column exists in a table
fn column_exists(conn: &Connection, table: &str, col: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({})", table);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for name in rows {
        if name.map_err(|e| e.to_string())? == col { return Ok(true); }
    }
    Ok(false)
}

pub fn init_db() -> Result<(), String> {
    let conn = get_conn()?;

    // Create tables if they don't exist (no data loss)
    conn.execute_batch(
        "
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
        "
    ).map_err(|e| format!("Schema init failed: {}", e))?;

    // Migrate: add columns that may be missing from older versions
    // todos.lost
    if !column_exists(&conn, "todos", "lost")? {
        conn.execute("ALTER TABLE todos ADD COLUMN lost INTEGER DEFAULT 0", [])
            .map_err(|e| format!("Migration add lost failed: {}", e))?;
    }
    // todos.resolution
    if !column_exists(&conn, "todos", "resolution")? {
        conn.execute("ALTER TABLE todos ADD COLUMN resolution TEXT DEFAULT ''", [])
            .map_err(|e| format!("Migration add resolution failed: {}", e))?;
    }
    // todos.due_processed
    if !column_exists(&conn, "todos", "due_processed")? {
        conn.execute("ALTER TABLE todos ADD COLUMN due_processed INTEGER DEFAULT 0", [])
            .map_err(|e| format!("Migration add due_processed failed: {}", e))?;
    }

    // Create indexes
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_todos_user_deadline ON todos(user_id, deadline);
        CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed);
        CREATE INDEX IF NOT EXISTS idx_todos_category ON todos(category_id);
        CREATE INDEX IF NOT EXISTS idx_todos_lost ON todos(lost);
        CREATE INDEX IF NOT EXISTS idx_todos_due_processed ON todos(due_processed);
        CREATE INDEX IF NOT EXISTS idx_delete_log_user_created ON delete_log(user_id, created_at);
        "
    ).map_err(|e| format!("Index init failed: {}", e))?;

    Ok(())
}
