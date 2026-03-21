use crate::db::get_conn;
use mysql::prelude::*;
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize)]
pub struct AddTodoRequest {
    pub user_id: u32,
    pub title: String,
    pub description: String,
    pub deadline: String,
}

#[derive(Deserialize)]
pub struct UpdateTodoRequest {
    pub id: u32,
    pub title: String,
    pub description: String,
    pub deadline: String,
    pub edit_count: u32,
    pub current_deadline: String,
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
pub fn update_todo(id: u32, title: String, description: String, deadline: String, edit_count: u32, current_deadline: String) -> Result<bool, String> {
    let mut conn = get_conn()?;
    let increment: u32 = if deadline != current_deadline && edit_count < 1 { 1 } else { 0 };
    if increment == 0 && deadline != current_deadline {
        return Err("Deadline can only be edited once.".to_string());
    }
    conn.exec_drop(
        "UPDATE todos SET title = ?, description = ?, deadline = ?, edit_count = edit_count + ? WHERE id = ?",
        (&title, &description, &deadline, &increment, &id),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(true)
}
