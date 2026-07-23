# 视译宝（ShiYiBao）

视译宝是一套本地运行的视频转译 Web 应用：上传视频后，依次执行音频提取、语音识别、Gemini 字幕翻译、MiMo 语音合成、音轨混合与字幕烧录，最终导出 H.264/AAC MP4。

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

也可以启动后在“设置”中填写密钥。`.env`、浏览器本地存储和 `workspace/user_settings.json` 都可能保存密钥；不要分享这些文件，也不要将它们提交到 Git。仓库不包含任何默认密钥。

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

## 使用流程

1. 在设置中填写并测试 Gemini 与 MiMo 密钥。
2. 选择翻译模型、源语言、目标语言和配音音色。
3. 上传视频并等待识别、翻译、配音和混流完成。
4. 在结果页预览字幕、原音轨和配音轨。
5. 下载字幕 JSON 或转译后的 MP4。

任务文件保存在 `workspace/`，删除历史任务时会同时删除对应上传文件和生成物。服务重启后，未完成的任务会被标记为中断，需要手动重试。

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

低内存电脑建议从 `.env.example` 的保守并发值开始。运行时也可以在“性能”页面调整，并会保存到 `workspace/performance.json`。

## 架构

```text
浏览器（React + Vite）
        │ /api
        ▼
FastAPI ── 任务元数据与生成物（workspace/）
  ├─ FFmpeg：提取音频、对齐、混流、字幕烧录
  ├─ BcutASR：语音识别
  ├─ Gemini：字幕翻译
  └─ MiMo：语音合成
```

主要目录：

- `app/src/`：React 前端
- `server/routers/`：HTTP API 与任务调度
- `server/services/`：ASR、翻译、TTS、音视频处理
- `tests/`：后端单元测试
- `workspace/`：本地运行数据，不纳入版本控制

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
- 上传的视频、字幕、音频、日志和设置均保存在本机 `workspace/`。
- 音频和文本会发送至第三方 ASR、Gemini 与 MiMo 服务；使用前请确认素材授权与相应服务条款。
- 本项目没有用户认证，不适合直接暴露到公网。

## 已知限制

- BcutASR 为第三方封装的云端识别服务，上游接口变化可能导致识别不可用。
- 当前以本地开发服务器方式运行，不包含公网部署、用户鉴权或对象存储。
- 超长视频会消耗大量磁盘空间、网络流量和编码时间。
- 处理结果质量取决于原视频音质、翻译模型、TTS 服务和字体环境。

## 许可证

仓库目前未附带开源许可证；除非版权所有者另行授权，否则默认保留全部权利。
