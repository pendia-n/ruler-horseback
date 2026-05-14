use crate::db::get_conn;
use rusqlite::params;
use serde::Serialize;
use chrono::{Utc, Duration};

#[derive(Serialize)]
pub struct CreditInfo {
    pub weekly_deletions: i32,
    pub delete_cost: i32,
    pub edit_cost: i32,
}

pub fn get_weekly_deletions(user_id: &str) -> Result<i32, String> {
    let conn = get_conn()?;
    // Count deletions in the current week (7-day window from now)
    let week_ago = (Utc::now() - Duration::days(7)).naive_utc().to_string();
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM delete_log WHERE user_id = ?1 AND created_at >= ?2",
        params![user_id, week_ago],
        |row| row.get(0),
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(count)
}

pub fn log_deletion(user_id: &str, cost: i32, todo_title: &str) -> Result<(), String> {
    let conn = get_conn()?;
    conn.execute(
        "INSERT INTO delete_log (user_id, cost, todo_title) VALUES (?1, ?2, ?3)",
        params![user_id, cost, todo_title],
    ).map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(())
}

pub fn get_delete_cost(weekly_deletions: i32) -> i32 {
    if weekly_deletions < 7 { 10 } else { 50 }
}

pub fn get_edit_cost(edit_count: u32) -> i32 {
    match edit_count {
        0 => 0,
        1..=4 => 4,
        _ => 10,
    }
}

#[tauri::command]
pub fn get_credit_info(user_id: String) -> Result<CreditInfo, String> {
    let weekly_deletions = get_weekly_deletions(&user_id)?;
    let delete_cost = get_delete_cost(weekly_deletions);

    Ok(CreditInfo {
        weekly_deletions,
        delete_cost,
        edit_cost: 0,
    })
}

#[tauri::command]
pub fn get_edit_cost_command(user_id: String, todo_id: u32) -> Result<i32, String> {
    let conn = get_conn()?;
    let edit_count: u32 = conn.query_row(
        "SELECT edit_count FROM todos WHERE id = ?1 AND user_id = ?2",
        params![todo_id, user_id],
        |row| row.get(0),
    ).map_err(|e: rusqlite::Error| format!("Todo not found: {}", e))?;

    Ok(get_edit_cost(edit_count))
}
