use crate::db::get_conn;
use crate::credits;
use mysql::prelude::*;
use serde::Serialize;
use chrono::NaiveDateTime;

#[derive(Serialize, Debug)]
pub struct Todo {
    pub id: u32,
    pub title: String,
    pub deadline: String,
    pub description: Option<String>,
    pub edit_count: u32,
}

#[derive(Serialize, Debug)]
pub struct TodoWithStatus {
    pub id: u32,
    pub title: String,
    pub deadline: String,
    pub status: String,
    pub edit_count: u32,
    pub description: Option<String>,
}

fn parse_datetime(v: mysql::Value) -> String {
    match v {
        mysql::Value::Date(y, m, d, h, mi, s, _) => {
            format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, h, mi, s)
        }
        _ => String::new(),
    }
}

#[tauri::command]
pub fn get_upcoming_todos(user_id: u32) -> Result<Vec<Todo>, String> {
    let mut conn = get_conn()?;
    let results: Vec<(u32, String, mysql::Value, Option<String>, u32)> = conn.exec(
        "SELECT id, title, deadline, description, edit_count FROM todos WHERE user_id = ? AND deadline >= NOW() ORDER BY deadline ASC LIMIT 7",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let todos: Vec<Todo> = results.into_iter().map(|(id, title, deadline, description, edit_count): (u32, String, mysql::Value, Option<String>, u32)| {
        Todo { id, title, deadline: parse_datetime(deadline), description, edit_count }
    }).collect();
    Ok(todos)
}

#[tauri::command]
pub fn get_all_todos(user_id: u32) -> Result<Vec<TodoWithStatus>, String> {
    let mut conn = get_conn()?;
    let rows: Vec<(u32, String, mysql::Value, Option<String>, u32)> = conn.exec(
        "SELECT id, title, deadline, description, edit_count FROM todos WHERE user_id = ? ORDER BY deadline",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let now = chrono::Local::now().naive_local();
    let todos: Vec<TodoWithStatus> = rows.into_iter().map(|(id, title, deadline, description, edit_count): (u32, String, mysql::Value, Option<String>, u32)| {
        let deadline_str = parse_datetime(deadline);
        let dt = NaiveDateTime::parse_from_str(&deadline_str, "%Y-%m-%d %H:%M:%S").unwrap_or(now);
        let diff = dt.signed_duration_since(now);
        let status = if diff.num_seconds() <= 0 {
            "OVERDUE".to_string()
        } else {
            format!("{}d {}h {}m", diff.num_days(), diff.num_hours() % 24, diff.num_minutes() % 60)
        };
        TodoWithStatus { id, title, deadline: deadline_str, description, edit_count, status }
    }).collect();
    Ok(todos)
}

#[tauri::command]
pub fn get_todo(id: u32) -> Result<Todo, String> {
    let mut conn = get_conn()?;
    let result: Option<(u32, String, mysql::Value, Option<String>, u32)> = conn.exec_first(
        "SELECT id, title, deadline, description, edit_count FROM todos WHERE id = ?",
        (&id,),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let (tid, title, deadline, description, edit_count) = result.ok_or("Todo not found".to_string())?;
    Ok(Todo { id: tid, title, deadline: parse_datetime(deadline), description, edit_count })
}

#[tauri::command]
pub fn add_todo(user_id: u32, title: String, description: String, deadline: String) -> Result<bool, String> {
    let mut conn = get_conn()?;
    conn.exec_drop(
        "INSERT INTO todos (user_id, title, description, deadline, edit_count) VALUES (?, ?, ?, ?, 0)",
        (&user_id, &title, &description, &deadline),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn update_todo(id: u32, title: String, description: String, deadline: String, edit_count: u32, current_deadline: String, user_id: u32) -> Result<bool, String> {
    let mut conn = get_conn()?;
    
    // Calculate edit cost
    let cost = credits::get_edit_cost(edit_count);
    
    // Check sufficient credits
    let user_credits = credits::get_user_credits(user_id)?;
    if user_credits < cost {
        return Err(format!("Insufficient credits: {} units available, {} required", user_credits, cost));
    }
    
    let increment: u32 = if deadline != current_deadline && edit_count < 1 { 1 } else { 0 };
    if increment == 0 && deadline != current_deadline {
        return Err("Deadline can only be edited once.".to_string());
    }
    
    // Deduct credits if cost > 0
    if cost > 0 {
        credits::deduct_credits(user_id, cost, "edit", Some(id))?;
    }
    
    conn.exec_drop(
        "UPDATE todos SET title = ?, description = ?, deadline = ?, edit_count = edit_count + ? WHERE id = ?",
        (&title, &description, &deadline, &increment, &id),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn delete_todo(id: u32, user_id: u32) -> Result<bool, String> {
    let mut conn = get_conn()?;
    
    // Verify ownership
    let owner: Option<u32> = conn.exec_first(
        "SELECT user_id FROM todos WHERE id = ?",
        (&id,),
    ).map_err(|e: mysql::Error| e.to_string())?;
    
    match owner {
        Some(owner_id) if owner_id == user_id => {},
        _ => return Err("Todo not found or access denied".to_string()),
    }
    
    // Get user's created_at for weekly calculation
    let created_at: Option<String> = conn.exec_first(
        "SELECT created_at FROM users WHERE user_id = ?",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;
    
    let created_at_str = created_at.ok_or("User not found".to_string())?;
    let created_at = chrono::DateTime::parse_from_rfc3339(&created_at_str)
        .map_err(|e| e.to_string())?
        .with_timezone(&chrono::Utc);
    
    // Calculate weekly deletions and cost
    let weekly_deletions = credits::get_weekly_deletions(user_id, created_at)?;
    let cost = credits::get_delete_cost(weekly_deletions);
    
    // Check sufficient credits
    let user_credits = credits::get_user_credits(user_id)?;
    if user_credits < cost {
        return Err(format!("Insufficient credits: {} units available, {} required", user_credits, cost));
    }
    
    // Deduct credits
    credits::deduct_credits(user_id, cost, "delete", Some(id))?;
    credits::update_last_deletion(user_id)?;
    
    // Delete the todo
    conn.exec_drop(
        "DELETE FROM todos WHERE id = ? AND user_id = ?",
        (&id, &user_id),
    ).map_err(|e: mysql::Error| e.to_string())?;
    
    Ok(true)
}
