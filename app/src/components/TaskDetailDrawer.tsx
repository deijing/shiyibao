import { useEffect, useRef, useState, useCallback } from 'react'
import {
  ChevronLeft, FileVideo, CheckCircle2, XCircle, Loader2,
  Download, FileText, RotateCcw, Copy, Check, Terminal,
  Clock, Languages, Mic, Sparkles, ArrowDownCircle, RefreshCw,
  AlertCircle
} from 'lucide-react'
import { getTaskStatus, getTaskLogs, getExportUrl, getSubtitles, startTask, getThumbnailUrl, type TaskStatus, type TaskLogItem } from '@/lib/api'
import { loadSettings, buildTaskStartConfig } from './SettingsPanel'
import { Button } from '@/components/ui/button'

function TaskDetailVideoThumbnail({ taskId, alt }: { taskId: string; alt?: string }) {
  const [hasError, setHasError] = useState(false)
  const thumbnailUrl = getThumbnailUrl(taskId)

  if (hasError || !taskId) {
    return (
      <div className="w-24 sm:w-28 aspect-video rounded-xl bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/60 dark:to-purple-950/60 border border-indigo-100 dark:border-indigo-900/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0 shadow-2xs">
        <FileVideo className="w-6 h-6" />
      </div>
    )
  }

  return (
    <div className="w-24 sm:w-28 aspect-video rounded-xl overflow-hidden border border-slate-200/80 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 shrink-0 shadow-xs">
      <img
        src={thumbnailUrl}
        alt={alt || '视频封面'}
        onError={() => setHasError(true)}
        className="w-full h-full object-cover"
      />
    </div>
  )
}

const LANG_LABELS: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
}

// 可视化步骤条的五个阶段
const PIPELINE_STEPS = [
  { id: 'upload', label: '上传解析', stages: ['pending', 'extracting_audio'] },
  { id: 'asr', label: '语音识别(ASR)', stages: ['transcribing'] },
  { id: 'translate', label: 'AI 翻译核心', stages: ['translating'] },
  { id: 'tts', label: '音色克隆与合成', stages: ['synthesizing'] },
  { id: 'mix', label: '视频合并导出', stages: ['mixing', 'complete'] },
]

// 长时间 AI 操作的上下文模拟日志
const PLACEBO_LOG_PHRASES: Record<string, string[]> = {
  translating: [
    '正在分析视频对话上下文与特定领域词汇...',
    '正在进行多语种意译润色与文化表达对齐...',
    '正在校准字幕断句与说话人时间轴映射...',
    '正在优化目标语言行文流畅度与标点匹配...',
  ],
  synthesizing: [
    '正在提取源声轨音色特征并对齐基频波形...',
    '正在通过神经网络渲染高拟真度对白语音...',
    '正在进行音频帧率对齐与口型节奏补偿...',
    '正在合成双声道无损目标语音轨道...',
  ],
  transcribing: [
    '正在过滤背景噪音与环境音效干扰...',
    '正在使用 BcutASR (必剪云端引擎) 进行语音断句与时间戳提取...',
    '正在切割台词分句并生成高精度字幕序列...',
  ],
  mixing: [
    '正在启动 FFmpeg 多轨高清音视频渲染引擎...',
    '正在烧录高清晰度双语字幕物理轨道...',
    '正在封装标准 MP4 (H.264/AAC) 视频流...',
  ],
}

interface TaskDetailDrawerProps {
  taskId: string | null
  isOpen: boolean
  onClose: () => void
  onRetrySuccess?: () => void
}

export default function TaskDetailDrawer({ taskId, isOpen, onClose, onRetrySuccess }: TaskDetailDrawerProps) {
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [logs, setLogs] = useState<TaskLogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const [retrying, setRetrying] = useState(false)

  const logConsoleRef = useRef<HTMLDivElement>(null)
  const placeboIndexRef = useRef(0)

  // 获取状态与后端日志
  const fetchDetail = useCallback(async () => {
    if (!taskId) return
    try {
      const [st, backendLogs] = await Promise.all([
        getTaskStatus(taskId),
        getTaskLogs(taskId),
      ])
      setStatus(st)

      if (backendLogs && backendLogs.length > 0) {
        setLogs(backendLogs)
      } else {
        // 后端日志尚未积累时使用默认初始日志
        setLogs([
          {
            timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            tag: '系统',
            message: `初始化任务 [${taskId.substring(0, 8)}] 状态监听器...`,
            type: 'info',
          },
        ])
      }
    } catch {
      /* 忽略拉取错误 */
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    if (!isOpen || !taskId) return
    setLoading(true)
    fetchDetail()

    const interval = window.setInterval(fetchDetail, 2500)
    return () => window.clearInterval(interval)
  }, [isOpen, taskId, fetchDetail])

  // 进行中阶段的模拟日志生成器
  useEffect(() => {
    if (!isOpen || !status) return
    const stage = status.stage

    if (['complete', 'error', 'pending'].includes(stage)) return

    const phrases = PLACEBO_LOG_PHRASES[stage] || [
      '系统正在后台进行多模态 AI 数据推理...',
      '正在校验音视频帧对齐质量...',
    ]

    const timer = window.setInterval(() => {
      const msg = phrases[placeboIndexRef.current % phrases.length]
      placeboIndexRef.current += 1

      const tagMap: Record<string, string> = {
        translating: 'AI 翻译',
        synthesizing: '音色合成',
        transcribing: '语音识别',
        mixing: '视频合并',
      }
      const tag = tagMap[stage] || '系统'

      setLogs((prev) => {
        // 避免添加重复消息
        if (prev.length > 0 && prev[prev.length - 1].message === msg) return prev
        return [
          ...prev,
          {
            timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            tag,
            message: msg,
            type: stage === 'translating' || stage === 'synthesizing' ? 'api' : 'info',
          },
        ]
      })
    }, 4500)

    return () => window.clearInterval(timer)
  }, [isOpen, status])

  // 自动滚动终端日志至底部
  useEffect(() => {
    if (autoScroll && logConsoleRef.current) {
      logConsoleRef.current.scrollTop = logConsoleRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  const handleCopyLogs = () => {
    const formatted = logs
      .map((l) => `[${l.timestamp}] [${l.tag}] ${l.message}`)
      .join('\n')
    navigator.clipboard.writeText(formatted)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleRetry = async () => {
    if (!taskId) return
    const settings = loadSettings()
    if (!settings.geminiApiKey) {
      alert('请先在系统设置中填入 Gemini API Key')
      return
    }

    setRetrying(true)
    try {
      await startTask(taskId, buildTaskStartConfig(settings, {
        voice: status?.voice,
        source_lang: status?.source_lang,
        target_lang: status?.target_lang,
        stream_mode: status?.stream_mode,
        original_audio_volume: status?.original_audio_volume,
      }))
      setStatus((prev) => prev ? { ...prev, stage: 'pending', progress: 0, error: null } : null)
      setLogs((prev) => [
        ...prev,
        {
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          tag: '系统',
          message: '用户手动发起重试，正在重新启动 AI 转译流水线...',
          type: 'info',
        },
      ])
      if (onRetrySuccess) onRetrySuccess()
    } catch (err) {
      alert(`重试启动失败: ${err instanceof Error ? err.message : '请检查网络配置'}`)
    } finally {
      setRetrying(false)
    }
  }

  const handleDownloadSubtitles = async () => {
    if (!taskId) return
    try {
      const subs = await getSubtitles(taskId)
      if (!subs || subs.length === 0) {
        alert('暂无可用的字幕数据')
        return
      }
      const jsonStr = JSON.stringify(subs, null, 2)
      const blob = new Blob([jsonStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `subtitles_${taskId.substring(0, 8)}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      alert('字幕导出失败')
    }
  }

  if (!isOpen) return null

  // 确定步骤条当前激活索引
  const currentStage = status?.stage || 'pending'
  const isError = currentStage === 'error'
  const isComplete = currentStage === 'complete'

  let activeStepIndex = 0
  if (currentStage === 'extracting_audio') activeStepIndex = 0
  else if (currentStage === 'transcribing') activeStepIndex = 1
  else if (currentStage === 'translating') activeStepIndex = 2
  else if (currentStage === 'synthesizing') activeStepIndex = 3
  else if (currentStage === 'mixing') activeStepIndex = 4
  else if (currentStage === 'complete') activeStepIndex = 5

  return (
    <div className="fixed inset-0 z-50 overflow-hidden flex justify-end bg-slate-900/50 backdrop-blur-xs transition-opacity duration-300">
      {/* 点击遮罩关闭 */}
      <div className="absolute inset-0" onClick={onClose} />

      {/* 抽屉主体内容 */}
      <div className="relative w-full max-w-4xl bg-slate-50 dark:bg-slate-950 h-full shadow-2xl flex flex-col border-l border-slate-200 dark:border-slate-800 transition-transform duration-300 ease-out translate-x-0 overflow-y-auto">
        {/* 顶部标题与面包屑 */}
        <div className="sticky top-0 z-20 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-1 text-xs font-medium cursor-pointer rounded-xl px-2.5 py-1.5"
            >
              <ChevronLeft className="w-4 h-4" />
              返回历史项目
            </Button>
            <span className="text-slate-300 dark:text-slate-700">/</span>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                任务详情与日志
              </span>
              {taskId && (
                <span className="text-[10px] font-mono bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-700">
                  {taskId.substring(0, 8)}
                </span>
              )}
            </div>
          </div>

          {/* 标题操作按钮 */}
          <div className="flex items-center gap-2">
            {isComplete && taskId && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDownloadSubtitles}
                  className="text-xs border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 rounded-xl gap-1.5 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  导出字幕
                </Button>
                <a href={getExportUrl(taskId)} download>
                  <Button
                    size="sm"
                    className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded-xl gap-1.5 shadow-xs cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    下载视频
                  </Button>
                </a>
              </>
            )}

            {isError && (
              <Button
                size="sm"
                disabled={retrying}
                onClick={handleRetry}
                className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded-xl gap-1.5 shadow-xs cursor-pointer"
              >
                <RotateCcw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
                {retrying ? '重试启动中...' : '重新尝试'}
              </Button>
            )}
          </div>
        </div>

        {/* 抽屉主体容器 */}
        <div className="p-6 space-y-6 flex-grow">
          {loading && !status ? (
            <div className="py-24 flex flex-col items-center justify-center text-slate-400 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
              <p className="text-xs">加载任务实时日志与状态...</p>
            </div>
          ) : (
            <>
              {/* 任务概览卡片 */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-[0_2px_12px_rgba(0,0,0,0.03)] p-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-4 min-w-0">
                    <TaskDetailVideoThumbnail taskId={taskId || ''} alt={status?.filename} />

                    <div className="min-w-0">
                      <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 truncate max-w-lg mb-1">
                        {status?.filename ?? (status?.task_id ? `Task_${status.task_id.substring(0, 8)}.mp4` : '转译源视频.mp4')}
                      </h2>

                      <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 opacity-70" />
                          实时同步中
                        </span>
                        {status?.target_lang && (
                          <>
                            <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700" />
                            <span className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 font-medium">
                              <Languages className="w-3.5 h-3.5" />
                              目标: {LANG_LABELS[status.target_lang] ?? status.target_lang}
                            </span>
                          </>
                        )}
                        {status?.voice && (
                          <>
                            <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700" />
                            <span className="flex items-center gap-1 text-purple-600 dark:text-purple-400 font-medium">
                              <Mic className="w-3.5 h-3.5" />
                              音色: {status.voice}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 状态徽标 */}
                  <div className="shrink-0 self-start sm:self-center">
                    {isComplete && (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/80 shadow-2xs">
                        <CheckCircle2 className="w-4 h-4" />
                        🟢 已完成
                      </span>
                    )}

                    {isError && (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/80 shadow-2xs">
                        <XCircle className="w-4 h-4" />
                        🔴 翻译失败
                      </span>
                    )}

                    {!isComplete && !isError && (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-900/80 shadow-2xs">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        🔵 翻译中 ({status?.progress ?? 0}%)
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* 核心区域一：可视化步骤条 */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-[0_2px_12px_rgba(0,0,0,0.03)] p-6">
                <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-indigo-500" />
                  宏观转译流程进度 (Pipeline Stepper)
                </h3>

                <div className="relative flex items-center justify-between w-full">
                  {PIPELINE_STEPS.map((step, idx) => {
                    const isStepDone = isComplete || idx < activeStepIndex
                    const isStepActive = !isComplete && !isError && idx === activeStepIndex
                    const isStepFailed = isError && idx === activeStepIndex

                    return (
                      <div key={step.id} className="relative flex-1 flex flex-col items-center group">
                        {/* 连接线 */}
                        {idx < PIPELINE_STEPS.length - 1 && (
                          <div className="absolute top-4 left-1/2 w-full h-0.5 bg-slate-200 dark:bg-slate-800 z-0">
                            <div
                              className={`h-full transition-all duration-500 ${
                                idx < activeStepIndex || isComplete
                                  ? 'bg-indigo-600 dark:bg-indigo-500'
                                  : isStepActive
                                  ? 'bg-gradient-to-r from-indigo-600 to-slate-200 animate-pulse'
                                  : 'w-0'
                              }`}
                              style={{
                                width: idx < activeStepIndex || isComplete ? '100%' : isStepActive ? '60%' : '0%',
                              }}
                            />
                          </div>
                        )}

                        {/* 步骤圆形图标 */}
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all z-10 ${
                            isStepDone
                              ? 'bg-emerald-600 text-white shadow-xs'
                              : isStepFailed
                              ? 'bg-rose-600 text-white shadow-xs'
                              : isStepActive
                              ? 'bg-indigo-600 text-white ring-4 ring-indigo-500/20 animate-pulse'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-slate-700'
                          }`}
                        >
                          {isStepDone ? (
                            <CheckCircle2 className="w-4 h-4" />
                          ) : isStepFailed ? (
                            <XCircle className="w-4 h-4" />
                          ) : isStepActive ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            idx + 1
                          )}
                        </div>

                        {/* 步骤标题标签 */}
                        <span
                          className={`text-xs mt-3 font-medium transition-colors text-center ${
                            isStepDone
                              ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                              : isStepFailed
                              ? 'text-rose-600 dark:text-rose-400 font-semibold'
                              : isStepActive
                              ? 'text-indigo-600 dark:text-indigo-400 font-bold'
                              : 'text-slate-400 dark:text-slate-500'
                          }`}
                        >
                          {step.label}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* 核心区域二：实时日志控制台 */}
              <div className="bg-slate-950 dark:bg-slate-900 rounded-2xl border border-slate-800 shadow-xl overflow-hidden flex flex-col">
                {/* 控制台标题栏 */}
                <div className="bg-slate-900/90 dark:bg-slate-850 px-4 py-3 border-b border-slate-800 flex items-center justify-between select-none">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-rose-500/80" />
                      <div className="w-3 h-3 rounded-full bg-amber-500/80" />
                      <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-400 font-mono pl-2 border-l border-slate-800">
                      <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                      <span>shiyibao-runtime.log</span>
                    </div>
                  </div>

                  {/* 终端控制项 */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setAutoScroll((prev) => !prev)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
                        autoScroll
                          ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                      title="新日志到达时自动滚动到底部"
                    >
                      <ArrowDownCircle className={`w-3.5 h-3.5 ${autoScroll ? 'text-indigo-400' : ''}`} />
                      自动滚动
                    </button>

                    <button
                      onClick={handleCopyLogs}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors flex items-center gap-1.5 cursor-pointer"
                      title="一键复制日志发给客服或开发排查"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? '已复制' : '复制日志'}
                    </button>

                    <button
                      onClick={fetchDetail}
                      className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
                      title="刷新数据"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* 控制台日志窗口 */}
                <div
                  ref={logConsoleRef}
                  className="h-84 overflow-y-auto p-4 sm:p-5 font-mono text-xs space-y-2 select-text bg-slate-950 scrollbar-thin scrollbar-thumb-slate-800"
                >
                  {logs.length === 0 ? (
                    <div className="text-slate-600 py-10 text-center font-mono">
                      [WAITING] 正在建立与云端转译控制台的 WebSocket 连接...
                    </div>
                  ) : (
                    logs.map((log, index) => {
                      const isErr = log.type === 'error'
                      const isSuccess = log.type === 'success'
                      const isApi = log.type === 'api'

                      return (
                        <div
                          key={index}
                          className={`flex items-start gap-2.5 leading-relaxed break-words rounded-md p-1 transition-colors ${
                            isErr
                              ? 'bg-rose-950/50 text-rose-300 border border-rose-900/60'
                              : isSuccess
                              ? 'text-emerald-400'
                              : isApi
                              ? 'text-sky-400'
                              : 'text-slate-400'
                          }`}
                        >
                          <span className="text-slate-600 shrink-0 select-none">
                            [{log.timestamp}]
                          </span>
                          <span
                            className={`px-1.5 py-0.2 rounded text-[10px] font-semibold uppercase tracking-wider shrink-0 ${
                              isErr
                                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                : isSuccess
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : isApi
                                ? 'bg-sky-500/20 text-sky-400'
                                : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {log.tag}
                          </span>
                          <span className="flex-grow">{log.message}</span>
                        </div>
                      )
                    })
                  )}
                </div>

                {/* 终端底部状态栏 */}
                <div className="bg-slate-900/60 px-4 py-2 border-t border-slate-800 text-[11px] font-mono text-slate-500 flex items-center justify-between select-none">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span>Live Monitoring • Total {logs.length} Log Entries</span>
                  </div>
                  {isError && (
                    <span className="text-rose-400 flex items-center gap-1 font-sans text-xs">
                      <AlertCircle className="w-3.5 h-3.5" />
                      检测到异常终端记录，可一键复制推送到技术支持
                    </span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
