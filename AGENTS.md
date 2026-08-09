# AGENTS.md

## Cursor Cloud specific instructions

视译宝 (ShiYiBao) 是一个桌面/Web 双模应用：**FastAPI Python 后端边车** + **React 19 + Vite 前端**，外加一个 **Tauri v2 Rust 桌面外壳**（仅打包时需要）。开发调试主要跑 Web 双服务，无需 Tauri。

### 服务概览与运行
- **后端 API**（FastAPI/uvicorn）：监听 `http://127.0.0.1:8000`，文档在 `/docs`，健康检查在 `/api/health`。
- **前端 Web 控制台**（Vite）：`http://127.0.0.1:5173`，通过 Vite 代理把 `/api` 转发到后端 `:8000`（见 `app/vite.config.ts`）。
- **一键启动开发模式**：`python start.py`（同时拉起 uvicorn `--reload` 和 vite）。标准命令见根 `README.md` 与 `package.json` / `app/package.json`，此处不复述。

### 非显而易见的注意事项
- Python 依赖装在仓库根的 **`.venv` 虚拟环境**里（Ubuntu 系统 Python 是 PEP 668 externally-managed，不能直接 pip 装）。运行后端或测试前务必先 `. .venv/bin/activate`。
- `start.py` 用 `sys.executable` 启动 uvicorn，所以**必须在已激活的 `.venv` 里运行 `python start.py`**，否则 uvicorn 找不到依赖。
- `pytest` 需要在激活的 venv 中运行（`python -m pytest`）；`tests/conftest.py` 会把数据目录重定向到临时目录，天然隔离。
- 前端 lint 用的是 **oxlint**（`cd app && npm run lint`），不是 eslint；输出的多为 `react/only-export-components` 等 warning，不阻塞构建。
- **完整视频转译流水线需要外部密钥与网络**：`GEMINI_API_KEY`（翻译/语言检测）、`MIMO_API_KEY`（MiMo TTS 配音），以及可访问 BcutASR 必剪云端（语音识别）。未配置密钥时，前端上传入口会在客户端就拦下（提示先填 Key）；但后端的上传、任务创建、FFmpeg 缩略图/视频流、`/api/environment/check` 等本地能力可独立验证。密钥可放进环境变量（`GEMINI_API_KEY` / `MIMO_API_KEY`）或应用【偏好设置】面板里。
- 系统已装带 `libass` 的 **FFmpeg 6.1**（`/usr/bin/ffmpeg`），字幕烧录与硬件编码探测正常，无需额外安装。
- **Tauri 桌面打包**（`npm run desktop:dev` / `desktop:build`）在 Linux 上需要 `webkit2gtk` 等系统库，且 CI 只在 Windows 上编译 Rust 外壳；Web 开发流程无需它。
