use crate::db::get_conn;
use crate::credits;
use rusqlite::params;
use serde::Serialize;
use chrono::NaiveDateTime;

// ── Data structs ──────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct Todo {
    pub id: u32,
    pub title: String,
    pub deadline: String,
    pub description: Option<String>,
    pub edit_count: u32,
    pub edit_cost: i32,
    pub completed: bool,
    pub lost: bool,
    pub category_id: Option<u32>,
    pub resolution: Option<String>,
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
    pub lost: bool,
    pub category_id: Option<u32>,
    pub resolution: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Category {
    pub id: u32,
    pub name: String,
    pub color: String,
}

// Active todo count info
#[derive(Serialize, Debug)]
pub struct ActiveCount {
    pub active: i32,
    pub max_active: i32,
}

// Due detection result
#[derive(Serialize, Debug)]
pub struct DueResult {
    pub due_count: i32,
    pub penalty: i32,
}

// ── Constants ─────────────────────────────────────────────

const MAX_ACTIVE_TODOS: i32 = 35;

// ── Junk validation ───────────────────────────────────────

/// Validate that a done/lost description is not junk.
/// Returns Ok(()) if valid, Err(reason) if junk.
pub fn validate_resolution(description: &str) -> Result<(), String> {
    let trimmed = description.trim();

    // 1. Minimum length
    if trimmed.len() < 12 {
        return Err("Description too short — please write at least 12 characters.".into());
    }

    // 2. Minimum word count
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    if words.len() < 3 {
        return Err("Please write at least 3 words describing what happened.".into());
    }

    // 3. Single throwaway word check (only if it's 1-2 words total)
    let throwaways = [
        "done", "finished", "complete", "completed", "yeah", "yep", "ok", "okay",
        "sure", "nice", "great", "idk", "na", "n/a", "whatever", "idc", "yup",
        "done done", "finished it",
    ];
    let lower = trimmed.to_lowercase();
    for t in &throwaways {
        if lower == *t {
            return Err(format!("\"{}\" is not a description. Please explain what actually happened.", t));
        }
    }

    // 4. All same character repeated
    let first_char = trimmed.chars().next().unwrap();
    if trimmed.chars().all(|c| c == first_char) {
        return Err("That doesn't look like a real description.".into());
    }

    // 5. Character variety: reject if >70% same character
    let mut char_counts = [0u32; 256];
    for c in trimmed.chars() {
        char_counts[c as usize % 256] += 1;
    }
    let max_count = *char_counts.iter().max().unwrap() as f64;
    if max_count / trimmed.len() as f64 > 0.70 {
        return Err("That looks like random characters. Please write a real description.".into());
    }

    // 6. Consonant ratio check (gibberish detection)
    let vowels = "aeiouAEIOU";
    let letter_count = trimmed.chars().filter(|c| c.is_alphabetic()).count();
    if letter_count >= 5 {
        let consonant_count = trimmed.chars()
            .filter(|c| c.is_alphabetic() && !vowels.contains(*c))
            .count();
        let ratio = consonant_count as f64 / letter_count as f64;
        if ratio > 0.85 {
            return Err("That looks like gibberish. Please write a real description.".into());
        }
    }

    // 7. Keyboard mash: no spaces and not a real word
    if !trimmed.contains(' ') {
        // Single "word" — check if it looks like keyboard mash
        // Real single words that are valid: allow them if they're in a small whitelist
        let valid_single_words = ["submitted", "completed", "finished", "resolved", "shipped", "deployed", "merged", "fixed", "closed", "handled"];
        if !valid_single_words.contains(&trimmed.to_lowercase().as_str()) {
            return Err("Please write a full sentence, not just a single word.".into());
        }
    }

    Ok(())
}

// ── Active todo cap ───────────────────────────────────────

pub fn count_active_todos(user_id: &str) -> Result<i32, String> {
    let conn = get_conn()?;
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM todos
         WHERE user_id = ?1
           AND completed = 0
           AND lost = 0
           AND due_processed = 0
           AND deadline > datetime('now')",
        params![user_id],
        |row| row.get(0),
    ).map_err(|e| format!("Failed to count active todos: {}", e))?;
    Ok(count)
}

fn check_active_cap(user_id: &str) -> Result<(), String> {
    let active = count_active_todos(user_id)?;
    if active >= MAX_ACTIVE_TODOS {
        return Err(format!(
            "You have {} active todos (max {}). Complete, lose, or let some expire before adding more.",
            active, MAX_ACTIVE_TODOS
        ));
    }
    Ok(())
}

// ── Queries ───────────────────────────────────────────────

#[tauri::command]
pub fn get_active_count(user_id: String) -> Result<ActiveCount, String> {
    let active = count_active_todos(&user_id)?;
    Ok(ActiveCount {
        active,
        max_active: MAX_ACTIVE_TODOS,
    })
}

#[tauri::command]
pub fn get_upcoming_todos(user_id: String) -> Result<Vec<Todo>, String> {
    let conn = get_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, deadline, description, edit_count, completed, lost, category_id, resolution
         FROM todos 
         WHERE user_id = ?1
           AND deadline >= datetime('now')
           AND completed = 0
           AND lost = 0
           AND due_processed = 0
         ORDER BY deadline ASC LIMIT 35"
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
            lost: row.get::<_, i32>(6)? != 0,
            category_id: row.get(7)?,
            resolution: row.get(8)?,
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
        "SELECT id, title, deadline, description, edit_count, completed, lost, category_id, resolution
         FROM todos WHERE user_id = ?1 ORDER BY deadline"
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    let now = chrono::Local::now().naive_local();
    let todos: Vec<TodoWithStatus> = stmt.query_map(params![user_id], |row| {
        let deadline_str: String = row.get(2)?;
        let dt = NaiveDateTime::parse_from_str(&deadline_str, "%Y-%m-%d %H:%M:%S").unwrap_or(now);
        let completed: i32 = row.get(5)?;
        let lost: i32 = row.get(6)?;
        let diff = dt.signed_duration_since(now);

        let status = if completed != 0 {
            "DONE".to_string()
        } else if lost != 0 {
            "LOST".to_string()
        } else if diff.num_seconds() <= 0 {
            "DUE".to_string()
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
            lost: lost != 0,
            category_id: row.get(7)?,
            resolution: row.get(8)?,
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
        "SELECT id, title, deadline, description, edit_count, completed, lost, category_id, resolution
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
                lost: row.get::<_, i32>(6)? != 0,
                category_id: row.get(7)?,
                resolution: row.get(8)?,
            })
        },
    ).map_err(|e: rusqlite::Error| format!("Todo not found: {}", e))?;
    Ok(result)
}

// ── Mutations ─────────────────────────────────────────────

#[tauri::command]
pub fn add_todo(user_id: String, title: String, description: String, deadline: String, category_id: Option<u32>) -> Result<bool, String> {
    // Enforce active todo cap
    check_active_cap(&user_id)?;

    let conn = get_conn()?;
    conn.execute(
        "INSERT INTO todos (user_id, title, description, deadline, edit_count, category_id) 
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![user_id, title, description, deadline, category_id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn update_todo(id: u32, title: String, description: String, deadline: String, user_id: String, category_id: Option<u32>) -> Result<bool, String> {
    let conn = get_conn()?;

    let current: (String, String, u32, i32, i32, Option<u32>) = conn.query_row(
        "SELECT title, deadline, edit_count, completed, lost, category_id 
         FROM todos WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
        |row| Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
        )),
    ).map_err(|e: rusqlite::Error| format!("Todo not found: {}", e))?;

    let (current_title, current_deadline, edit_count, completed, lost, current_category_id) = current;

    // Can't edit completed or lost todos
    if completed != 0 {
        return Err("Cannot edit a completed todo.".into());
    }
    if lost != 0 {
        return Err("Cannot edit a lost todo.".into());
    }

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
        return Ok(true);
    }

    let new_edit_count = edit_count + 1;

    conn.execute(
        "UPDATE todos SET title = ?1, description = ?2, deadline = ?3, edit_count = ?4, 
         category_id = ?5, updated_at = datetime('now') WHERE id = ?6",
        params![title, description, deadline, new_edit_count, category_id, id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    Ok(true)
}

#[tauri::command]
pub fn mark_done(id: u32, user_id: String, resolution: String) -> Result<bool, String> {
    // Validate description
    validate_resolution(&resolution)?;

    let conn = get_conn()?;

    // Verify ownership and check state
    let (completed, lost, deadline_str): (i32, i32, String) = conn.query_row(
        "SELECT completed, lost, deadline FROM todos WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "Todo not found or access denied".to_string())?;

    if completed != 0 {
        return Err("Todo is already completed.".into());
    }
    if lost != 0 {
        return Err("Todo is already marked as lost.".into());
    }

    // Can only mark done BEFORE deadline
    let deadline = NaiveDateTime::parse_from_str(&deadline_str, "%Y-%m-%d %H:%M:%S")
        .map_err(|e| format!("Invalid deadline format: {}", e))?;
    let now = chrono::Local::now().naive_local();
    if deadline <= now {
        return Err("Cannot mark as done after deadline. The todo is now DUE.".into());
    }

    conn.execute(
        "UPDATE todos SET completed = 1, resolution = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![resolution, id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    Ok(true)
}

#[tauri::command]
pub fn mark_lost(id: u32, user_id: String, reason: String) -> Result<bool, String> {
    // Validate description
    validate_resolution(&reason)?;

    let conn = get_conn()?;

    // Verify ownership and check state
    let (completed, lost, deadline_str): (i32, i32, String) = conn.query_row(
        "SELECT completed, lost, deadline FROM todos WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "Todo not found or access denied".to_string())?;

    if completed != 0 {
        return Err("Todo is already completed.".into());
    }
    if lost != 0 {
        return Err("Todo is already marked as lost.".into());
    }

    // Can only mark lost BEFORE deadline
    let deadline = NaiveDateTime::parse_from_str(&deadline_str, "%Y-%m-%d %H:%M:%S")
        .map_err(|e| format!("Invalid deadline format: {}", e))?;
    let now = chrono::Local::now().naive_local();
    if deadline <= now {
        return Err("Cannot mark as lost after deadline. The todo is now DUE.".into());
    }

    conn.execute(
        "UPDATE todos SET lost = 1, resolution = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![reason, id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    Ok(true)
}

#[tauri::command]
pub fn toggle_completed(id: u32, user_id: String) -> Result<bool, String> {
    let conn = get_conn()?;

    let (owner_id, _completed, lost): (String, i32, i32) = conn.query_row(
        "SELECT user_id, completed, lost FROM todos WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "Todo not found".to_string())?;

    if owner_id != user_id {
        return Err("Access denied".to_string());
    }
    if lost != 0 {
        return Err("Cannot toggle a lost todo.".into());
    }

    conn.execute(
        "UPDATE todos SET completed = CASE WHEN completed = 0 THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE id = ?1",
        params![id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(true)
}

// ── Due detection ─────────────────────────────────────────

#[tauri::command]
pub fn detect_due_todos(user_id: String) -> Result<DueResult, String> {
    let conn = get_conn()?;

    // Find todos that are past deadline, not completed, not lost, not yet processed
    // Collect IDs first, then drop the statement before using conn again
    let due_ids: Vec<u32> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM todos 
             WHERE user_id = ?1 
               AND deadline < datetime('now') 
               AND completed = 0 
               AND lost = 0 
               AND due_processed = 0",
        ).map_err(|e| e.to_string())?;
        let ids: Vec<u32> = stmt.query_map(params![user_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        ids
    };

    let due_count = due_ids.len() as i32;
    let penalty = due_count * 12; // -12 credits per due todo

    // Mark them as processed
    for id in &due_ids {
        conn.execute(
            "UPDATE todos SET due_processed = 1 WHERE id = ?1",
            params![id],
        ).ok();
    }

    Ok(DueResult { due_count, penalty })
}

// ── Categories ────────────────────────────────────────────

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

    let todo_info: Option<(String, String, String, i32, i32)> = conn.query_row(
        "SELECT user_id, deadline, title, completed, lost FROM todos WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).ok();

    let (_owner_id, deadline_str, todo_title, completed, lost) = match todo_info {
        Some(info) if info.0 == user_id => (info.0, info.1, info.2, info.3, info.4),
        Some(_) => return Err("Todo not found or access denied".to_string()),
        None => return Err("Todo not found".to_string()),
    };

    // Can't delete completed or lost todos
    if completed != 0 {
        return Err("Cannot delete a completed todo.".into());
    }
    if lost != 0 {
        return Err("Cannot delete a lost todo.".into());
    }

    // Can't delete past/overdue todos
    let deadline_dt = NaiveDateTime::parse_from_str(&deadline_str, "%Y-%m-%d %H:%M:%S")
        .map_err(|e| format!("Invalid deadline format: {}", e))?;
    let now = chrono::Local::now().naive_local();
    if deadline_dt <= now {
        return Err("Cannot delete a past/overdue todo".to_string());
    }

    // Log the deletion locally
    let weekly = credits::get_weekly_deletions(&user_id)?;
    let cost = credits::get_delete_cost(weekly);
    credits::log_deletion(&user_id, cost, &todo_title)?;

    conn.execute(
        "DELETE FROM todos WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
    ).map_err(|e: rusqlite::Error| e.to_string())?;

    Ok(true)
}
