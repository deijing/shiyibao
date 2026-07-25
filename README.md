# 视译宝（ShiYiBao）

[![GitHub Repository](https://img.shields.io/badge/GitHub-deijing%2Fshiyibao-blue?logo=github)](https://github.com/deijing/shiyibao)
> 开源仓库地址：[https://github.com/deijing/shiyibao](https://github.com/deijing/shiyibao)

视译宝是一套本地运行的视频转译应用，可作为 Tauri v2 原生桌面应用分发，也保留 React + FastAPI 的浏览器开发模式。上传视频后，应用依次执行音频提取、语音识别、Gemini 字幕翻译、MiMo 语音合成、音轨混合与字幕烧录，最终导出 H.264/AAC MP4。

## 功能

- 视频上传、任务队列、处理进度、日志和历史记录
- BcutASR 中文语音识别
- Gemini 多语言字幕翻译
- 小米 MiMo 多音色语音合成
- FFmpeg 音轨对齐、背景声混合、ASS 字幕烧录
- 动态并发参数和系统硬件信息
- 深色模式、结果预览、字幕与视频导出

## 支持环境

项目通过 GitHub Actions 在 Windows、macOS、Ubuntu 上执行后端测试和前端构建。建议环境：

- Python 3.10–3.14（CI 使用 3.12）
- Node.js 20.19+ 或 22.12+（CI 使用 22）
- npm 10+
- Rust 1.77.2+（仅桌面开发/打包需要）
- FFmpeg 6+，必须包含 `libass`、`libx264` 和 AAC 支持
- Chrome、Edge、Firefox 或 Safari 的近期版本

应用依赖 Gemini、MiMo 和 BcutASR 的网络服务，因此离线电脑、受限网络或服务所在地区不可用时，完整转译流程无法运行。硬件性能也会直接影响视频编码时间。

## 安装

### 1. 安装 FFmpeg

macOS（Homebrew）：

```bash
brew install ffmpeg
```

Windows（WinGet）：

```powershell
winget install Gyan.FFmpeg
```

Ubuntu / Debian：

```bash
sudo apt update
sudo apt install ffmpeg
```

确认安装成功，并检查 ASS 字幕滤镜：

```bash
ffmpeg -version
ffmpeg -filters
```

第二条命令的输出中应包含 `ass` 滤镜。

### 2. 安装后端依赖

推荐使用虚拟环境：

macOS / Linux：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Windows PowerShell：

```powershell
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### 3. 安装前端依赖

```bash
cd app
npm ci
cd ..
```

### 4. 配置密钥

复制示例文件：

macOS / Linux：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`：

```dotenv
GEMINI_API_KEY=你的_Gemini_Key
MIMO_API_KEY=你的_MiMo_Key
```

也可以启动后在“设置”中填写密钥。`.env`、浏览器本地存储和用户数据目录中的 `workspace/user_settings.json` 都可能保存密钥；不要分享这些文件，也不要将它们提交到 Git。仓库不包含任何默认密钥。

## 启动

跨平台通用方式：

```bash
python start.py
```

也可以使用系统入口：

- macOS / Linux：`./start.sh`
- Windows：双击 `start.bat`，或在终端运行 `start.bat`

启动器会检查 Python、npm、FFmpeg、后端依赖和 `node_modules`，然后仅在本机回环地址启动：

- 前端：http://localhost:5173
- API 文档：http://localhost:8000/docs
- 健康检查：http://localhost:8000/api/health

按 `Ctrl+C` 会同时关闭前后端。

## 桌面开发与打包

桌面外壳位于 `src-tauri/`，FastAPI 通过 PyInstaller 打成单文件边车。首次准备：

```bash
npm ci
cd app && npm ci && cd ..
python -m pip install -r requirements-build.txt
```

桌面端 ICNS、ICO 与各尺寸 PNG 图标均由 `app/public/logo.png` 生成。

启动桌面开发模式：

```bash
npm run desktop:dev
```

构建当前平台的安装包：

```bash
npm run desktop:build
```

构建脚本会读取 `rustc --print host-tuple`，生成符合 Tauri 命名规则的
`src-tauri/binaries/shiyibao-backend-<target-triple>[.exe]`。macOS 产物位于
`src-tauri/target/release/bundle/dmg/`，Windows 在对应系统上生成 NSIS 安装程序 EXE。

默认安装包不内置 FFmpeg。应用启动后会检测 `ffmpeg` 与 `ffprobe`；除当前
`PATH` 外，还会自动检查 macOS 的 Homebrew/MacPorts 常见目录
（`/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`）以及 Windows 的
WinGet、Chocolatey、Scoop 和常见 Program Files 安装目录。缺失时会在界面中显示
安装说明与下载入口。若要用自包含的 FFmpeg 构建增大约 50MB 的开箱即用版本，可运行：

```bash
npm run sidecar:build:ffmpeg
npm run tauri -- build
```

内置模式应使用可再分发的静态 FFmpeg/ffprobe 构建，并确保其许可证适合你的分发方式。

macOS 与 Windows 不能用这套链路直接交叉生成安装包。`.github/workflows/desktop.yml`
提供原生 runner 矩阵，可在 GitHub Actions 中手动运行，或推送 `desktop-v*` 标签，
分别产出 DMG 和 EXE 工作流制品。

桌面出包工作流会在上传产物前执行两层运行验证：先直接启动 PyInstaller
边车完成上传、目录扫描、Range 播放与 FFmpeg 缩略图等接口测试；再启动打包后的
Tauri 主程序并等待其动态端口 `/api/health` 就绪。Windows 任务会先静默安装
NSIS EXE，再从安装目录启动应用，因此工作流成功不仅代表编译通过，也代表
安装后的主程序能够创建窗口、拉起边车并定位 FFmpeg。

## 使用流程

1. 在设置中填写并测试 Gemini 与 MiMo 密钥。
2. 选择翻译模型、源语言、目标语言和配音音色。
3. 上传视频并等待识别、翻译、配音和混流完成。
4. 在结果页预览字幕、原音轨和配音轨。
5. 下载字幕 JSON 或转译后的 MP4。

桌面端批量模式使用 Tauri 原生目录选择器，输入目录会返回绝对路径并立即扫描，
输出目录会以绝对路径传给边车完成自动归档。浏览器开发模式因浏览器安全限制，
文件夹选择会回退为逐文件上传；需要原地扫描或自动归档时可直接粘贴绝对路径。

任务文件保存在系统用户数据目录，删除历史任务时会同时删除对应上传文件和生成物。服务重启后，未完成的任务会被标记为中断，需要手动重试。

- macOS 桌面包：`~/Library/Application Support/com.shiyibao.desktop/workspace/`
- Windows 桌面包：`%APPDATA%\com.shiyibao.desktop\workspace\`
- Linux 桌面包：`$XDG_DATA_HOME/com.shiyibao.desktop/workspace/`

直接运行 Python 后端时仍使用平台默认的“视译宝/shiyibao”目录。Tauri 桌面包会把
自己的应用数据目录通过 `SHIYIBAO_DATA_DIR` 注入边车，避免写入只读安装目录。

可用 `SHIYIBAO_DATA_DIR` 覆盖根数据目录。

## 配置项

| 环境变量 | 默认值 | 范围 / 说明 |
| --- | ---: | --- |
| `GEMINI_API_KEY` | 空 | Gemini API Key |
| `MIMO_API_KEY` | 空 | 小米 MiMo TTS Key |
| `MAX_CONCURRENT_TASKS` | `4` | 1–12 |
| `TRANSLATE_CONCURRENCY` | `3` | 1–8 |
| `TRANSLATE_BATCH_SIZE` | `20` | 5–50 |
| `TTS_CONCURRENCY` | `6` | 1–16 |
| `SUBTITLE_FONT` | `Arial` | ASS 字幕字体；不存在时由 libass 回退 |
| `SHIYIBAO_PORT` | `8000` | 后端监听端口；桌面端由 Tauri 动态注入 |
| `SHIYIBAO_DATA_DIR` | 系统用户数据目录 | 上传、任务、预览与本地设置的根目录 |
| `SHIYIBAO_FFMPEG_DIR` | 空 | 可选的内置/自定义 FFmpeg 与 ffprobe 目录 |

低内存电脑建议从 `.env.example` 的保守并发值开始。运行时也可以在“性能”页面调整，并会保存到用户数据目录下的 `workspace/performance.json`。

构建边车后可用最小 GUI `PATH` 执行真实接口验收：

```bash
python scripts/test_packaged_sidecar.py \
  --sidecar src-tauri/binaries/shiyibao-backend-$(rustc --print host-tuple)
```

## 架构

```text
Tauri v2 原生外壳
  ├─ React + Vite（运行时注入动态 API base）
  └─ PyInstaller FastAPI 边车（127.0.0.1:动态端口）
        ├─ 用户数据目录：任务元数据与生成物
        ├─ FFmpeg：提取音频、对齐、混流、字幕烧录
        ├─ BcutASR：语音识别
        ├─ Gemini：字幕翻译
        └─ MiMo：语音合成
```

主要目录：

- `app/src/`：React 前端
- `server/routers/`：HTTP API 与任务调度
- `server/services/`：ASR、翻译、TTS、音视频处理
- `src-tauri/`：Tauri v2 外壳、边车生命周期和桌面打包配置
- `scripts/build_sidecar.py`：PyInstaller 边车构建入口
- `tests/`：后端单元测试
- 系统用户数据目录：本地运行数据

## 开发与验证

安装开发依赖并运行检查：

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
cd app
npm run lint
npm run build
```

前端 lint 当前可能报告 Fast Refresh 的非阻断警告；构建失败或 lint 错误会使命令返回非零状态。CI 会在 Windows、macOS 和 Ubuntu 上执行同样的检查。

## 常用 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/upload` | 上传视频并创建任务 |
| `POST` | `/api/task/{id}/start` | 启动转译流水线 |
| `GET` | `/api/task/{id}/status` | 查询任务状态 |
| `GET` | `/api/task/{id}/logs` | 查询处理日志 |
| `GET` | `/api/task/{id}/subtitles` | 获取字幕 |
| `GET` | `/api/task/{id}/export` | 下载成片 |
| `DELETE` | `/api/task/{id}` | 取消并删除任务 |
| `GET/POST` | `/api/settings` | 读取 / 保存本地设置 |
| `GET/PUT` | `/api/performance` | 读取 / 更新并发设置 |

完整交互式文档见 `/docs`。

## 故障排查

### 提示“未找到 FFmpeg”

重新打开终端并运行 `ffmpeg -version`。Windows 安装后通常需要重启终端，使新的 `PATH` 生效。

### FFmpeg 报告 `No such filter: ass`

当前 FFmpeg 构建没有启用 libass。请换用完整构建，并确认 `ffmpeg -filters` 包含 `ass`。

### 中文字幕显示方框

在 `.env` 设置本机已有的中文字体，例如 Windows 的 `Microsoft YaHei`、macOS 的 `PingFang SC` 或 Linux 安装后的 `Noto Sans CJK SC`。

### API 校验失败或频繁出现 429

检查密钥、账户额度、代理和网络区域；然后降低翻译 / TTS 并发。应用对 429 和部分服务端错误会自动重试三次。

### 端口被占用

默认端口为前端 `5173`、后端 `8000`。先关闭占用端口的旧进程，再重新运行启动器。

## 安全说明

- 服务默认只监听 `127.0.0.1`，不要在不可信网络中改为 `0.0.0.0`。
- 上传的视频、字幕、音频、日志和设置均保存在本机用户数据目录。
- 音频和文本会发送至第三方 ASR、Gemini 与 MiMo 服务；使用前请确认素材授权与相应服务条款。
- 本项目没有用户认证，不适合直接暴露到公网。

## 已知限制

- BcutASR 为第三方封装的云端识别服务，上游接口变化可能导致识别不可用。
- 桌面安装包尚未配置 Apple/Windows 代码签名；公开分发前需补齐签名与公证。
- 超长视频会消耗大量磁盘空间、网络流量和编码时间。
- 处理结果质量取决于原视频音质、翻译模型、TTS 服务和字体环境。

## 许可证

仓库目前未附带开源许可证；除非版权所有者另行授权，否则默认保留全部权利。
