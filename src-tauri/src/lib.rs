mod db;
mod auth;
mod todos;
mod credits;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            auth::check_username,
            auth::register_user,
            auth::login_user,
            todos::get_upcoming_todos,
            todos::get_all_todos,
            todos::add_todo,
            todos::get_todo,
            todos::update_todo,
            todos::delete_todo,
            todos::toggle_completed,
            todos::get_categories,
            todos::create_category,
            credits::get_credits,
            credits::get_edit_cost_command,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("rulerhorseback").ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
