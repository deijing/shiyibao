import { useCallback, useEffect, useState } from 'react'
import {
  Clock, FileVideo, CheckCircle2, XCircle, Loader2,
  ArrowRight, Inbox, RefreshCw, RotateCcw, Trash2,
  HelpCircle, Languages, Mic, Filter, KeyRound,
  AlertCircle, Terminal
} from 'lucide-react'
import { getTaskList, deleteTask, startTask, type TaskListItem } from '@/lib/api'
import { loadSettings, saveSettings } from './SettingsPanel'
import TaskDetailDrawer from './TaskDetailDrawer'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const LANG_LABELS: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
}

const STAGE_CONFIG: Record<string, { label: string; color: string; bg: string; border: string; icon: typeof CheckCircle2 }> = {
  complete: { label: '已完成', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950/40', border: 'border-emerald-200 dark:border-emerald-900/60', icon: CheckCircle2 },
  error:    { label: '翻译失败', color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-950/40', border: 'border-rose-200 dark:border-rose-900/60', icon: XCircle },
  pending:  { label: '等待中',   color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950/40', border: 'border-amber-200 dark:border-amber-900/60', icon: Clock },
}

function formatTaskTime(dateStr?: string): string {
  if (!dateStr) return '刚刚'
  const timeMs = new Date(dateStr).getTime()
  if (isNaN(timeMs)) return '刚刚'

  const seconds = Math.floor((Date.now() - timeMs) / 1000)
  if (seconds < 30) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`

  return new Date(dateStr).toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function humanizeErrorMessage(rawError?: string | null): { friendlyMsg: string; rawError: string | null } {
  if (!rawError || !rawError.trim()) {
    return { friendlyMsg: '翻译任务异常中止，请点击重试', rawError: null }
  }

  const err = rawError.trim()

  if (err.includes('429') || err.includes('Too Many Requests') || err.includes('RESOURCE_EXHAUSTED')) {
    return {
      friendlyMsg: '翻译失败，服务器当前请求人数过多（触发 API 速率限制），请稍后重试',
      rawError: err,
    }
  }

  if (
    err.includes('401') ||
    err.includes('403') ||
    err.includes('Unauthorized') ||
    err.includes('API_KEY_INVALID') ||
    err.includes('API key not valid')
  ) {
    return {
      friendlyMsg: '翻译失败，Gemini API Key 无效或超限，请检查设置中的密钥',
      rawError: err,
    }
  }

  if (
    err.includes('500') ||
    err.includes('502') ||
    err.includes('503') ||
    err.includes('504') ||
    err.includes('Internal Server Error')
  ) {
    return {
      friendlyMsg: '翻译失败，AI 云端服务响应超时或服务器异常，请稍后重试',
      rawError: err,
    }
  }

  if (err.toLowerCase().includes('audio') || err.includes('extract_audio') || err.includes('ffmpeg')) {
    return {
      friendlyMsg: '视频音频提取失败，请检查视频源文件格式或音轨',
      rawError: err,
    }
  }

  if (err.toLowerCase().includes('transcribe') || err.includes('asr')) {
    return {
      friendlyMsg: '语音识别失败，视频中未检测到清晰说话声',
      rawError: err,
    }
  }

  if (err.toLowerCase().includes('synthesize') || err.includes('tts')) {
    return {
      friendlyMsg: '语音合成失败，音色引擎连接异常',
      rawError: err,
    }
  }

  if (/[\u4e00-\u9fa5]/.test(err) && !err.includes('Client error') && !err.includes('http')) {
    return {
      friendlyMsg: err,
      rawError: null,
    }
  }

  return {
    friendlyMsg: '翻译处理未完成，遇底层服务交互异常',
    rawError: err,
  }
}

function getStageConfig(stage: string) {
  if (stage === 'complete' || stage === 'error' || stage === 'pending') {
    return STAGE_CONFIG[stage]
  }
  return {
    label: '处理中',
    color: 'text-indigo-600 dark:text-indigo-400',
    bg: 'bg-indigo-50 dark:bg-indigo-950/40',
    border: 'border-indigo-200 dark:border-indigo-900/60',
    icon: Loader2,
  }
}

type FilterType = 'all' | 'complete' | 'processing' | 'error'

interface HistoryViewProps {
  onOpenTask: (taskId: string, stage: string) => void
  onTaskDeleted: (taskId: string) => void
}

export default function HistoryView({ onOpenTask, onTaskDeleted }: HistoryViewProps) {
  const [tasks, setTasks] = useState<TaskListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterType>('all')
  const [hoveredRawErrorId, setHoveredRawErrorId] = useState<string | null>(null)
  const [detailDrawerTaskId, setDetailDrawerTaskId] = useState<string | null>(null)

  // Action States
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null)
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null)
  const [taskToDelete, setTaskToDelete] = useState<TaskListItem | null>(null)

  // API Key Prompt Dialog for Retry
  const [showKeyDialog, setShowKeyDialog] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [pendingRetryTask, setPendingRetryTask] = useState<TaskListItem | null>(null)

  const loadTasks = useCallback((showLoading = true) => {
    if (showLoading) setLoading(true)
    getTaskList()
      .then((nextTasks) => {
        setTasks(nextTasks)
        setLoadError(null)
      })
      .catch(() => setLoadError('历史项目加载失败，请检查服务连接后重试'))
      .finally(() => {
        if (showLoading) setLoading(false)
      })
  }, [])

  useEffect(() => {
    loadTasks()
    const timer = window.setInterval(() => loadTasks(false), 3000)
    return () => window.clearInterval(timer)
  }, [loadTasks])

  const executeRetry = async (task: TaskListItem, apiKey: string) => {
    setRetryingTaskId(task.task_id)
    try {
      const settings = loadSettings()
      await startTask(task.task_id, {
        gemini_api_key: apiKey,
        mimo_api_key: settings.xiaomiTtsKey,
        gemini_model: settings.geminiModel || 'gemini-2.0-flash',
        voice: task.voice || settings.mimoVoice || '冰糖',
        target_lang: task.target_lang || settings.targetLang || 'zh',
      })
      // Local optimistic update
      setTasks((prev) =>
        prev.map((t) =>
          t.task_id === task.task_id
            ? { ...t, stage: 'pending', progress: 0, error: null, message: '重新启动中' }
            : t
        )
      )
      onOpenTask(task.task_id, 'pending')
    } catch (err) {
      alert(`重试失败: ${err instanceof Error ? err.message : '请检查网络配置'}`)
    } finally {
      setRetryingTaskId(null)
    }
  }

  const handleRetryClick = (task: TaskListItem, e: React.MouseEvent) => {
    e.stopPropagation()
    const settings = loadSettings()
    if (!settings.geminiApiKey) {
      setPendingRetryTask(task)
      setKeyInput('')
      setShowKeyDialog(true)
    } else {
      executeRetry(task, settings.geminiApiKey)
    }
  }

  const handleSaveKeyAndRetry = () => {
    if (!keyInput.trim()) return
    const settings = loadSettings()
    settings.geminiApiKey = keyInput.trim()
    saveSettings(settings)

    setShowKeyDialog(false)
    if (pendingRetryTask) {
      executeRetry(pendingRetryTask, keyInput.trim())
      setPendingRetryTask(null)
    }
  }

  const confirmDelete = async () => {
    if (!taskToDelete) return
    const id = taskToDelete.task_id
    setDeletingTaskId(id)
    try {
      await deleteTask(id)
      setTasks((prev) => prev.filter((t) => t.task_id !== id))
      onTaskDeleted(id)
      setTaskToDelete(null)
    } catch (err) {
      alert(`删除任务失败: ${err instanceof Error ? err.message : '请重试'}`)
    } finally {
      setDeletingTaskId(null)
    }
  }

  // Filter tasks
  const filteredTasks = tasks.filter((t) => {
    if (filter === 'complete') return t.stage === 'complete'
    if (filter === 'error') return t.stage === 'error'
    if (filter === 'processing') return !['complete', 'error', 'pending'].includes(t.stage) || t.stage === 'pending'
    return true
  })

  const counts = {
    all: tasks.length,
    complete: tasks.filter((t) => t.stage === 'complete').length,
    processing: tasks.filter((t) => !['complete', 'error'].includes(t.stage)).length,
    error: tasks.filter((t) => t.stage === 'error').length,
  }

  return (
    <div className="flex-grow flex flex-col w-full bg-slate-50/70 dark:bg-slate-950/50 py-8 px-4 sm:px-6">
      <div className="max-w-5xl mx-auto w-full flex flex-col flex-grow">
        {/* Header Section */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-7">
          <div>
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 dark:bg-indigo-500/20 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shadow-xs">
                <Clock className="w-7 h-7" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">
                  历史转译记录
                </h1>
                <p className="text-sm sm:text-base text-slate-500 dark:text-slate-400 mt-1">
                  记录与管理所有视频 AI 翻译任务
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => loadTasks()}
              className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-xs hover:shadow-sm rounded-xl px-3.5 py-2 cursor-pointer transition-all"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-indigo-600' : ''}`} />
              刷新列表
            </Button>
          </div>
        </div>

        {/* Filter Navigation Tabs */}
        <div className="grid grid-cols-4 gap-1.5 p-1.5 bg-slate-200/60 dark:bg-slate-900/80 rounded-2xl mb-6 w-full max-w-2xl border border-slate-200/80 dark:border-slate-800/80">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap transition-all cursor-pointer ${
                filter === 'all'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              全部 ({counts.all})
            </button>
            <button
              onClick={() => setFilter('processing')}
              className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap transition-all cursor-pointer ${
                filter === 'processing'
                  ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              进行中 ({counts.processing})
            </button>
            <button
              onClick={() => setFilter('complete')}
              className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap transition-all cursor-pointer ${
                filter === 'complete'
                  ? 'bg-white dark:bg-slate-800 text-emerald-600 dark:text-emerald-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              已完成 ({counts.complete})
            </button>
            <button
              onClick={() => setFilter('error')}
              className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap transition-all cursor-pointer ${
                filter === 'error'
                  ? 'bg-white dark:bg-slate-800 text-rose-600 dark:text-rose-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              失败 ({counts.error})
            </button>
        </div>

        {loadError && (
          <div className="mb-6 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/90 dark:bg-rose-950/40 p-4 text-xs sm:text-sm text-rose-600 dark:text-rose-400 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p>{loadError}</p>
          </div>
        )}

        {/* Task Cards Area */}
        {loading && tasks.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-500 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
            <p className="text-sm">正在加载历史任务...</p>
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-500 gap-3 bg-white dark:bg-slate-900/80 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs p-8 text-center">
            <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/50 flex items-center justify-center text-indigo-500 mb-2">
              <Inbox className="w-8 h-8 opacity-70" />
            </div>
            <p className="text-lg font-semibold text-slate-700 dark:text-slate-300">暂无翻译记录</p>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-sm">
              在首页上传 MP4 视频，选择目标语言与音色，即可体验全自动 AI 语义重构与原声音色合成。
            </p>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center py-16 text-slate-400 dark:text-slate-500 gap-2 bg-white dark:bg-slate-900/60 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-6 text-center">
            <Filter className="w-8 h-8 opacity-40 mb-1" />
            <p className="text-sm font-medium">未找到符合当前筛选条件的任务</p>
            <Button variant="ghost" size="sm" onClick={() => setFilter('all')} className="text-xs text-indigo-600 cursor-pointer">
              查看全部任务 ({counts.all})
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredTasks.map((task) => {
              const cfg = getStageConfig(task.stage)
              const StatusIcon = cfg.icon
              const isComplete = task.stage === 'complete'
              const isError = task.stage === 'error'
              const isProcessing = !['complete', 'error'].includes(task.stage)
              const isRetryingThis = retryingTaskId === task.task_id

              const { friendlyMsg, rawError } = isError ? humanizeErrorMessage(task.error) : { friendlyMsg: '', rawError: null }
              const timeDisplay = formatTaskTime(task.created_at)

              return (
                <div
                  key={task.task_id}
                  className={`group bg-white dark:bg-slate-900/90 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-[0_2px_12px_rgba(0,0,0,0.03)] hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-all duration-200 p-4 sm:p-5 relative ${
                    isComplete ? 'hover:border-indigo-500/40 dark:hover:border-indigo-500/40' : ''
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    {/* Left Section: Video Info & Metadata */}
                    <div className="flex items-start gap-3.5 min-w-0 flex-grow">
                      <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/60 dark:to-purple-950/60 border border-indigo-100 dark:border-indigo-900/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0 shadow-2xs group-hover:scale-105 transition-transform mt-0.5">
                        <FileVideo className="w-5 h-5 sm:w-6 sm:h-6" />
                      </div>

                      <div className="flex-grow min-w-0">
                        {/* Title & Status Badge Header */}
                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                          <h3
                            onClick={() => !isError && onOpenTask(task.task_id, task.stage)}
                            className={`font-semibold text-slate-900 dark:text-slate-100 text-sm sm:text-base leading-snug truncate max-w-md ${
                              !isError ? 'cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors' : ''
                            }`}
                            title={task.filename}
                          >
                            {task.filename}
                          </h3>

                          <span className={`inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full font-medium shrink-0 border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
                            <StatusIcon className={`w-3.5 h-3.5 ${isProcessing ? 'animate-spin' : ''}`} />
                            {cfg.label}
                          </span>
                        </div>

                        {/* Metadata Tags */}
                        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
                          <span className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
                            <Clock className="w-3 h-3 opacity-70" />
                            {timeDisplay}
                          </span>

                          {task.target_lang && (
                            <>
                              <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700" />
                              <span className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 font-medium bg-indigo-50/60 dark:bg-indigo-950/30 px-2 py-0.5 rounded-md border border-indigo-100/60 dark:border-indigo-900/40">
                                <Languages className="w-3 h-3" />
                                目标: {LANG_LABELS[task.target_lang] ?? task.target_lang}
                              </span>
                            </>
                          )}

                          {task.voice && (
                            <>
                              <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700" />
                              <span className="flex items-center gap-1 text-purple-600 dark:text-purple-400 bg-purple-50/60 dark:bg-purple-950/30 px-2 py-0.5 rounded-md border border-purple-100/60 dark:border-purple-900/40">
                                <Mic className="w-3 h-3" />
                                音色: {task.voice}
                              </span>
                            </>
                          )}
                        </div>

                        {/* Humanized Error Explanation Box */}
                        {isError && (
                          <div className="mt-2.5 rounded-xl bg-rose-50/90 dark:bg-rose-950/40 border border-rose-200/80 dark:border-rose-900/60 p-2.5 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2 max-w-xl">
                            <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                            <div className="flex-grow min-w-0">
                              <p className="font-medium leading-relaxed">{friendlyMsg}</p>
                            </div>

                            {/* Technical Details Popover / Tooltip Icon */}
                            {rawError && (
                              <div className="relative shrink-0">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setHoveredRawErrorId(hoveredRawErrorId === task.task_id ? null : task.task_id)
                                  }}
                                  onMouseEnter={() => setHoveredRawErrorId(task.task_id)}
                                  onMouseLeave={() => setHoveredRawErrorId(null)}
                                  className="text-rose-400 hover:text-rose-600 dark:hover:text-rose-200 cursor-pointer p-0.5 transition-colors"
                                  title="点击/悬停查看接口技术细节"
                                >
                                  <HelpCircle className="w-4 h-4" />
                                </button>

                                {hoveredRawErrorId === task.task_id && (
                                  <div className="absolute right-0 bottom-full mb-2 w-72 sm:w-96 p-3 bg-slate-900 text-slate-100 rounded-xl shadow-xl border border-slate-800 text-[11px] font-mono leading-relaxed z-50 break-words">
                                    <div className="text-indigo-400 font-sans text-xs font-semibold mb-1 border-b border-slate-800 pb-1 flex items-center justify-between">
                                      <span>开发者技术异常代码</span>
                                      <span className="text-[10px] text-slate-400 font-normal">Technical Detail</span>
                                    </div>
                                    <div className="max-h-36 overflow-y-auto text-slate-300 select-all">
                                      {rawError}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Processing Status & Message */}
                        {isProcessing && (
                          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping shrink-0" />
                            <span>{task.message || 'AI 语义重构中...'} ({task.progress}%)</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right Section: Progress & Action Buttons */}
                    <div className="flex items-center gap-3 shrink-0 self-end md:self-center pt-2 md:pt-0 border-t md:border-t-0 border-slate-100 dark:border-slate-800 w-full md:w-auto justify-end">
                      {isProcessing && (
                        <div className="w-24 sm:w-28 mr-2 hidden sm:block">
                          <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden border border-slate-200/50 dark:border-slate-700/50">
                            <div
                              className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-500"
                              style={{ width: `${task.progress}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Action Closed Loop Buttons */}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDetailDrawerTaskId(task.task_id)
                        }}
                        className="border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 text-xs font-medium px-3 py-1.5 rounded-xl cursor-pointer flex items-center gap-1.5 transition-all"
                      >
                        <Terminal className="w-3.5 h-3.5 text-indigo-500" />
                        详情/日志
                      </Button>

                      {isComplete && (
                        <Button
                          size="sm"
                          onClick={() => onOpenTask(task.task_id, task.stage)}
                          className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs hover:shadow-indigo-500/20 text-xs font-medium px-3.5 py-1.5 rounded-xl cursor-pointer flex items-center gap-1.5 transition-all"
                        >
                          查看结果
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Button>
                      )}

                      {isProcessing && (
                        <Button
                          size="sm"
                          onClick={() => onOpenTask(task.task_id, task.stage)}
                          className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs hover:shadow-indigo-500/20 text-xs font-medium px-3.5 py-1.5 rounded-xl cursor-pointer flex items-center gap-1.5 transition-all"
                        >
                          查看进度
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Button>
                      )}

                      {isError && (
                        <Button
                          size="sm"
                          disabled={isRetryingThis}
                          onClick={(e) => handleRetryClick(task, e)}
                          className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs hover:shadow-indigo-500/20 text-xs font-medium px-3.5 py-1.5 rounded-xl cursor-pointer flex items-center gap-1.5 transition-all"
                        >
                          <RotateCcw className={`w-3.5 h-3.5 ${isRetryingThis ? 'animate-spin' : ''}`} />
                          {isRetryingThis ? '重试中...' : '重新尝试'}
                        </Button>
                      )}

                      {/* Delete Button */}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation()
                          setTaskToDelete(task)
                        }}
                        className="text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 h-8 w-8 rounded-lg cursor-pointer transition-colors"
                        title="删除该条记录"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <Dialog open={!!taskToDelete} onOpenChange={(open) => !open && setTaskToDelete(null)}>
        <DialogContent className="max-w-md bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900 dark:text-slate-100 text-lg">
              <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
              确认删除该转译任务？
            </DialogTitle>
            <DialogDescription className="text-slate-500 dark:text-slate-400 text-xs sm:text-sm mt-1">
              任务文件“<span className="font-semibold text-slate-700 dark:text-slate-300">{taskToDelete?.filename}</span>”及其生成的音视频数据将被永久物理移除，不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6 flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => setTaskToDelete(null)}
              className="text-xs cursor-pointer rounded-xl border-slate-200 dark:border-slate-800"
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={!!deletingTaskId}
              onClick={confirmDelete}
              className="text-xs cursor-pointer rounded-xl bg-rose-600 hover:bg-rose-700 text-white"
            >
              {deletingTaskId ? '正在删除...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* API Key Modal Prompt for Retry */}
      <Dialog open={showKeyDialog} onOpenChange={setShowKeyDialog}>
        <DialogContent className="max-w-md bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900 dark:text-slate-100 text-lg">
              <KeyRound className="w-5 h-5 text-indigo-500 shrink-0" />
              需要 Gemini API Key 以发起重试
            </DialogTitle>
            <DialogDescription className="text-slate-500 dark:text-slate-400 text-xs sm:text-sm mt-1">
              重新提交转译任务需要有效的 Gemini API 密钥。请输入您的密钥：
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <Label htmlFor="retry-key-input" className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Gemini API Key
            </Label>
            <Input
              id="retry-key-input"
              type="password"
              placeholder="AIzaSy..."
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className="bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 rounded-xl text-xs"
            />
          </div>

          <DialogFooter className="mt-4 flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => setShowKeyDialog(false)}
              className="text-xs cursor-pointer rounded-xl border-slate-200 dark:border-slate-800"
            >
              取消
            </Button>
            <Button
              disabled={!keyInput.trim()}
              onClick={handleSaveKeyAndRetry}
              className="text-xs cursor-pointer rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              保存并重试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task Detail & Live Log Console Drawer */}
      <TaskDetailDrawer
        taskId={detailDrawerTaskId}
        isOpen={!!detailDrawerTaskId}
        onClose={() => setDetailDrawerTaskId(null)}
        onRetrySuccess={() => loadTasks(false)}
      />
    </div>
  )
}
