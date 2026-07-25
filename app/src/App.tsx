import { useState, useCallback, useEffect } from 'react'
import { Routes, Route, useNavigate, useParams, Navigate } from 'react-router-dom'
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react'
import { useTheme } from './hooks/useTheme'
import { GithubIcon } from './components/GithubIcon'
import { ChangelogModal } from './components/ChangelogModal'
import Navbar from './components/Navbar'
import UploadState from './components/UploadState'
import ProcessingState from './components/ProcessingState'
import ResultState from './components/ResultState'
import BatchState from './components/BatchState'
import HistoryView from './components/HistoryView'
import VoiceLibrary from './components/VoiceLibrary'
import PerformancePage from './components/PerformancePage'
import { getRuntimeHealth, getTaskStatus, type RuntimeHealth, type TaskStatus } from './lib/api'
import { clearActiveTaskId, loadActiveTaskId, saveActiveTaskId } from './lib/task-session'

function TaskPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const navigate = useNavigate()
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [stage, setStage] = useState<'processing' | 'result'>('processing')

  useEffect(() => {
    if (!taskId) {
      navigate('/', { replace: true })
      return
    }

    setLoading(true)
    getTaskStatus(taskId)
      .then((st) => {
        setStatus(st)
        if (st.stage === 'complete') {
          setStage('result')
          clearActiveTaskId()
        } else {
          setStage('processing')
          saveActiveTaskId(taskId)
        }
      })
      .catch(() => {
        clearActiveTaskId()
        navigate('/', { replace: true })
      })
      .finally(() => {
        setLoading(false)
      })
  }, [taskId, navigate])

  if (loading) {
    return (
      <div className="flex-grow flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        <p className="text-sm">正在载入任务状态...</p>
      </div>
    )
  }

  if (!taskId || !status) {
    return null
  }

  if (stage === 'result') {
    return (
      <ResultState
        taskId={taskId}
        onReset={() => {
          clearActiveTaskId()
          navigate('/')
        }}
      />
    )
  }

  return (
    <ProcessingState
      taskId={taskId}
      onComplete={() => {
        clearActiveTaskId()
        setStage('result')
      }}
      onNavigateToHistory={() => navigate('/history')}
    />
  )
}

function HomePage() {
  const navigate = useNavigate()

  const handleUploadComplete = useCallback((id: string) => {
    saveActiveTaskId(id)
    navigate(`/task/${id}`)
  }, [navigate])

  return <UploadState onUploadComplete={handleUploadComplete} />
}

export default function App() {
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()
  const [activeProcessingTaskId, setActiveProcessingTaskId] = useState<string | null>(null)
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null)

  useEffect(() => {
    getRuntimeHealth()
      .then(setRuntimeHealth)
      .catch(() => setRuntimeHealth(null))
  }, [])

  // 持续同步后台处理中任务的状态，供导航栏状态徽章展示
  useEffect(() => {
    const checkActiveTaskStatus = async () => {
      const savedId = loadActiveTaskId()
      if (!savedId) {
        setActiveProcessingTaskId(null)
        return
      }

      try {
        const st = await getTaskStatus(savedId)
        if (st.stage === 'complete' || st.stage === 'error') {
          clearActiveTaskId()
          setActiveProcessingTaskId(null)
        } else {
          setActiveProcessingTaskId(savedId)
        }
      } catch {
        clearActiveTaskId()
        setActiveProcessingTaskId(null)
      }
    }

    void checkActiveTaskStatus()
    const timer = setInterval(checkActiveTaskStatus, 2500)
    return () => clearInterval(timer)
  }, [])

  const handleOpenTask = useCallback((id: string) => {
    saveActiveTaskId(id)
    getTaskStatus(id)
      .then((st) => {
        if (st.stage !== 'complete' && st.stage !== 'error') {
          setActiveProcessingTaskId(id)
        } else {
          clearActiveTaskId()
          setActiveProcessingTaskId(null)
        }
      })
      .catch(() => {
        clearActiveTaskId()
        setActiveProcessingTaskId(null)
      })
    navigate(`/task/${id}`)
  }, [navigate])

  const handleHistoryTaskDeleted = useCallback((id: string) => {
    const active = loadActiveTaskId()
    if (id === active) {
      clearActiveTaskId()
      setActiveProcessingTaskId(null)
      navigate('/')
    }
  }, [navigate])

  return (
    <div className="relative flex flex-col bg-background w-full min-h-screen">
      <Navbar
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenCompletedTask={handleOpenTask}
        activeProcessingTaskId={activeProcessingTaskId}
        onOpenProcessingTask={() => {
          if (activeProcessingTaskId) handleOpenTask(activeProcessingTaskId)
        }}
      />

      {runtimeHealth && !runtimeHealth.ffmpeg.available && (
        <div className="relative z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-300/70 bg-amber-50 px-4 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-100">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            未检测到 FFmpeg，视频转译暂不可用。{runtimeHealth.ffmpeg.install_hint}
          </span>
          <a
            href={runtimeHealth.ffmpeg.download_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
          >
            下载 FFmpeg
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      <main className="flex-grow flex flex-col relative animate-fade-in-up">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {/* 极简企业级柔和背景光晕 */}
          <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-slate-300/10 dark:bg-slate-800/15 blur-[160px] rounded-full" />
          <div className="absolute bottom-[-15%] right-[-10%] w-[45%] h-[45%] bg-slate-400/10 dark:bg-slate-700/10 blur-[150px] rounded-full" />
        </div>

        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/batch" element={<BatchState />} />
          <Route path="/task/:taskId" element={<TaskPage />} />
          <Route
            path="/history"
            element={
              <HistoryView
                onOpenTask={handleOpenTask}
                onTaskDeleted={handleHistoryTaskDeleted}
              />
            }
          />
          <Route path="/voices" element={<VoiceLibrary />} />
          <Route path="/performance" element={<PerformancePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="w-full border-t border-border/40 py-3 px-6 text-xs text-muted-foreground glass-panel">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
            <span>视译宝 - 本地视频转译与智能字幕配音系统</span>
            <ChangelogModal />
          </div>
          <a
            href="https://github.com/deijing/shiyibao"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 transition-colors font-medium cursor-pointer"
          >
            <GithubIcon className="w-4 h-4" />
            <span>GitHub 开源仓库 (deijing/shiyibao)</span>
            <ExternalLink className="w-3 h-3 opacity-60" />
          </a>
        </div>
      </footer>
    </div>
  )
}
