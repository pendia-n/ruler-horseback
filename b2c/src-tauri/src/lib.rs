mod db;
mod todos;
mod credits;

use tauri::Manager;

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use std::process::Command;
        #[cfg(target_os = "macos")]
        Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        Command::new("cmd").args(["/C", "start", &url]).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| {
                std::path::PathBuf::from(".")
            });
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("rulerhorseback.db");
            db::set_db_path(db_path);
            db::init_db().expect("Failed to initialize database");
            let window = app.get_webview_window("main").unwrap();
            window.set_title("rulerhorseback").ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Todos
            todos::get_upcoming_todos,
            todos::get_all_todos,
            todos::add_todo,
            todos::get_todo,
            todos::update_todo,
            todos::delete_todo,
            todos::toggle_completed,
            todos::mark_done,
            todos::mark_lost,
            todos::detect_due_todos,
            todos::get_active_count,
            // Categories
            todos::get_categories,
            todos::create_category,
            // Credits
            credits::get_credit_info,
            credits::get_edit_cost_command,
            credits::get_outcome_counts,
            // Utils
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
