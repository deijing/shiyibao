export interface ChangelogItem {
  version: string
  date: string
  title: string
  tag?: string
  isLatest?: boolean
  highlights: string[]
  details?: {
    features?: string[]
    improvements?: string[]
    fixes?: string[]
  }
}

export const CURRENT_VERSION = 'v0.1.9'

export const CHANGELOG_HISTORY: ChangelogItem[] = [
  {
    version: 'v0.1.9',
    date: '2026-08-12',
    title: '转译流水线、密钥校验与任务重试修复',
    isLatest: true,
    highlights: [
      '修复 OpenAI / 兼容接口返回 JSON 对象时翻译整批失败的问题',
      '部分翻译续传会保留成功句并重试失败句，换音色/音量/语言不再复用旧成片',
      '批处理混流按视频时长对齐，避免原音静音或短配音把成片截断',
      '设置页不再把无效 Key 显示为校验成功；历史与详情重试带上完整 API 配置',
    ],
    details: {
      fixes: [
        'OpenAI json_object 包裹的 translations 数组现在能正确解包',
        'skip_translated 不再把 translated_fallback 原文当成已译而跳过',
        '语音识别未提取到台词时明确报错，不再导出约 1 秒废片',
        '渲染参数变化时清除 chunk / final 成片缓存',
        '打开已完成任务不再清掉正在处理的后台任务徽章',
        '上传失败后可重新选择同一文件；补齐服务端 Key 时不再覆盖本地模型/语言/音色',
        '导出菜单仅保留原画选项，避免误导性的 720P/1080P 转码档位',
        'API 错误改为展示 FastAPI detail；偏好设置改为原子写入',
      ],
    },
  },
  {
    version: 'v0.1.8',
    date: '2026-08-09',
    title: '稳定性修复、轮询热点治理与长视频 TTS 混音性能优化',
    highlights: [
      '修复任务出错后点击「一键重试 / 从断点继续」界面不再刷新的问题，轮询可正确重新启动',
      '降低处理页与导航栏对同一任务状态的重复轮询，合成阶段后冻结字幕全量重拉，减少无效网络与渲染开销',
      '历史任务列表不再每次扫字幕文件提炼标题：首次推导后落库，避免 /api/tasks 随历史增长变慢',
      '长视频批处理 TTS 音轨拼接改为分批混音，规避超长 ffmpeg filtergraph 带来的内存与命令行风险',
    ],
    details: {
      improvements: [
        '导航栏活动任务状态轮询由 2.5s 放慢到 4s，减轻与 ProcessingState 高频轮询的重复请求',
        '处理页进入合成 / 混音阶段后停止重复拉取整段字幕，降低长视频场景下的前端重渲染抖动',
        '抽出字幕标题提炼 helper，首次推导后写入 task.json，后续轮询直接读缓存',
        '偏好设置后端持久化补齐 geminiApiUrl / geminiApiFormat / sourceLang / streamMode / originalAudioVolume 等字段，与前端 localStorage 对齐',
        'TTS 片段时长探测改为 asyncio.to_thread，避免 wave.open 阻塞事件循环',
        '片段数超过 48 时分批混音再叠加，临时分批目录自动清理',
      ],
      fixes: [
        '修复 ProcessingState 在 error/complete 时 clearInterval 后未置空 intervalRef，导致重试无法重启轮询',
        '移除 TaskStatusResponse 中从未赋值、前端也未读取的 gemini_api_url / gemini_api_format 死字段',
        '清理翻译模块重复的 is_429 判定与未使用的 batch_idx 参数',
        '统一 language_detector / voice 路由等文件中散落的 mid-file import，降低维护歧义',
      ],
    },
  },
  {
    version: 'v0.1.7',
    date: '2026-08-09',
    title: '独立白底双卡片工作台、全量字幕 AI 对话问答与 60fps 性能引擎',
    highlights: [
      '视频工作台与白底字幕卡片双卡片分离布局：彻底取消黑色一体框，完全还原经典视频工作台，右侧全新打造独立白底字幕与 AI 学习卡片',
      '交互式 AI 视频问答助教与 Markdown 渲染引擎：内置 MarkdownRenderer 渲染器，高对比度呈现标题、代码块与表格，并支持连续对话流与快捷提问',
      '字幕全格式导出与进度平滑滑动跟随：支持一键导出 SRT、VTT、TXT、JSON 及全量复制，视频播放时字幕列表实时动态居中平滑滑动高亮定位',
      '60fps 极速性能引擎与轻量架构：引入 15fps 毫秒级防抖节流阀、SVG 波形 pre-computation、React.memo 字幕卡片与轻量 Base64 缩略图抽取，消除播放卡顿与 CPU 损耗',
    ],
    details: {
      features: [
        '新增右侧独立白底字幕与 AI 学习面板卡片，支持与左侧视频主工作台 gap-5 优雅分离',
        '新增 MarkdownRenderer 高对比度富文本渲染组件，完美支持 Light/Dark 模式下的标题、粗体、代码块（带复制代码）、列表与表格',
        '新增交互式 AI 视频问答助教对话流（Chat Thread），支持连续提问、清空对话历史与预设 Prompt 一键追问',
        '新增字幕列表导出菜单（SRT/VTT/TXT/JSON/一键复制全量字幕）与多语言模式（双语/译文/原文）快速切换',
        '后端新增 @router.post("/task/{task_id}/ai-analyze") 接口，支持调用 Gemini/OpenAI 进行视频深度提炼与离线兜底分析',
      ],
      improvements: [
        '全面优化界面 Icon 设计（替换为 ListFilter, Wand2, FileDown, Languages, Compass, Clock, Activity, Bot 等语义化 Lucide 图标）',
        '引入 15fps 时间同步防抖节流阀，将视频播放时 React 渲染频率由 60~120Hz 降至 15Hz，大幅降低 CPU 占用',
        '使用 useMemo 预计算并记忆化 180 根 SVG 动态波形柱，播放过程中零 DOM 节点重建开销',
        '将字幕列表卡片抽象为 React.memo 独立组件，高亮切换时仅刷新 2 条相关 DOM 节点',
        '优化缩略图抽取逻辑（由 30 帧精简为 16 帧 JPEG 压缩），显著缩短视频载入时间',
      ],
      fixes: [
        '修复白底模式下 Markdown 字体颜色过浅（如硬编码 text-slate-200/text-white）导致字迹看不见的问题',
        '修复播放时频繁 setState 导致的界面微卡顿与浏览器掉帧问题',
      ],
    },
  },
  {
    version: 'v0.1.6',
    date: '2026-08-08',
    title: '全流程无缝断点续传、AIMD 动态控速与标语工程目录升级',
    highlights: [
      '全流程五重 Checkpoint 断点复用检查，音轨/ASR/翻译/切片极速秒级复用，支持一键无感断点恢复',
      '全新 AIMD 动态自适应速率调节器，智能防御 AI 大模型 429 Rate Limit 限流与自动探顶冲刺',
      '规范自包含工程文件夹架构，AI 总结标题后自动生成直观标语快捷工程目录并支持一键用访达打开',
      '控制台升级高级微光魔术棒 Icon 徽章，异常提示栏增加「一键重试 / 从断点继续」高亮操作按钮',
    ],
    details: {
      features: [
        '实现五重 Checkpoint 检查点检测机制（audio.aac、subtitles_src.json、subtitles_zh.json、chunk_XXX.mp4、final.mp4），大幅减少重复计算',
        '实现 AIMD (加性增大/乘性减小) 拥塞控制算法速率调节器，支持 429 指数退避、Retry-After 响应头解析与多 Key 轮换',
        '生成自包含工程文件夹，并在 workspace/projects/ 创建带【视频总结标题】的软链接快捷工程目录',
        '新增 POST /api/task/{task_id}/open_folder 跨平台接口，支持一键调起 macOS Finder / Windows 资源管理器',
        'ProcessingState 控制台新增「一键重试 / 从断点继续」交互按钮，异常时可直接点选恢复',
      ],
      improvements: [
        '控制台 Header Icon 替换为静态高级 Wand2 徽章，移除旋转动画，提升 UI 优雅度与高级感',
        '应用数据根目录平滑迁移为纯英文 yishibao 规范名称（~/Library/Application Support/yishibao），确保老用户数据无缝继承',
        'GitHub CI/CD 工作流新增 setup-ffmpeg 环境准备步骤，提升云端自动化测试成功率',
      ],
      fixes: [
        '修复部分 API 厂商遭遇 429 时无渐进式退避导致任务直接失败的问题',
        '修复中断重启后已合成切片重复渲染消耗时间的问题',
      ],
    },
  },
  {
    version: 'v0.1.5',
    date: '2026-07-29',
    title: '本地接口访问控制加固与失败可见性修复',
    highlights: [
      '修复本地接口可被浏览器中任意网页读取，导致 Gemini 与 MiMo 密钥泄露的问题',
      '翻译失败不再静默保留原文假装成功：全片失败明确报错，部分失败在日志中告警',
      '桌面端边车启动改为健康检查确认，并修复退出后临时解压目录残留',
    ],
    details: {
      improvements: [
        '本地 API 增加 Origin / Referer 精确主机名白名单与桌面端一次性令牌双重校验',
        'CORS 由全开收窄为本地来源正则，并移除无认证暴露任务目录的 /files 静态挂载',
        'Gemini API Key 全部改走请求头，不再出现在 URL 中被日志与代理记录',
        '桌面出包工作流改为「先验证后发布」，产物数量校验不通过则不发布 Release',
      ],
      fixes: [
        '修复本地目录接口的来源校验可被 localhost.attacker.com 一类域名绕过',
        '修复智能标题生成失败时抛出未定义变量，导致整条转译任务被标记为失败',
        '修复 MiMo 返回异常结构时仅提示单个字段名，且失败后其余分段仍继续消耗额度',
        '修复 HTTP Range 后缀请求（bytes=-N）返回文件开头而非末尾，影响播放器定位',
        '修复边车端口冲突时无重试兜底，界面持续停在等待页且无任何提示',
        '修复 Windows 打包脚本按文件名取安装包，可能把上一个版本当成交付物',
        '修复 macOS 装机验证引用的路径不存在，该验证此前从未真正执行',
        '修复桌面版读取不到 .env 配置，密钥只能通过设置面板写入',
      ],
    },
  },
  {
    version: 'v0.1.4',
    date: '2026-07-28',
    title: '内存架构深度优化与流媒体资源回收升级',
    highlights: [
      '彻底修复时间轴视频帧抽离、声纹试听与流媒体播放器中的 Media 元素与 Blob 内存泄露',
      '后端任务日志 task.json 引入 500 条上限管控，解决大视频转译时的磁盘 I/O 与内存膨胀',
      '加固 React 定时器与异步任务生命周期，组件卸载时自动切断未完成的视频 Seek 与动画帧',
    ],
    details: {
      features: [
        '优化 ResultState 结果页时间轴帧提取流，增加 isCancelled 自动取消与 Video 实例强行销毁机制',
        '优化 VoiceLibrary 声纹试听库，新增页面卸载时的音频播放停止与 Blob URL 自动撤销钩子',
      ],
      improvements: [
        'ProcessingState 聚焦控制台 pollData 解耦 autoFollow 依赖，避免频繁解绑/重建轮询定时器',
        '后端 task.json 日志容量硬上限保护（最大 500 条），大幅提升长任务数据读写性能并降低包体大小',
        'TaskDetailDrawer 字幕导出 Blob URL 撤销延后 1 秒执行，保障低配机器与各种 Webview 环境顺利下载',
      ],
      fixes: [
        '修复在视频缩略图提取过程中离开页面导致的异步状态回调报错与内存持续占用问题',
        '修复流式播放器及组件卸载后后台未及时关闭多媒体流缓冲的问题',
      ],
    },
  },
  {
    version: 'v0.1.3',
    date: '2026-07-25',
    title: '流式渲染稳定性与本地安全加固',
    highlights: [
      '修复流式分片被配音轨截短，播放时间轴与最终成片时长对齐',
      '收紧本地目录扫描 / 路径注册接口，防止跨域网页读取本机视频',
      '浏览器批量模式不再误导「自动归档」，仅桌面端支持绝对路径导出',
    ],
    details: {
      features: [
        '桌面端注入本地访问令牌，保护扫目录与 register-local 接口',
        '无音轨源视频自动用静音占位混音，避免流式渲染整段失败',
      ],
      improvements: [
        'TTS 缓存改为「音色 + 文案」内容寻址，重跑任务不再复用过期配音',
        'HTTP Range 非法请求返回 416，改善视频拖拽与 Seek 兼容性',
        '分片拼接路径转义更稳健，降低 Windows / 特殊字符路径失败率',
        '后端边车端口占用时自动换端口重试，减少桌面启动失败',
        '页面与代码注释全面中文化，版本日志入口保持导航栏 / 设置 / 页脚可见',
      ],
      fixes: [
        '流式 merge_chunk 去掉 -shortest，并用 apad/atrim 补齐时间窗时长',
        '空对白时间窗静音轨按完整窗口时长生成，避免 1 秒静音截断分片',
        '浏览器无法获取输出目录绝对路径时，禁用伪归档并提示改用桌面端',
      ],
    },
  },
  {
    version: 'v0.1.2',
    date: '2026-07-25',
    title: '性能调度硬件感知与开源仓库整合',
    highlights: [
      '新增 GitHub 开源仓库导航与全站页面入口 (deijing/shiyibao)',
      '性能调度中心新增 Windows / macOS / Linux 跨平台硬件感知与动态算力自动分配算法',
      '全新设计系统版本号显示与交互式更新历史日志弹窗',
    ],
    details: {
      features: [
        '顶部导航栏、系统设置弹窗与 Footer 底部全站植入 GitHub 开源仓库地址',
        '增加全系统版本号 Badge 标记与变更日志（Changelog）弹窗页面',
      ],
      improvements: [
        '性能调度可根据 Windows (x86/ARM64) / Mac 逻辑核心数与内存大小一键智能推算推荐并发槽位',
        '优化偏好设置持久化与后端配置拉取逻辑',
      ],
      fixes: [
        '修复不同平台设备在性能调度中心显示硬编码推荐值的提示误导问题',
      ],
    },
  },
  {
    version: 'v0.1.1',
    date: '2026-07-24',
    title: '播放体验引擎与任务通知升级',
    highlights: [
      '新增“极速流式秒开”与“全量沉浸渲染”双播放引擎模式切换',
      '新增任务后台转译完成实效提示气泡与通知中心',
      '优化玻璃拟态 (Glassmorphism) UI 与深色/浅色主题对比度',
    ],
    details: {
      features: [
        '流式模式下启动 5~10 秒即刻开启秒开播放，后台增量缓冲',
        '通知中心支持未读标记、任务快速跳转与历史全量浏览',
      ],
      improvements: [
        '提升大体积视频切片合成效率',
        '改进网络异常下的任务自动重试与断点记录',
      ],
    },
  },
  {
    version: 'v0.1.0',
    date: '2026-07-20',
    title: '视译宝首个桌面与Web双端开源测试版',
    highlights: [
      '整合音频提取、BcutASR 语音识别与 Gemini 智能多语言字幕翻译',
      '整合小米 MiMo 高品质多音色语音合成',
      '支持 FFmpeg 本地音轨对齐、背景音混合与 ASS 特效字幕烧录',
    ],
    details: {
      features: [
        '支持单视频与批量视频自动化转译队列',
        '内置多音色试听与配音角色预设库',
        '支持导出 H.264 / AAC 格式 MP4 视频与 SRT/ASS 字幕文件',
      ],
    },
  },
]
