use std::{
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

struct BackendHandle {
    child: CommandChild,
    port: u16,
    shutdown_token: String,
}

struct BackendProcess(Mutex<Option<BackendHandle>>);

fn allocate_local_port() -> Result<u16, std::io::Error> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

fn request_backend_shutdown(port: u16, shutdown_token: &str) -> bool {
    let address = (Ipv4Addr::LOCALHOST, port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(750)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if write!(
        stream,
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Shiyibao-Shutdown-Token: {shutdown_token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .is_err()
    {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() || !response.starts_with("HTTP/1.1 200") {
        return false;
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_err() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn stop_backend(app: &tauri::AppHandle) {
    let backend = app
        .try_state::<BackendProcess>()
        .and_then(|state| state.0.lock().ok()?.take());
    if let Some(backend) = backend {
        let stopped = request_backend_shutdown(backend.port, &backend.shutdown_token);
        if !stopped {
            eprintln!("[backend] graceful shutdown timed out; forcing launcher process exit");
        }
        let _ = backend.child.kill();
    }
}

fn probe_backend_health(port: u16) -> Option<serde_json::Value> {
    let address = (Ipv4Addr::LOCALHOST, port).into();
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    write!(
        stream,
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;

    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (headers, body) = response.split_once("\r\n\r\n")?;
    if !headers.starts_with("HTTP/1.1 200") {
        return None;
    }
    serde_json::from_str(body).ok()
}

fn start_desktop_smoke_probe(
    app_handle: tauri::AppHandle,
    port: u16,
    data_dir: PathBuf,
    report_path: &Path,
) {
    let report_path = report_path.to_path_buf();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut health = None;
        while Instant::now() < deadline {
            health = probe_backend_health(port);
            if health.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }

        let (exit_code, report) = match health {
            Some(health) => (
                0,
                serde_json::json!({
                    "status": "ok",
                    "port": port,
                    "data_dir": data_dir,
                    "health": health,
                }),
            ),
            None => (
                1,
                serde_json::json!({
                    "status": "error",
                    "port": port,
                    "data_dir": data_dir,
                    "error": "backend health endpoint did not become ready within 45 seconds",
                }),
            ),
        };

        if let Some(parent) = report_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(
            &report_path,
            serde_json::to_vec_pretty(&report).unwrap_or_default(),
        );
        app_handle.exit(exit_code);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let shutdown_token = uuid::Uuid::new_v4().simple().to_string();
            let local_token = uuid::Uuid::new_v4().simple().to_string();
            fs::create_dir_all(&data_dir)?;

            // 先 bind:0 再交给 sidecar 存在短暂竞态；spawn 失败时换端口重试。
            let mut selected_port = None;
            let mut selected_child = None;
            let mut selected_events = None;
            let mut last_error = String::from("未能启动后端边车");

            for attempt in 1..=5 {
                let port = match allocate_local_port() {
                    Ok(port) => port,
                    Err(error) => {
                        last_error = format!("分配本地端口失败: {error}");
                        continue;
                    }
                };

                let command = match app.shell().sidecar("shiyibao-backend") {
                    Ok(command) => command
                        .env("SHIYIBAO_PORT", port.to_string())
                        .env("SHIYIBAO_SHUTDOWN_TOKEN", &shutdown_token)
                        .env("SHIYIBAO_LOCAL_TOKEN", &local_token)
                        .env("SHIYIBAO_DATA_DIR", data_dir.as_os_str()),
                    Err(error) => {
                        last_error = format!("创建边车命令失败: {error}");
                        break;
                    }
                };

                match command.spawn() {
                    Ok((events, child)) => {
                        selected_port = Some(port);
                        selected_child = Some(child);
                        selected_events = Some(events);
                        break;
                    }
                    Err(error) => {
                        eprintln!("[backend] spawn attempt {attempt} failed: {error}");
                        last_error = format!("启动边车失败: {error}");
                    }
                }
            }

            let port = selected_port.ok_or_else(|| last_error.clone())?;
            let child = selected_child.ok_or_else(|| last_error.clone())?;
            let mut events = selected_events.ok_or_else(|| last_error)?;

            app.manage(BackendProcess(Mutex::new(Some(BackendHandle {
                child,
                port,
                shutdown_token,
            }))));

            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprintln!("[backend:error] {}", String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[backend] exited: {payload:?}");
                        }
                        _ => {}
                    }
                }
            });

            let initialization_script = format!(
                r#"window.__SHIYIBAO_DESKTOP__ = true; window.__SHIYIBAO_API_BASE__ = "http://127.0.0.1:{port}"; window.__SHIYIBAO_LOCAL_TOKEN__ = "{local_token}";"#
            );
            let window = match WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("视译宝")
            .inner_size(1280.0, 820.0)
            .min_inner_size(960.0, 640.0)
            .center()
            .visible(true)
            .focused(true)
            .initialization_script(&initialization_script)
            .build()
            {
                Ok(window) => window,
                Err(error) => {
                    stop_backend(app.handle());
                    return Err(error.into());
                }
            };
            if let Err(error) = window.show().and_then(|_| window.set_focus()) {
                stop_backend(app.handle());
                return Err(error.into());
            }

            if let Some(report_path) = std::env::var_os("SHIYIBAO_DESKTOP_SMOKE_FILE") {
                start_desktop_smoke_probe(
                    app.handle().clone(),
                    port,
                    data_dir,
                    Path::new(&report_path),
                );
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("创建视译宝桌面应用失败");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { .. },
            ..
        } if label == "main" => {
            app_handle.exit(0);
        }
        RunEvent::Exit => stop_backend(app_handle),
        _ => {}
    });
}
