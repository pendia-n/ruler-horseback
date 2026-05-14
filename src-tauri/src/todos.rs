use crate::db::get_conn;
use crate::credits;
use rusqlite::params;
use serde::Serialize;
use chrono::NaiveDateTime;

#[derive(Serialize, Debug)]
pub struct Todo {
    pub id: u32,
    pub title: String,
    pub deadline: String,
    pub description: Option<String>,
    pub edit_count: u32,
    pub edit_cost: i32,
    pub completed: bool,
    pub category_id: Option<u32>,
}

#[derive(Serialize, Debug)]
pub struct TodoWithStatus {
    pub id: u32,
    pub title: String,
    pub deadline: String,
    pub status: String,
    pub edit_count: u32,
    pub description: Option<String>,
    pub completed: bool,
    pub category_id: Option<u32>,
}

#[derive(Serialize, Debug)]
pub struct Category {
    pub id: u32,
    pub name: String,
    pub color: String,
}

#[tauri::command]
pub fn get_upcoming_todos(user_id: String) -> Result<Vec<Todo>, String> {
    let conn = get_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, deadline, description, edit_count, completed, category_id \
         FROM todos WHERE user_id = ?1 AND deadline >= datetime('now') AND completed = 0 \
         ORDER BY deadline ASC LIMIT 7"
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    let todos: Vec<Todo> = stmt.query_map(params![user_id], |row| {
        Ok(Todo {
            id: row.get(0)?,
            title: row.get(1)?,
            deadline: row.get(2)?,
            description: row.get(3)?,
            edit_count: row.get(4)?,
            edit_cost: credits::get_edit_cost(row.get::<_, u32>(4)?),
            completed: row.get::<_, i32>(5)? != 0,
            category_id: row.get(6)?,
        })
    }).map_err(|e: rusqlite::Error| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(todos)
}

#[tauri::command]
pub fn get_all_todos(user_id: String) -> Result<Vec<TodoWithStatus>, String> {
    let conn = get_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, deadline, description, edit_count, completed, category_id \
         FROM todos WHERE user_id = ?1 ORDER BY deadline"
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    let now = chrono::Local::now().naive_local();
    let todos: Vec<TodoWithStatus> = stmt.query_map(params![user_id], |row| {
        let deadline_str: String = row.get(2)?;
        let dt = NaiveDateTime::parse_from_str(&deadline_str, "%Y-%m-%d %H:%M:%S").unwrap_or(now);
        let diff = dt.signed_duration_since(now);
        let completed: i32 = row.get(5)?;
        let status = if completed != 0 {
            "COMPLETED".to_string()
        } else if diff.num_seconds() <= 0 {
            "OVERDUE".to_string()
        } else {
            format!("{}d {}h {}m", diff.num_days(), diff.num_hours() % 24, diff.num_minutes() % 60)
        };
        Ok(TodoWithStatus {
            id: row.get(0)?,
            title: row.get(1)?,
            deadline: deadline_str,
            description: row.get(3)?,
            edit_count: row.get(4)?,
            status,
            completed: completed != 0,
            category_id: row.get(6)?,
        })
    }).map_err(|e: rusqlite::Error| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(todos)
}

#[tauri::command]
pub fn get_todo(id: u32) -> Result<Todo, String> {
    let conn = get_conn()?;
    let result = conn.query_row(
        "SELECT id, title, deadline, description, edit_count, completed, category_id \
         FROM todos WHERE id = ?1",
        params![id],
        |row| {
            Ok(Todo {
                id: row.get(0)?,
                title: row.get(1)?,
                deadline: row.get(2)?,
                description: row.get(3)?,
                edit_count: row.get(4)?,
                edit_cost: credits::get_edit_cost(row.get::<_, u32>(4)?),
                completed: row.get::<_, i32>(5)? != 0,
                category_id: row.get(6)?,
            })
        },
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub fn add_todo(user_id: String, title: String, description: String, deadline: String, category_id: Option<u32>) -> Result<bool, String> {
    let conn = get_conn()?;
    conn.execute(
        "INSERT INTO todos (user_id, title, description, deadline, edit_count, category_id) \
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![user_id, title, description, deadline, category_id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn update_todo(id: u32, title: String, description: String, deadline: String, user_id: String, category_id: Option<u32>) -> Result<bool, String> {
    let conn = get_conn()?;

    // Fetch current todo to determine changes
    let current: (String, String, u32, i32, Option<u32>) = conn.query_row(
        "SELECT title, deadline, edit_count, completed, category_id FROM todos WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
        |row| Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        )),
    ).map_err(|e: rusqlite::Error| format!("Todo not found: {}", e))?;

    let (current_title, current_deadline, edit_count, _completed, current_category_id) = current;

    // Check if anything actually changed
    let title_changed = title != current_title;
    let deadline_changed = deadline != current_deadline;
    let category_changed = category_id != current_category_id;
    let description_changed = description.trim() != conn.query_row(
        "SELECT description FROM todos WHERE id = ?1",
        params![id],
        |row| row.get::<_, Option<String>>(0),
    ).ok().flatten().unwrap_or_default().trim();

    let anything_changed = title_changed || deadline_changed || description_changed || category_changed;

    if !anything_changed {
        return Ok(true); // No changes, no cost
    }

    // Increment edit_count on save
    let new_edit_count = edit_count + 1;

    conn.execute(
        "UPDATE todos SET title = ?1, description = ?2, deadline = ?3, edit_count = ?4, \
         category_id = ?5, updated_at = datetime('now') WHERE id = ?6",
        params![title, description, deadline, new_edit_count, category_id, id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    Ok(true)
}

#[tauri::command]
pub fn toggle_completed(id: u32, user_id: String) -> Result<bool, String> {
    let conn = get_conn()?;

    let owner: Option<String> = conn.query_row(
        "SELECT user_id FROM todos WHERE id = ?1",
        params![id],
        |row| row.get(0),
    ).ok();

    match owner {
        Some(owner_id) if owner_id == user_id => {},
        _ => return Err("Todo not found or access denied".to_string()),
    }

    conn.execute(
        "UPDATE todos SET completed = CASE WHEN completed = 0 THEN 1 ELSE 0 END WHERE id = ?1",
        params![id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn get_categories(user_id: String) -> Result<Vec<Category>, String> {
    let conn = get_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, color FROM categories WHERE user_id = ?1 ORDER BY name"
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    let categories: Vec<Category> = stmt.query_map(params![user_id], |row| {
        Ok(Category {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
        })
    }).map_err(|e: rusqlite::Error| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(categories)
}

#[tauri::command]
pub fn create_category(user_id: String, name: String, color: String) -> Result<Category, String> {
    let conn = get_conn()?;
    conn.execute(
        "INSERT INTO categories (user_id, name, color) VALUES (?1, ?2, ?3)",
        params![user_id, name, color],
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    let id = conn.last_insert_rowid() as u32;
    Ok(Category { id, name, color })
}

#[tauri::command]
pub fn delete_todo(id: u32, user_id: String) -> Result<bool, String> {
    let conn = get_conn()?;

    // Verify ownership and check if overdue
    let todo_info: Option<(String, String, String)> = conn.query_row(
        "SELECT user_id, deadline, title FROM todos WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).ok();

    let (_owner_id, deadline_str, todo_title) = match todo_info {
        Some(info) if info.0 == user_id => (info.0, info.1, info.2),
        Some(_) => return Err("Todo not found or access denied".to_string()),
        None => return Err("Todo not found".to_string()),
    };

    // A3: Prevent deleting past/overdue todos
    let deadline_dt = NaiveDateTime::parse_from_str(&deadline_str, "%Y-%m-%d %H:%M:%S")
        .map_err(|e| format!("Invalid deadline format: {}", e))?;
    let now = chrono::Local::now().naive_local();
    if deadline_dt <= now {
        return Err("Cannot delete a past/overdue todo".to_string());
    }

    // Log the deletion locally for weekly tracking
    let weekly = credits::get_weekly_deletions(&user_id)?;
    let cost = credits::get_delete_cost(weekly);
    credits::log_deletion(&user_id, cost, &todo_title)?;

    // Delete the todo
    conn.execute(
        "DELETE FROM todos WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    Ok(true)
}
