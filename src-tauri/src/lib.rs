use std::{
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const MAIN_WINDOW_LABEL: &str = "main";

/// 端口冲突表现为边车内部 bind 失败后退出，只能靠健康检查发现，因此重试次数
/// 乘以就绪超时就是最坏等待时长，别开太大。
const BACKEND_START_ATTEMPTS: u32 = 3;

/// 边车是 PyInstaller onefile 包，要先把依赖解压到临时目录再导入整棵依赖树。
/// 本机实测冷启动接近 20 秒，超时留足余量，否则会把慢启动误判成失败并把一个
/// 本来正常的后端杀掉。
const BACKEND_READY_TIMEOUT: Duration = Duration::from_secs(40);

const BACKEND_READY_POLL_INTERVAL: Duration = Duration::from_millis(250);

struct BackendHandle {
    child: CommandChild,
    port: u16,
    shutdown_token: String,
}

struct BackendProcess(Mutex<Option<BackendHandle>>);

/// 换端口重启时主窗口要连带重建，中间会短暂没有任何窗口——事件循环默认会在
/// 最后一个窗口销毁后请求退出，这段时间必须挡住。
struct WindowRebuilding(AtomicBool);

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
        // 优雅关闭成功后不能再 kill：此时边车自己 os._exit 了，onefile 的引导进程正在
        // 删除几百 MB 的 _MEI 临时解压目录，SIGKILL 会打断清理，把目录永久留在磁盘上
        // （Windows 不回收）。一次启动最多重试三次，累积起来很可观。
        if request_backend_shutdown(backend.port, &backend.shutdown_token) {
            return;
        }
        eprintln!("[backend] graceful shutdown timed out; forcing launcher process exit");
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

/// 分配端口并拉起边车，返回端口和「子进程已退出」标记。
///
/// 先 bind:0 再交给边车存在交接窗口，边车真正 bind 要等十几秒之后，所以这里
/// 只保证进程创建成功，端口能不能用交给 [`wait_for_backend_ready`] 判定。
fn start_backend(
    app: &tauri::AppHandle,
    shutdown_token: &str,
    local_token: &str,
    data_dir: &Path,
) -> Result<(u16, Arc<AtomicBool>), String> {
    let port = allocate_local_port().map_err(|error| format!("分配本地端口失败: {error}"))?;
    let command = app
        .shell()
        .sidecar("shiyibao-backend")
        .map_err(|error| format!("创建边车命令失败: {error}"))?
        .env("SHIYIBAO_PORT", port.to_string())
        .env("SHIYIBAO_SHUTDOWN_TOKEN", shutdown_token)
        .env("SHIYIBAO_LOCAL_TOKEN", local_token)
        .env("SHIYIBAO_PARENT_PID", std::process::id().to_string())
        .env("SHIYIBAO_DATA_DIR", data_dir.as_os_str());

    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("启动边车失败: {error}"))?;

    // 拿不到状态槽就没人负责回收这个 child，宁可立刻杀掉也不要泄漏。
    let Some(state) = app.try_state::<BackendProcess>() else {
        let _ = child.kill();
        return Err(String::from("后端进程状态未初始化"));
    };
    let Ok(mut slot) = state.0.lock() else {
        let _ = child.kill();
        return Err(String::from("后端进程状态已损坏"));
    };
    *slot = Some(BackendHandle {
        child,
        port,
        shutdown_token: shutdown_token.to_string(),
    });
    drop(slot);

    let exited = Arc::new(AtomicBool::new(false));
    let exit_flag = exited.clone();
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
        // 事件流只有这一个接收端，进程退出的信号从这里转交给启动监督线程，
        // 避免两边抢同一个 receiver。
        exit_flag.store(true, Ordering::SeqCst);
    });

    Ok((port, exited))
}

/// 轮询 /api/health 直到边车真的在监听。
///
/// 子进程提前退出（典型原因就是 uvicorn bind 到被抢占的端口失败）时立刻返回，
/// 不必等满超时。此时若端口上仍有人应答，那不是我们的后端，绝不能采信。
fn wait_for_backend_ready(port: u16, exited: &AtomicBool) -> Option<serde_json::Value> {
    let deadline = Instant::now() + BACKEND_READY_TIMEOUT;
    while Instant::now() < deadline {
        if exited.load(Ordering::SeqCst) {
            return None;
        }
        if let Some(health) = probe_backend_health(port) {
            return Some(health);
        }
        std::thread::sleep(BACKEND_READY_POLL_INTERVAL);
    }
    None
}

fn build_main_window<M: Manager<Wry>>(
    manager: &M,
    port: u16,
    local_token: &str,
) -> tauri::Result<()> {
    let initialization_script = format!(
        r#"window.__SHIYIBAO_DESKTOP__ = true; window.__SHIYIBAO_API_BASE__ = "http://127.0.0.1:{port}"; window.__SHIYIBAO_LOCAL_TOKEN__ = "{local_token}";"#
    );
    let window = WebviewWindowBuilder::new(
        manager,
        MAIN_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("视译宝")
    .inner_size(1280.0, 820.0)
    .min_inner_size(960.0, 640.0)
    .center()
    .visible(true)
    .focused(true)
    .initialization_script(&initialization_script)
    .build()?;
    window.show().and_then(|_| window.set_focus())
}

fn set_window_rebuilding(app: &tauri::AppHandle, rebuilding: bool) {
    if let Some(state) = app.try_state::<WindowRebuilding>() {
        state.0.store(rebuilding, Ordering::SeqCst);
    }
}

fn swap_main_window(app: &tauri::AppHandle, port: u16, local_token: &str) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        // destroy 不会触发 CloseRequested，因此不会误伤「关窗即退出」那条路；
        // 它必须在非主线程调用，这里本就在监督线程里。
        window.destroy()?;
        // 标签要等窗口真正销毁后才释放，否则重建会撞 label 已存在。
        let deadline = Instant::now() + Duration::from_secs(5);
        while app.get_webview_window(MAIN_WINDOW_LABEL).is_some() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    build_main_window(app, port, local_token)
}

/// 端口变了就必须让 WebView 重新拿到新的 API 基址。初始化脚本在窗口创建时已经
/// 定死，只能销毁重建整个窗口。
fn rebuild_main_window(app: &tauri::AppHandle, port: u16, local_token: &str) -> tauri::Result<()> {
    set_window_rebuilding(app, true);
    let result = swap_main_window(app, port, local_token);
    set_window_rebuilding(app, false);
    result
}

/// 打包冒烟测试用 SHIYIBAO_DESKTOP_SMOKE_FILE 索要一份启动结果，写完就退出应用；
/// 正常运行不会设这个变量。
fn write_desktop_smoke_report(
    app: &tauri::AppHandle,
    report_path: &Path,
    report: serde_json::Value,
    exit_code: i32,
) {
    if let Some(parent) = report_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        report_path,
        serde_json::to_vec_pretty(&report).unwrap_or_default(),
    );
    app.exit(exit_code);
}

/// 守着边车真正就绪：超时或子进程退出就换端口重来，并连带重建主窗口，让前端
/// 的启动等待页去轮询新端口。
fn spawn_backend_supervisor(
    app: tauri::AppHandle,
    data_dir: PathBuf,
    shutdown_token: String,
    local_token: String,
    initial_port: u16,
    initial_exited: Arc<AtomicBool>,
    smoke_report: Option<PathBuf>,
) {
    std::thread::spawn(move || {
        let mut port = initial_port;
        let mut exited = initial_exited;
        let mut last_error = String::new();

        for attempt in 1..=BACKEND_START_ATTEMPTS {
            if let Some(health) = wait_for_backend_ready(port, &exited) {
                if let Some(report_path) = smoke_report.as_deref() {
                    write_desktop_smoke_report(
                        &app,
                        report_path,
                        serde_json::json!({
                            "status": "ok",
                            "port": port,
                            "data_dir": &data_dir,
                            "health": health,
                        }),
                        0,
                    );
                }
                return;
            }

            last_error = format!(
                "后端未能在端口 {port} 上就绪（{} 秒超时或进程已退出）",
                BACKEND_READY_TIMEOUT.as_secs()
            );
            eprintln!("[backend] readiness attempt {attempt} failed on port {port}");
            // 进程是死是活都要收干净：还活着就先走优雅关闭，让 onefile 引导进程
            // 自己清掉临时解压目录。
            stop_backend(&app);
            if attempt == BACKEND_START_ATTEMPTS {
                break;
            }

            match start_backend(&app, &shutdown_token, &local_token, &data_dir) {
                Ok((next_port, next_exited)) => {
                    port = next_port;
                    exited = next_exited;
                }
                Err(error) => {
                    last_error = error;
                    break;
                }
            }
            if let Err(error) = rebuild_main_window(&app, port, &local_token) {
                last_error = format!("重建主窗口失败: {error}");
                stop_backend(&app);
                break;
            }
        }

        eprintln!("[backend] backend failed to start: {last_error}");
        if let Some(report_path) = smoke_report.as_deref() {
            write_desktop_smoke_report(
                &app,
                report_path,
                serde_json::json!({
                    "status": "error",
                    "port": port,
                    "data_dir": &data_dir,
                    "error": last_error,
                }),
                1,
            );
            return;
        }

        // 走到这里后端已被彻底关停，等待页上的「重新启动检测」只会一直轮询死端口。
        // 必须明确告诉用户重启应用，否则界面就是一个永远转圈的死路。
        app.dialog()
            .message(format!(
                "{last_error}\n\n请退出后重新打开视译宝；若反复出现，请检查是否有安全软件拦截了本机回环连接。"
            ))
            .kind(MessageDialogKind::Error)
            .title("后端服务启动失败")
            .blocking_show();
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

            app.manage(BackendProcess(Mutex::new(None)));
            app.manage(WindowRebuilding(AtomicBool::new(false)));

            let mut started = None;
            let mut last_error = String::from("未能启动后端边车");
            for attempt in 1..=BACKEND_START_ATTEMPTS {
                match start_backend(app.handle(), &shutdown_token, &local_token, &data_dir) {
                    Ok(backend) => {
                        started = Some(backend);
                        break;
                    }
                    Err(error) => {
                        eprintln!("[backend] spawn attempt {attempt} failed: {error}");
                        last_error = error;
                    }
                }
            }
            let (port, exited) = started.ok_or(last_error)?;

            // 窗口先建起来。边车冷启动要十几秒，前端的启动等待页会自己轮询
            // /api/health，比让用户对着空屏幕等更好；就绪与换端口重试交给监督
            // 线程，不占 GUI 主线程。
            if let Err(error) = build_main_window(app, port, &local_token) {
                stop_backend(app.handle());
                return Err(error.into());
            }

            spawn_backend_supervisor(
                app.handle().clone(),
                data_dir,
                shutdown_token,
                local_token,
                port,
                exited,
                std::env::var_os("SHIYIBAO_DESKTOP_SMOKE_FILE").map(PathBuf::from),
            );

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("创建视译宝桌面应用失败");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { .. },
            ..
        } if label == MAIN_WINDOW_LABEL => {
            app_handle.exit(0);
        }
        RunEvent::ExitRequested { api, .. } => {
            // 重建主窗口那一小段时间窗口数为零，别让事件循环顺势把应用带走。
            let rebuilding = app_handle
                .try_state::<WindowRebuilding>()
                .is_some_and(|state| state.0.load(Ordering::SeqCst));
            if rebuilding {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop_backend(app_handle),
        _ => {}
    });
}
