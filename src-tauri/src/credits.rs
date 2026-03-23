use crate::db::get_conn;
use mysql::prelude::*;
use serde::Serialize;
use chrono::{DateTime, Utc, Duration};

#[derive(Serialize)]
pub struct CreditInfo {
    pub credits: i32,
    pub units: i32,
    pub weekly_deletions: i32,
    pub delete_cost: i32,
    pub edit_cost: i32,
    pub show_banner: bool,
}

pub fn get_user_credits(user_id: u32) -> Result<i32, String> {
    let mut conn = get_conn()?;
    let credits: Option<i32> = conn.exec_first(
        "SELECT credits FROM users WHERE user_id = ?",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(credits.unwrap_or(50))
}

pub fn deduct_credits(user_id: u32, amount: i32, reason: &str, reference_id: Option<u32>) -> Result<(), String> {
    let mut conn = get_conn()?;
    let credits = get_user_credits(user_id)?;
    if credits < amount {
        return Err(format!("Insufficient credits: {} units available, {} required", credits, amount));
    }
    conn.exec_drop(
        "UPDATE users SET credits = credits - ? WHERE user_id = ?",
        (&amount, &user_id),
    ).map_err(|e: mysql::Error| e.to_string())?;
    conn.exec_drop(
        "INSERT INTO credit_transactions (user_id, amount, reason, reference_id) VALUES (?, ?, ?, ?)",
        (&user_id, &(-amount), &reason, &reference_id),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(())
}

pub fn get_weekly_deletions(user_id: u32, created_at: DateTime<Utc>) -> Result<i32, String> {
    let mut conn = get_conn()?;
    let now = Utc::now();
    let days_since_creation = (now - created_at).num_days();
    let current_week = (days_since_creation / 7) as i32;
    let week_start = created_at + Duration::weeks(current_week as i64);
    let week_end = week_start + Duration::weeks(1);

    let count: Option<i32> = conn.exec_first(
        "SELECT COUNT(*) FROM credit_transactions WHERE user_id = ? AND reason = 'delete' AND created_at >= ? AND created_at < ?",
        (&user_id, &week_start.naive_utc().to_string(), &week_end.naive_utc().to_string()),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(count.unwrap_or(0))
}

pub fn get_deletion_stats(user_id: u32) -> Result<(i32, bool), String> {
    let mut conn = get_conn()?;
    
    // Get user's created_at
    let created_at: Option<String> = conn.exec_first(
        "SELECT created_at FROM users WHERE user_id = ?",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;
    
    let created_at = match created_at {
        Some(dt) => DateTime::parse_from_rfc3339(&dt)
            .map_err(|e| e.to_string())?
            .with_timezone(&Utc),
        None => return Err("User not found".to_string()),
    };

    // Get last deletion timestamp
    let last_deletion: Option<String> = conn.exec_first(
        "SELECT last_deletion_at FROM users WHERE user_id = ?",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let last_deletion_within_24h = match last_deletion {
        Some(dt) => {
            let last_dt = DateTime::parse_from_rfc3339(&dt)
                .map_err(|e| e.to_string())?
                .with_timezone(&Utc);
            Utc::now() - last_dt < Duration::hours(24)
        }
        None => false,
    };

    let weekly_deletions = get_weekly_deletions(user_id, created_at)?;

    Ok((weekly_deletions, last_deletion_within_24h))
}

pub fn get_delete_cost(weekly_deletions: i32) -> i32 {
    if weekly_deletions < 7 { 10 } else { 50 }
}

pub fn get_edit_cost(edit_count: u32) -> i32 {
    match edit_count {
        0 => 0,
        1..=4 => 4,
        _ => 100,
    }
}

pub fn update_last_deletion(user_id: u32) -> Result<(), String> {
    let mut conn = get_conn()?;
    conn.exec_drop(
        "UPDATE users SET last_deletion_at = NOW() WHERE user_id = ?",
        (&user_id,),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_credits(user_id: u32) -> Result<CreditInfo, String> {
    let credits = get_user_credits(user_id)?;
    let (weekly_deletions, _) = get_deletion_stats(user_id)?;
    let delete_cost = get_delete_cost(weekly_deletions);
    let edit_cost = 0; // Will be determined per-todo in frontend

    Ok(CreditInfo {
        credits,
        units: credits,
        weekly_deletions,
        delete_cost,
        edit_cost,
        show_banner: false,
    })
}

#[tauri::command]
pub fn get_edit_cost_command(user_id: u32, todo_id: u32) -> Result<i32, String> {
    let mut conn = get_conn()?;
    let edit_count: Option<u32> = conn.exec_first(
        "SELECT edit_count FROM todos WHERE id = ? AND user_id = ?",
        (&todo_id, &user_id),
    ).map_err(|e: mysql::Error| e.to_string())?;
    
    Ok(get_edit_cost(edit_count.unwrap_or(0)))
}
