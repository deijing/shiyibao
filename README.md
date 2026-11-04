# 声帆 SailVoice v2.3.0

**一句话，让中国故事走向世界，让世界佳作走进中国。**

比赛分支：`codex/culture-competition`。基于视译宝 ShiYiBao 的技术基座，采用「声帆」品牌及海蓝 #0B4F8A、中国红 #C8102E 的视觉，服务中国视频与文化内容的多语种出海。

本分支保留原有功能与处理逻辑。首页直接进入视频工坊；产品内不设置文化策划、知识库或参赛准备模块。

## 当前功能

- 本地视频上传，或粘贴支持的视频平台链接获取素材。
- 必剪 ASR 语音识别，多模型字幕翻译，MiMo 预设音色配音，FFmpeg 成片合成。
- 保留原片时长并加速配音，或按配音时长放慢画面，同步原声与字幕。
- SRT、VTT、TXT、JSON 字幕文件导出，支持仅译文、仅原文及双语。
- 批量处理、历史项目、音色库、性能调度及原有字幕问答功能。
- FastAPI 后端、React Web 前端与 Tauri 桌面外壳。

语言设置当前覆盖中、英、日、韩、法、德、西、俄。配音使用现有音色接口，未实现自主训练语音模型或声音克隆。原声保留通过降低原片整轨音量后与配音混合，未独立分离人声与 BGM。成片烧录为译文字幕；文化含义、地域差异和译文正确性需要人工校审。

## 本地运行

需要 Python 3.10+（推荐 3.12）、Node.js 20.19+ 或 22.12+，以及带 libass、H.264、AAC 支持的 FFmpeg 和 FFprobe。

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm --prefix app ci
python start.py
```

必须在已激活的 `.venv` 中运行启动器。

- [工作台](http://127.0.0.1:5173/)
- [后端 API 文档](http://127.0.0.1:8000/docs)
- [健康检查](http://127.0.0.1:8000/api/health)

首页 `/` 为视频工坊；`/batch` 为批量制作，`/history` 为作品档案，`/voices` 为音色库，`/performance` 为性能调度。

## 模型与存储

完整视频流水线需要外部模型密钥、MiMo TTS 密钥及可访问的必剪 ASR 服务。可在【偏好设置】中配置，也可从 `.env.example` 复制环境变量示例：

```bash
cp .env.example .env
```

翻译模型的地址、协议和模型名称需与服务商实际支持情况一致。原片、字幕、任务与工程保存在系统用户数据目录的 `yishibao/workspace` 中；`SHIYIBAO_DATA_DIR` 可覆盖存储位置，`SHIYIBAO_FFMPEG_DIR` 可指定媒体工具目录。本分支保留原项目的数据与配置约定。

## 验证

```bash
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m pytest -q
npm --prefix app run lint
npm --prefix app run build
```

测试使用临时数据目录。自动化检查不能替代真实云端流水线和目标语言质量验证。

## 桌面与容器

Web 开发不需要 Tauri。桌面打包额外安装根目录 npm 依赖与 Python 构建依赖：

```bash
source .venv/bin/activate
python -m pip install -r requirements-build.txt
npm ci
npm run desktop:dev
# 或 npm run desktop:build
```

比赛分支桌面名称为「华章」，应用标识为 `com.shiyibao.huazhang`，可执行包名仍为 `shiyibao`。产物位于 `src-tauri/target/release/bundle/`。桌面安装包需按目标平台另行验证。

安装 Docker 后也可运行 `docker compose up --build`，访问 [本地容器工作台](http://localhost:8000/)。当前未部署评审用公网服务。

## 比赛定位与来源

[比赛定位与章程核对](docs/competition.md) 保留在仓库文档中，供准备申报与答辩材料时参考，不作为产品功能。比赛改造主要是场景定位、品牌与视觉，本次没有新增文化智能体、文化知识库或术语约束算法，不将这些能力写入申报成果。

原项目、外部模型及团队新增工作应分别说明。原 README 标示 MIT，但仓库未发现独立 LICENSE 文件，送审或分发前需核实许可依据。视频、音乐、声音与出镜者应有必要授权；传播数据、用户与合作案例应有真实记录支持。
