# 视译宝 ShiYiBao 开发计划书（v0.1.12 → v0.2.x）

> 编写日期：2026-11-02 ｜ 依据：v0.1.12 代码走读（`server/`、`app/src/`）与 README 对照。
> 现状：上传/链接 → 抽音轨 → BcutASR → LLM 翻译 → MiMo 配音 → FFmpeg 合成 的主链路完整可用，后端测试 139 项全过。
> 本文只列**未完成 / 与宣传不符 / 明显缺口**，按优先级排期。工时为单人粗估。

---

## 一、未完成功能总览

### A. README 已宣传但未实现（文档与代码不符）

| # | 功能 | 现状（代码位置） |
|---|---|---|
| A1 | 原声音色克隆 | 只能选 8 个 MiMo 预设音色，请求只传音色名（`server/services/tts.py:387`） |
| A2 | 人声 / BGM 分离 | 无分离步骤；原片整轨压到 20% 音量与配音叠加，原说话声仍可听见（`server/services/mixer.py:160`） |
| A3 | 成片双语字幕 | 烧录字幕只有单行译文（`server/services/mixer.py:85`） |
| A4 | AI 问答多轮对话 | 前端每次只发当前问题，无历史上下文（`app/src/components/ResultState.tsx:407`） |
| A5 | 意/葡/阿等语种 | 下拉框仅 8 种语言（`app/src/components/SettingsPanel.tsx:46`） |

### B. 功能缺口

| # | 功能 | 现状 |
|---|---|---|
| B1 | 字幕编辑 + 局部重配音 | 只有读字幕接口，无保存接口；改一句只能整片重跑 |
| B2 | 取消 / 暂停任务 | 只能删除任务，会连缓存一起删（`server/routers/task.py` `delete_task`） |
| B3 | 多说话人 / 多音色 | 全片单一音色，无说话人区分 |
| B4 | 本地 ASR 备选 | 只依赖必剪云端 BcutASR，离线或接口变动即不可用 |
| B5 | 翻译定制 | 无术语表、无自定义提示词 / 风格 |
| B6 | 字幕样式 | 字号/位置/颜色写死；不能选双语烧录或不烧录 |
| B7 | 单独导出配音音轨 | 只能导出成片 mp4 |

### C. 工程 / 杂项

- C1 仓库缺 `LICENSE` 文件（README 声明 MIT 并链接它）
- C2 字幕文件名写死 `subtitles_zh.ass/.srt`，目标语言非中文时名不副实
- C3 `server/routers/task.py` 1400+ 行，流水线、文件流、AI 分析、目录扫描混在一起
- C4 MiMo Key 缺失要等 ASR 跑完才报错（`_execute_pipeline` 内检查），`start_task` 已有前置检查但流水线内重复且偏晚
- C5 `pyproject.toml` 未设 `asyncio_default_fixture_loop_scope`（pytest-asyncio 弃用警告）
- C6 `.venv` 默认未装 `requirements-dev.txt`，AGENTS.md / README 未提示
- C7 未提交的 0.1.12 版本号改动与未跟踪的 `uv.lock` 需处理

---

## 二、里程碑与排期

| 里程碑 | 目标 | 内容 | 粗估 |
|---|---|---|---|
| **M0 清理** | 文档与仓库一致 | C1、C2、C5、C6、C7、A5（补语种）、README 先如实标注 A1–A4 状态 | 1 天 |
| **M1 可控性** | 用户能纠错、能停 | B2 取消/续跑、B1 字幕编辑 + 局部重配音 | 4–6 天 |
| **M2 成片质量** | 听感与画面达标 | A2 人声分离、A3/B6 字幕样式与双语烧录、B7 配音导出 | 4–6 天 |
| **M3 翻译与对话** | 翻译可控、问答可用 | B5 术语表/提示词、A4 多轮问答 | 2–3 天 |
| **M4 进阶** | 扩展能力 | B4 本地 Whisper、B3 多说话人、A1 声音克隆、C3 拆分 task.py | 8–12 天 |

---

## 三、详细任务（TODO）

### M0 清理（1 天）

- [ ] 新增 `LICENSE`（MIT，署名待定）
- [ ] 字幕产物按目标语言命名：`subtitles_{target_lang}.ass/.srt`
  - 涉及 `server/services/mixer.py`（`write_ass_subtitles` 默认名）、`server/routers/task.py`（`start_task` 清理列表里的 `subtitles_zh.*`）、`server/services/retiming.py` 引用处
  - 兼容旧任务：读取时回退查找 `subtitles_zh.*`
- [ ] `pyproject.toml` 增加 `asyncio_default_fixture_loop_scope = "function"`
- [ ] AGENTS.md / README 开发说明补一句：`pip install -r requirements-dev.txt` 后再跑 pytest
- [ ] 语种：`SOURCE_LANGUAGES` / `TARGET_LANGUAGES` 增加 it / pt / ar；同步 `getLanguageDisplayName`、`HistoryView`/`ResultState`/`TaskDetailDrawer` 的语言名映射；确认 `translate.py`、`language_detector.py` 的语言名映射覆盖新语种
  - 需验证：MiMo 对这些语种的 TTS 效果；BcutASR 对其识别效果（不支持则在 UI 标注"仅翻译/字幕"）
- [ ] README 在 A1–A4 实现前如实改写或标注"规划中"
- [ ] 提交 0.1.12 版本号改动；决定 `uv.lock` 提交或加入 `.gitignore`

**验收**：pytest 全过且无弃用警告；英文目标任务产出 `subtitles_en.ass`；旧任务仍能播放/导出。

### M1 可控性（4–6 天）

#### B2 取消 / 续跑
- [ ] 后端 `POST /api/task/{id}/cancel`：取消 `_active_tasks[id]`，**不删文件**；stage 置 `error`、message「已取消，可继续」，新增 meta 字段 `cancelled: true`
- [ ] 续跑复用现有 `POST /task/{id}/start`（各阶段已有缓存跳过逻辑）
- [ ] 前端 `ProcessingState` 增加「停止」按钮；`HistoryView` 对已取消任务显示「继续」而不是「重新尝试」
- [ ] 测试：取消后缓存文件仍在；再次 start 能跳过已完成阶段

#### B1 字幕编辑 + 局部重配音
- [ ] 后端 `PUT /api/task/{id}/subtitles`：入参 `[{index, translated_text, start?, end?}]`
  - 校验 index 存在、时间合法；原子写回 `subtitles_{lang}.json`（tmp + replace，参照 `_recover_stale_tasks` 写法）
  - 标记受影响时间范围，记录到 meta `dirty_ranges`
- [ ] 后端 `POST /api/task/{id}/rerender`：
  - 流式模式：删除与 `dirty_ranges` 重叠的 `chunk_XXX.mp4`、`dub_XXX.wav` 及 `final.mp4`，再走 `start` 流程；未改动分片会被 `_reusable_rendered_mp4` 复用，未改动句子的 TTS 会命中 `_tts_cache_path` 内容哈希缓存
  - batch / slow_video 模式：删 `final.mp4`、`dubbed_audio.wav` 后重跑（TTS 仍按句命中缓存）
  - 注意：`_build_tts_utterances` 会合并相邻短句，改一句可能改变合并结果 → 按合并后的 utterance 判断受影响分片
- [ ] 前端 `ResultState` 字幕列表支持行内编辑（译文；时间轴第二期），显示"有 N 处未生效修改"，按钮「重新生成配音」
- [ ] 测试：改 1 句 → 只有对应 1 个 TTS 请求、只重渲染覆盖它的分片；JSON 写入原子性；非法 index 返回 422

**验收**：10 分钟视频改 1 句，重渲染耗时明显低于整片；成片该句配音与字幕均已更新。

### M2 成片质量（4–6 天）

#### A2 人声 / BGM 分离
- [ ] 选型：demucs（效果好、需 torch，体积大）vs. 云端分离 API vs. FFmpeg 简单中置声道消除（效果差但零依赖）。**需决策**，桌面包体积是主要约束
- [ ] 新增 `server/services/separator.py`：输出 `bgm.wav`，作为第 6 个 checkpoint
- [ ] `mixer._mix_filter_complex` 优先用 `bgm.wav` 作背景轨；无分离结果时回退现有逻辑
- [ ] 设置项「背景音处理：保留原声（降低音量）/ 仅保留背景音」
- [ ] 依赖设为可选：未安装时 UI 灰掉并给出安装提示

#### A3 / B6 字幕样式与双语烧录
- [ ] 新增设置：烧录模式（译文 / 双语 / 不烧录）、字号、底边距、主色/描边色
- [ ] `write_ass_subtitles` 支持双语：两个 Style（译文大、原文小），同一时间两条 Dialogue
- [ ] 「不烧录」时跳过 `-vf`，改为把 SRT 作为软字幕轨封装进 mp4（`-c:s mov_text`）
- [ ] `TaskStartRequest` 增加 `subtitle_style` 字段；样式变化时作废已渲染分片
- [ ] 测试：ASS 内容快照测试；三种模式 FFmpeg 命令参数断言

#### B7 配音音轨导出
- [ ] `GET /api/task/{id}/export?kind=dub_audio|subtitled_video|clean_video`
- [ ] 流式模式下配音分散在 `dub_XXX.wav`，导出前 concat 成单文件
- [ ] 前端导出菜单增加对应入口

### M3 翻译与对话（2–3 天）

#### B5 术语表 / 自定义提示词
- [ ] 设置项：术语表（`原文 => 译文` 每行一条）、翻译风格（口语 / 书面 / 自定义提示词）
- [ ] `translate_subtitles` 把术语表与风格拼进 system prompt；术语表过长时只注入当前批次出现的词条
- [ ] 翻译缓存键要包含术语表/风格哈希，否则改了术语不会重译
- [ ] 测试：prompt 构造单测；术语出现在请求体中

#### A4 多轮问答
- [ ] `AIAnalyzeRequest` 增加 `history: [{role, content}]`（限制最近 N 轮 / 总字数）
- [ ] `build_ai_request_args` 支持多消息（目前只接受单个 system + user），四种协议（OpenAI Chat / Responses / Anthropic / Gemini）分别适配
- [ ] 前端 `handleSendChatMessage` 把 `chatMessages` 一并发送
- [ ] 字幕全文很长时考虑截断或先摘要，避免超上下文

### M4 进阶（8–12 天）

- [ ] **B4 本地 ASR**：可选 faster-whisper / whisper.cpp；`asr.py` 抽象出引擎接口，设置中可选「必剪云端 / 本地 Whisper」；必剪失败时可自动回退
- [ ] **B3 多说话人**：ASR 段落增加 `speaker` 字段（Whisper + pyannote，或云端带说话人分离的 ASR）；UI 为每个说话人选音色；`_build_tts_utterances` 不跨说话人合并
- [ ] **A1 声音克隆**：先确认 MiMo 是否支持参考音频克隆；不支持则评估其他 TTS（如 CosyVoice / F5-TTS 本地，或其他云服务），抽象 TTS 引擎接口；需处理用户授权与合规提示
- [ ] **C3 拆分 `task.py`**：拆为 `pipeline.py`（流水线）、`media_routes.py`（视频/分片/缩略图）、`analysis.py`（AI 分析）、`local_fs.py`（注册本地/扫描目录）；纯重构，依靠现有 139 项测试保障
- [ ] **C4**：MiMo Key 检查前移到流水线开头，移除流水线内重复检查

---

## 四、待决策事项

1. 人声分离方案（demucs 本地 / 云端 / 简易滤镜）——影响桌面包体积与 CPU 时间
2. 声音克隆的 TTS 供应商与合规边界
3. README 在功能实现前是"改写"还是"标注规划中"
4. 是否支持字幕时间轴编辑（M1 只做文本编辑）

## 五、通用要求

- 每项功能附带 pytest 用例；涉及 FFmpeg 的用命令参数断言，避免 CI 依赖真实渲染
- 新增 checkpoint 产物都要进入 `start_task` 的失效清理逻辑
- 新接口沿用 `guard_api_origin` 安全校验，不加入 `PUBLIC_API_PATHS`
- 每个里程碑结束更新 `app/src/lib/changelog.ts` 与 README
