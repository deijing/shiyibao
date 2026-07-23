import { useState, useCallback, useEffect } from 'react'
import { useTheme } from './hooks/useTheme'
import Navbar, { type Page } from './components/Navbar'
import UploadState from './components/UploadState'
import ProcessingState from './components/ProcessingState'
import ResultState from './components/ResultState'
import HistoryView from './components/HistoryView'
import VoiceLibrary from './components/VoiceLibrary'
import PerformancePage from './components/PerformancePage'
import { getTaskStatus } from './lib/api'
import { clearActiveTaskId, loadActiveTaskId, saveActiveTaskId } from './lib/task-session'

type FlowState = 'upload' | 'processing' | 'result'

export default function App() {
  const [page, setPage] = useState<Page>('home')
  const [currentState, setCurrentState] = useState<FlowState>('upload')
  const [transitioning, setTransitioning] = useState(false)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [restoringTask, setRestoringTask] = useState(true)
  const { theme, toggleTheme } = useTheme()

  useEffect(() => {
    const savedTaskId = loadActiveTaskId()
    if (!savedTaskId) {
      setRestoringTask(false)
      return
    }

    getTaskStatus(savedTaskId)
      .then((status) => {
        setTaskId(savedTaskId)
        setCurrentState(status.stage === 'complete' ? 'result' : 'processing')
      })
      .catch(() => {
        clearActiveTaskId()
      })
      .finally(() => {
        setRestoringTask(false)
      })
  }, [])

  const switchState = useCallback((next: FlowState) => {
    setTransitioning(true)
    setTimeout(() => {
      setCurrentState(next)
      setTransitioning(false)
    }, 800)
  }, [])

  const handleUploadComplete = useCallback((id: string) => {
    saveActiveTaskId(id)
    setTaskId(id)
    switchState('processing')
  }, [switchState])

  const handleProcessingComplete = useCallback(() => {
    switchState('result')
  }, [switchState])

  const handleReset = useCallback(() => {
    clearActiveTaskId()
    setTaskId(null)
    switchState('upload')
  }, [switchState])

  const handleOpenHistoryTask = useCallback((id: string, stage: string) => {
    saveActiveTaskId(id)
    setTaskId(id)
    setCurrentState(stage === 'complete' ? 'result' : 'processing')
    setPage('home')
  }, [])

  const handleHistoryTaskDeleted = useCallback((id: string) => {
    if (id !== taskId) return
    clearActiveTaskId()
    setTaskId(null)
    setCurrentState('upload')
  }, [taskId])

  const handleNavigate = useCallback((p: Page) => {
    setPage(p)
    if (p === 'home' && currentState === 'result' && !taskId) {
      setCurrentState('upload')
    }
  }, [currentState, taskId])

  return (
    <div className="relative flex flex-col bg-background w-full min-h-screen">
      <Navbar
        theme={theme}
        onToggleTheme={toggleTheme}
        activePage={page}
        onNavigate={handleNavigate}
        onOpenCompletedTask={(id) => handleOpenHistoryTask(id, 'complete')}
      />

      <main className="flex-grow flex flex-col relative">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {/* 极简企业级柔和背景光晕 */}
          <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-slate-300/10 dark:bg-slate-800/15 blur-[160px] rounded-full" />
          <div className="absolute bottom-[-15%] right-[-10%] w-[45%] h-[45%] bg-slate-400/10 dark:bg-slate-700/10 blur-[150px] rounded-full" />
        </div>

        {page === 'home' && restoringTask && (
          <div className="flex-grow flex items-center justify-center text-muted-foreground">
            正在恢复上次任务...
          </div>
        )}

        {page === 'home' && !restoringTask && (
          <div
            className={`flex-grow flex flex-col transition-all duration-800 ease-in-out ${
              transitioning ? 'opacity-0 -translate-y-5' : 'opacity-100 translate-y-0'
            }`}
          >
            {currentState === 'upload' && (
              <UploadState onUploadComplete={handleUploadComplete} />
            )}
            {currentState === 'processing' && taskId && (
              <ProcessingState taskId={taskId} onComplete={handleProcessingComplete} />
            )}
            {currentState === 'result' && taskId && (
              <ResultState taskId={taskId} onReset={handleReset} />
            )}
          </div>
        )}

        {page === 'history' && (
          <HistoryView
            onOpenTask={handleOpenHistoryTask}
            onTaskDeleted={handleHistoryTaskDeleted}
          />
        )}
        {page === 'voices' && <VoiceLibrary />}
        {page === 'performance' && <PerformancePage />}
      </main>
    </div>
  )
}
