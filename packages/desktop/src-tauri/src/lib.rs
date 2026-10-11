use dirs;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent, WebviewUrl, WebviewWindowBuilder,
};

struct ServiceState {
    child: Mutex<Option<Child>>,
}

fn find_service_script(_app: &tauri::AppHandle) -> String {
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../standalone/cli.mjs");
    if dev_path.exists() {
        return dev_path.to_string_lossy().to_string();
    }
    if let Ok(exe) = std::env::current_exe() {
        let prod_path = exe.parent().unwrap_or(std::path::Path::new("."))
            .join("cli.mjs");
        if prod_path.exists() {
            return prod_path.to_string_lossy().to_string();
        }
    }
    "packages/standalone/cli.mjs".to_string()
}

fn start_service(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ServiceState>();
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let script = find_service_script(app);
    let child = Command::new("node")
        .arg(&script).arg("--port").arg("18900")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("failed to start service: {}", e))?;
    *guard = Some(child);
    Ok(())
}

fn stop_service(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServiceState>() {
        if let Ok(mut guard) = state.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn read_service_port() -> Option<u16> {
    let lock = dirs::home_dir()?.join(".our-free-model").join("service.lock");
    let content = std::fs::read_to_string(lock).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("port")?.as_u64().map(|p| p as u16)
}

fn wait_for_service(timeout: Duration) -> Option<u16> {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if let Some(port) = read_service_port() {
            if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
                return Some(port);
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    None
}

fn kill_port_occupant(port: u16) {
    let output = Command::new("netstat").args(["-ano"]).output();
    if let Ok(output) = output {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            if line.contains(&format!(":{}", port)) && line.contains("LISTENING") {
                if let Some(pid_str) = line.split_whitespace().last() {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        let _ = Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/F"])
                            .output();
                    }
                }
            }
        }
    }
}

fn build_titlebar_injection() -> String {
    let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let css = std::fs::read_to_string(base.join("../ui/titlebar.css")).unwrap_or_default();
    let js = std::fs::read_to_string(base.join("../ui/titlebar.js")).unwrap_or_default();
    if css.is_empty() && js.is_empty() {
        return String::new();
    }
    format!(
        "(function(){{var s=document.createElement('style');s.textContent={};document.head.appendChild(s);var sc=document.createElement('script');sc.textContent={};document.head.appendChild(sc);}})();",
        serde_json::to_string(&css).unwrap_or_default(),
        serde_json::to_string(&js).unwrap_or_default()
    )
}

fn read_titlebar_assets() -> (String, String) {
    let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let css = std::fs::read_to_string(base.join("../ui/titlebar.css")).unwrap_or_default();
    let js = std::fs::read_to_string(base.join("../ui/titlebar.js")).unwrap_or_default();
    (css, js)
}

fn read_splash_html() -> String {
    include_str!("../../splash/splash.html").to_string()
}

fn show_splash(app: &tauri::AppHandle) -> Result<(), String> {
    let splash_html = read_splash_html();
    if splash_html.is_empty() {
        return Ok(()); // 没有 splash 文件就跳过
    }

    let _splash = WebviewWindowBuilder::new(
        app,
        "splash",
        WebviewUrl::App("splash.html".into()),
    )
    .title("Our Free Model")
    .inner_size(400.0, 300.0)
    .center()
    .resizable(false)
    .decorations(false)
    .transparent(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn close_splash(app: &tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            app.manage(ServiceState {
                child: Mutex::new(None),
            });

            // 显示启动动画
            show_splash(app.handle())?;

            // 启动后端服务
            start_service(app.handle())?;

            // 在后台等端口就绪
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                // 先清理可能占用端口的旧进程
                kill_port_occupant(18900);
                std::thread::sleep(Duration::from_millis(500));

                // 等服务启动并读取实际端口
                let service_port = wait_for_service(Duration::from_secs(15));
                let ready = service_port.is_some();
                let port = service_port.unwrap_or(18900);

                log::info!("service port: {}, ready: {}", port, ready);

                // 关闭启动动画
                close_splash(&handle);

                // 显示主窗口并注入标题栏
                if let Some(window) = handle.get_webview_window("main") {
                    let injection = build_titlebar_injection();
                    if !injection.is_empty() {
                        let _ = window.eval(&injection);
                    }
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                if !ready {
                    log::warn!("service port 18900 not ready after 15s");
                }
            });

            // 系统托盘
            let show = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Our Free Model")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        stop_service(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 只有主窗口关闭时才隐藏到托盘
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_service(app);
            }
        });
}