//! The menu bar: only what 1Client does, no leftovers from the default template.
//!
//! App items (New Connection, Run, Appearance, ...) are sent to the window as a `menu`
//! event carrying the item id; the frontend handles them like its own shortcuts.

use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};

/// The three Appearance items, kept so their checkmarks can follow the setting.
pub struct AppearanceItems(pub [CheckMenuItem<Wry>; 3]);

pub const APPEARANCE: [(&str, &str); 3] =
    [("appearance:system", "Use System Setting"), ("appearance:light", "Light"), ("appearance:dark", "Dark")];

pub fn build(app: &AppHandle) -> tauri::Result<(Menu<Wry>, AppearanceItems)> {
    let item = |id: &str, text: &str, accel: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, text);
        match accel {
            Some(a) => b.accelerator(a).build(app),
            None => b.build(app),
        }
    };

    let app_menu = SubmenuBuilder::new(app, "1Client")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-connection", "New Connection…", Some("CmdOrCtrl+N"))?)
        .item(&item("new-query", "New Query Tab", Some("CmdOrCtrl+T"))?)
        .separator()
        .item(&item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find…", Some("CmdOrCtrl+F"))?)
        .build()?;

    let query = SubmenuBuilder::new(app, "Query")
        .item(&item("run-statement", "Run Statement", Some("CmdOrCtrl+Enter"))?)
        .item(&item("run-all", "Run All", Some("CmdOrCtrl+Shift+Enter"))?)
        .separator()
        .item(&item("format", "Format SQL", Some("CmdOrCtrl+Shift+F"))?)
        .item(&item("comment", "Toggle Comment", Some("CmdOrCtrl+/"))?)
        .build()?;

    let checks = [0, 1, 2].map(|i| {
        let (id, text) = APPEARANCE[i];
        CheckMenuItemBuilder::with_id(id, text).checked(i == 0).build(app)
    });
    let [system, light, dark] = checks;
    let (system, light, dark) = (system?, light?, dark?);
    let appearance =
        SubmenuBuilder::new(app, "Appearance").item(&system).separator().item(&light).item(&dark).build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&appearance)
        .separator()
        .item(&item("toggle-editor", "Show or Hide SQL Editor", Some("CmdOrCtrl+E"))?)
        .item(&item("results-table", "Results as Table", None)?)
        .item(&item("results-json", "Results as JSON", None)?)
        .separator()
        .item(&item("refresh", "Refresh", Some("CmdOrCtrl+R"))?)
        .separator()
        .fullscreen()
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&item("prev-tab", "Show Previous Tab", Some("CmdOrCtrl+Shift+["))?)
        .item(&item("next-tab", "Show Next Tab", Some("CmdOrCtrl+Shift+]"))?)
        .build()?;

    let menu = MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &query, &view, &window]).build()?;
    Ok((menu, AppearanceItems([system, light, dark])))
}

/// Tick the Appearance item for `mode` (`system`, `light` or `dark`).
pub fn check_appearance<R: Runtime, M: Manager<R>>(app: &M, mode: &str) {
    if let Some(items) = app.try_state::<AppearanceItems>() {
        for (item, (id, _)) in items.0.iter().zip(APPEARANCE) {
            let _ = item.set_checked(id.strip_prefix("appearance:") == Some(mode));
        }
    }
}

/// Forward app items to the window; predefined ones (Copy, Quit, ...) are handled by macOS.
pub fn on_event(app: &AppHandle, id: &str) {
    if let Some(mode) = id.strip_prefix("appearance:") {
        check_appearance(app, mode);
    }
    let _ = app.emit("menu", id.to_string());
}
