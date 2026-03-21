use crate::db::get_conn;
use sha2::{Sha256, Digest};
use mysql::prelude::*;
use serde::Serialize;

#[derive(Serialize)]
pub struct AuthResult {
    pub success: bool,
    pub message: String,
    pub user_id: Option<u32>,
}

fn hash_password(pw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pw.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[tauri::command]
pub fn check_username(username: String) -> Result<String, String> {
    let mut conn = get_conn()?;
    let exists: Option<u32> = conn.exec_first(
        "SELECT user_id FROM users WHERE username = ?",
        (&username,),
    ).map_err(|e: mysql::Error| e.to_string())?;
    Ok(if exists.is_some() { "login".to_string() } else { "register".to_string() })
}

#[tauri::command]
pub fn register_user(username: String, password: String) -> Result<AuthResult, String> {
    if password.len() < 7 || !password.chars().any(|c| c.is_uppercase()) || !password.chars().any(|c| c.is_ascii_digit()) {
        return Ok(AuthResult {
            success: false,
            message: "Password: >=7 chars, 1 capital, 1 digit".to_string(),
            user_id: None,
        });
    }

    let mut conn = get_conn()?;
    let hashed = hash_password(&password);
    conn.exec_drop(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
        (&username, &hashed),
    ).map_err(|e: mysql::Error| e.to_string())?;

    let user_id: u32 = conn.last_insert_id() as u32;
    Ok(AuthResult {
        success: true,
        message: "Registered!".to_string(),
        user_id: Some(user_id),
    })
}

#[tauri::command]
pub fn login_user(username: String, password: String) -> Result<AuthResult, String> {
    let mut conn = get_conn()?;
    let hashed = hash_password(&password);
    let row: Option<u32> = conn.exec_first(
        "SELECT user_id FROM users WHERE username = ? AND password_hash = ?",
        (&username, &hashed),
    ).map_err(|e: mysql::Error| e.to_string())?;

    match row {
        Some(user_id) => Ok(AuthResult {
            success: true,
            message: "Logged in!".to_string(),
            user_id: Some(user_id),
        }),
        None => Ok(AuthResult {
            success: false,
            message: "Wrong password".to_string(),
            user_id: None,
        }),
    }
}
