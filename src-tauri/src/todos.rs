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
    let results: Vec<(u32, String, mysql::Value, Option<String>, u32, i32, Option<u32>)> = conn.exec(
        "SELECT id, title, deadline, description, edit_count, completed, category_id FROM todos WHERE user_id = ? AND deadline >= NOW() AND completed = 0 ORDER BY deadline ASC LIMIT 7",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let todos: Vec<Todo> = results.into_iter().map(|(id, title, deadline, description, edit_count, completed, category_id): (u32, String, mysql::Value, Option<String>, u32, i32, Option<u32>)| {
        Todo { 
            id, 
            title, 
            deadline: parse_datetime(deadline), 
            description, 
            edit_count,
            edit_cost: credits::get_edit_cost(edit_count),
            completed: completed != 0,
            category_id
        }
    }).collect();
    Ok(todos)
}

#[tauri::command]
pub fn get_all_todos(user_id: u32) -> Result<Vec<TodoWithStatus>, String> {
    let mut conn = get_conn()?;
    let rows: Vec<(u32, String, mysql::Value, Option<String>, u32, i32, Option<u32>)> = conn.exec(
        "SELECT id, title, deadline, description, edit_count, completed, category_id FROM todos WHERE user_id = ? ORDER BY deadline",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let now = chrono::Local::now().naive_local();
    let todos: Vec<TodoWithStatus> = rows.into_iter().map(|(id, title, deadline, description, edit_count, completed, category_id): (u32, String, mysql::Value, Option<String>, u32, i32, Option<u32>)| {
        let deadline_str = parse_datetime(deadline);
        let dt = NaiveDateTime::parse_from_str(&deadline_str, "%Y-%m-%d %H:%M:%S").unwrap_or(now);
        let diff = dt.signed_duration_since(now);
        let status = if completed != 0 {
            "COMPLETED".to_string()
        } else if diff.num_seconds() <= 0 {
            "OVERDUE".to_string()
        } else {
            format!("{}d {}h {}m", diff.num_days(), diff.num_hours() % 24, diff.num_minutes() % 60)
        };
        TodoWithStatus { id, title, deadline: deadline_str, description, edit_count, status, completed: completed != 0, category_id }
    }).collect();
    Ok(todos)
}

#[tauri::command]
pub fn get_todo(id: u32) -> Result<Todo, String> {
    let mut conn = get_conn()?;
    let result: Option<(u32, String, mysql::Value, Option<String>, u32, i32, Option<u32>)> = conn.exec_first(
        "SELECT id, title, deadline, description, edit_count, completed, category_id FROM todos WHERE id = ?",
        (&id,),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let (tid, title, deadline, description, edit_count, completed, category_id) = result.ok_or("Todo not found".to_string())?;
    Ok(Todo { 
        id: tid, 
        title, 
        deadline: parse_datetime(deadline), 
        description, 
        edit_count,
        edit_cost: credits::get_edit_cost(edit_count),
        completed: completed != 0,
        category_id
    })
}

#[tauri::command]
pub fn add_todo(user_id: u32, title: String, description: String, deadline: String, category_id: Option<u32>) -> Result<bool, String> {
    let mut conn = get_conn()?;
    conn.exec_drop(
        "INSERT INTO todos (user_id, title, description, deadline, edit_count, category_id) VALUES (?, ?, ?, ?, 0, ?)",
        (&user_id, &title, &description, &deadline, &category_id),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn update_todo(id: u32, title: String, description: String, deadline: String, edit_count: u32, current_deadline: String, user_id: u32, category_id: Option<u32>) -> Result<bool, String> {
    let mut conn = get_conn()?;
    
    let cost = credits::get_edit_cost(edit_count);
    
    let user_credits = credits::get_user_credits(user_id)?;
    if user_credits < cost {
        return Err(format!("Insufficient credits: {} units available, {} required", user_credits, cost));
    }
    
    let increment: u32 = if deadline != current_deadline && edit_count < 1 { 1 } else { 0 };
    if increment == 0 && deadline != current_deadline {
        return Err("Deadline can only be edited once.".to_string());
    }
    
    if cost > 0 {
        credits::deduct_credits(user_id, cost, "edit", Some(id))?;
    }
    
    conn.exec_drop(
        "UPDATE todos SET title = ?, description = ?, deadline = ?, edit_count = edit_count + ?, category_id = ? WHERE id = ?",
        (&title, &description, &deadline, &increment, &category_id, &id),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn toggle_completed(id: u32, user_id: u32) -> Result<bool, String> {
    let mut conn = get_conn()?;
    
    let owner: Option<u32> = conn.exec_first(
        "SELECT user_id FROM todos WHERE id = ?",
        (&id,),
    ).map_err(|e: mysql::Error| e.to_string())?;
    
    match owner {
        Some(owner_id) if owner_id == user_id => {},
        _ => return Err("Todo not found or access denied".to_string()),
    }
    
    conn.exec_drop(
        "UPDATE todos SET completed = NOT completed WHERE id = ?",
        (&id,),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn get_categories(user_id: u32) -> Result<Vec<Category>, String> {
    let mut conn = get_conn()?;
    let results: Vec<(u32, String, String)> = conn.exec(
        "SELECT id, name, color FROM categories WHERE user_id = ? ORDER BY name",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let categories: Vec<Category> = results.into_iter().map(|(id, name, color)| {
        Category { id, name, color }
    }).collect();
    Ok(categories)
}

#[tauri::command]
pub fn create_category(user_id: u32, name: String, color: String) -> Result<Category, String> {
    let mut conn = get_conn()?;
    conn.exec_drop(
        "INSERT INTO categories (user_id, name, color) VALUES (?, ?, ?)",
        (&user_id, &name, &color),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let id = conn.last_insert_id() as u32;
    Ok(Category { id, name, color })
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
