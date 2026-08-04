import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Upload,
  AlertCircle,
  Trash2,
  FileVideo,
  Play,
  Download,
  ExternalLink,
  Layers,
  Check,
  RefreshCw,
  Loader2,
  FolderOpen,
  FolderOutput,
  Search,
  Sparkles,
} from 'lucide-react'
import {
  uploadVideo,
  startTask,
  getTaskStatus,
  fetchServerSettings,
  getExportUrl,
  scanDirectory,
  registerLocalTask,
  type TaskStatus,
  type ScannedVideoFile,
} from '@/lib/api'
import { saveActiveTaskId } from '@/lib/task-session'
import {
  loadSettings,
  saveSettings,
  mergeFillEmpty,
  getLanguageDisplayName,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
  type AppSettings,
} from './SettingsPanel'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export interface VideoQueueItem {
  id: string
  name: string
  sizeMb: number
  file?: File
  path?: string
}

export interface BatchItem {
  id: string
  fileItem: VideoQueueItem
  targetLang: string
  taskId?: string
  status: 'idle' | 'uploading' | 'processing' | 'complete' | 'error'
  progress: number
  stage: string
  message: string
  error?: string | null
}

function readEntryAsFile(entry: any): Promise<File[]> {
  return new Promise((resolve) => {
    entry.file(
      (file: File) => {
        if (file.type.startsWith('video/') || file.name.match(/\.(mp4|mov|mkv|avi|flv|webm)$/i)) {
          resolve([file])
        } else {
          resolve([])
        }
      },
      () => resolve([])
    )
  })
}

async function extractVideosFromEntry(entry: any): Promise<File[]> {
  if (!entry) return []
  if (entry.isFile) return readEntryAsFile(entry)
  if (entry.isDirectory) {
    const dirReader = entry.createReader()
    // readEntries 每次仅返回部分条目（Chrome 约 100 个）；循环直至为空。
    const readBatch = () =>
      new Promise<any[]>((res) => dirReader.readEntries((entries: any[]) => res(entries), () => res([])))
    const children: any[] = []
    let batch = await readBatch()
    while (batch.length > 0) {
      children.push(...batch)
      batch = await readBatch()
    }
    const fileArrays = await Promise.all(children.map((child) => extractVideosFromEntry(child)))
    return fileArrays.flat()
  }
  return []
}

const BATCH_STORAGE_KEY = 'shiyibao-batch-items'
const isDesktopApp = typeof window !== 'undefined' && Boolean(window.__SHIYIBAO_DESKTOP__)

function isAbsolutePath(value: string): boolean {
  const path = value.trim()
  if (!path) return false
  // POSIX / Windows 盘符 / UNC
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

export default function BatchState() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [videoQueue, setVideoQueue] = useState<VideoQueueItem[]>([])
  const [selectedTargetLangs, setSelectedTargetLangs] = useState<string[]>(['zh', 'en'])
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)

  // 目录扫描状态
  const [inputDir, setInputDir] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [isScanning, setIsScanning] = useState(false)
  const canAutoArchive = isDesktopApp && isAbsolutePath(outputDir)

  const [batchItems, setBatchItems] = useState<BatchItem[]>([])
  const [isBatchRunning, setIsBatchRunning] = useState(false)

  // 文件与文件夹选择器引用
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputFolderPickerRef = useRef<HTMLInputElement>(null)
  const outputFolderPickerRef = useRef<HTMLInputElement>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    function syncSettings() {
      setSettings(loadSettings())
    }
    window.addEventListener('settings-updated', syncSettings)
    window.addEventListener('storage', syncSettings)
    fetchServerSettings().then((serverData) => {
      if (serverData && (serverData.geminiApiKey || serverData.xiaomiTtsKey)) {
        setSettings((prev) => {
          const merged = mergeFillEmpty(prev, serverData)
          localStorage.setItem('shiyibao-settings', JSON.stringify(merged))
          return merged
        })
      }
    })
    return () => {
      window.removeEventListener('settings-updated', syncSettings)
      window.removeEventListener('storage', syncSettings)
    }
  }, [])

  // 离开后返回时重新连接进行中的批处理。任务矩阵会持久化（不包含不可序列化的
  // 文件句柄），因此回到 /batch 会恢复轮询，而非显示空队列。
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(BATCH_STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as BatchItem[]
      if (!Array.isArray(saved) || saved.length === 0) return
      const sanitized = saved.map((item) =>
        item.status === 'uploading' && !item.taskId
          ? { ...item, status: 'error' as const, message: '已中断', error: '页面切换导致上传中断，请重试' }
          : item
      )
      setBatchItems(sanitized)
      if (sanitized.some((item) => item.taskId && item.status === 'processing')) {
        setIsBatchRunning(true)
      }
    } catch {
      /* 忽略损坏的持久化状态 */
    }
  }, [])

  // 每次变更时持久化任务矩阵的可序列化副本。
  useEffect(() => {
    try {
      if (batchItems.length === 0) {
        sessionStorage.removeItem(BATCH_STORAGE_KEY)
        return
      }
      const serializable = batchItems.map((item) => ({
        ...item,
        fileItem: {
          id: item.fileItem.id,
          name: item.fileItem.name,
          sizeMb: item.fileItem.sizeMb,
          path: item.fileItem.path,
        },
      }))
      sessionStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(serializable))
    } catch {
      /* 存储空间可能已满或不可用 */
    }
  }, [batchItems])

  // 轮询活跃批处理项的状态，避免在 setState 内产生副作用
  const pollBatchStatus = useCallback(async () => {
    let pendingItems: BatchItem[] = []
    setBatchItems((current) => {
      pendingItems = current.filter(
        (item) => item.taskId && (item.status === 'uploading' || item.status === 'processing')
      )
      return current
    })

    if (pendingItems.length === 0) {
      setBatchItems((current) => {
        if (current.length > 0 && current.every((item) => item.status === 'complete' || item.status === 'error')) {
          setIsBatchRunning(false)
        }
        return current
      })
      return
    }

    const results = await Promise.all(
      pendingItems.map(async (item) => {
        if (!item.taskId) return null
        try {
          const st: TaskStatus = await getTaskStatus(item.taskId)
          return { id: item.id, status: st }
        } catch {
          return null
        }
      })
    )

    setBatchItems((current) => {
      let activeCount = 0
      const updated: BatchItem[] = current.map((item) => {
        const res = results.find((r) => r && r.id === item.id)
        if (!res || !res.status) {
          if (item.status === 'processing' || item.status === 'uploading') {
            activeCount++
          }
          return item
        }
        const st = res.status
        const isComplete = st.stage === 'complete'
        const isError = st.stage === 'error'
        const nextStatus: BatchItem['status'] = isComplete ? 'complete' : isError ? 'error' : 'processing'
        if (nextStatus === 'processing' || item.status === 'uploading') {
          activeCount++
        }
        return {
          ...item,
          progress: st.progress,
          stage: st.stage,
          message: st.message || (isComplete ? '完成' : '处理中...'),
          status: nextStatus,
          error: st.error,
        }
      })

      if (activeCount === 0 && updated.length > 0 && updated.every((item) => item.status === 'complete' || item.status === 'error')) {
        setIsBatchRunning(false)
      }

      return updated
    })
  }, [])

  useEffect(() => {
    if (isBatchRunning) {
      pollingRef.current = setInterval(pollBatchStatus, 2000)
    } else if (pollingRef.current) {
      clearInterval(pollingRef.current)
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [isBatchRunning, pollBatchStatus])

  // 方式一与方式三：扫描目录路径或通过 API 扫描
  async function scanFolderPath(directoryPath: string) {
    setError(null)
    setInfoMessage(null)

    const normalizedPath = directoryPath.trim()
    if (!normalizedPath) {
      setError('请输入或选择输入文件夹路径')
      return
    }

    setIsScanning(true)
    try {
      const res = await scanDirectory(normalizedPath)
      if (res.video_files.length === 0) {
        setError(`扫描完成，但在 ${normalizedPath} 中未检索到支持的视频文件`)
      } else {
        const newQueueItems: VideoQueueItem[] = res.video_files.map((v: ScannedVideoFile) => ({
          id: `scan-${v.path}`,
          name: v.filename,
          sizeMb: v.size_mb,
          path: v.path,
        }))

        setVideoQueue((prev) => {
          const existingPaths = new Set(prev.map((i) => i.path).filter(Boolean))
          const filtered = newQueueItems.filter((i) => !existingPaths.has(i.path))
          return [...prev, ...filtered]
        })

        setInfoMessage(`🎉 成功从输入文件夹自动检索到 ${res.video_files.length} 个视频文件！`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '扫描输入文件夹失败')
    } finally {
      setIsScanning(false)
    }
  }

  async function handleScanFolder() {
    await scanFolderPath(inputDir)
  }

  async function handleInputDirectoryPicker() {
    if (!window.__SHIYIBAO_DESKTOP__) {
      inputFolderPickerRef.current?.click()
      return
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择待转译视频目录',
      })
      if (typeof selected === 'string') {
        setInputDir(selected)
        await scanFolderPath(selected)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开输入目录选择器失败')
    }
  }

  async function handleOutputDirectoryPicker() {
    if (!isDesktopApp) {
      setInfoMessage('浏览器无法获取输出目录绝对路径，自动归档仅在桌面端可用。')
      return
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择转译成片输出目录',
      })
      if (typeof selected === 'string') {
        setOutputDir(selected)
        setInfoMessage(`✨ 已选择输出归档文件夹: ${selected}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开输出目录选择器失败')
    }
  }

  // 方式一：输入目录弹窗选择器
  function handleInputFolderPickerSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return
    const filesList = Array.from(e.target.files)
    const firstFile = filesList[0]

    // 从 webkitRelativePath 推导文件夹名称（仅用于展示——浏览器不会暴露绝对路径，
    // 因此文件会直接加入上传队列，而非按路径扫描）。
    const folderName = firstFile.webkitRelativePath
      ? firstFile.webkitRelativePath.split('/')[0]
      : '选定文件夹'

    // 筛选有效视频文件
    const videoFiles = filesList.filter(
      (f) => f.type.startsWith('video/') || f.name.match(/\.(mp4|mov|mkv|avi|flv|webm)$/i)
    )

    if (videoFiles.length > 0) {
      const newItems: VideoQueueItem[] = videoFiles.map((f) => ({
        id: `dialog-file-${f.name}-${Math.random()}`,
        name: f.name,
        sizeMb: roundMb(f.size),
        file: f,
      }))
      setVideoQueue((prev) => [...prev, ...newItems])
      setInfoMessage(`🎉 已通过文件夹弹窗从 [${folderName}] 载入 ${newItems.length} 个视频文件！`)
    } else {
      setError(`已选定文件夹 [${folderName}]，但其中没有检索到支持的视频文件`)
    }
  }

  // 方式一：输出目录弹窗选择器（浏览器无法拿到绝对路径，仅桌面端支持自动归档）
  function handleOutputFolderPickerSelect(_e: React.ChangeEvent<HTMLInputElement>) {
    setOutputDir('')
    setInfoMessage('浏览器无法获取输出目录绝对路径，自动归档仅在桌面端可用；成片仍可在历史记录中下载。')
  }

  // 方式二：将文件夹拖入输入目录框
  async function handleInputDirDrop(e: React.DragEvent) {
    e.preventDefault()
    setError(null)
    setInfoMessage(null)

    if (e.dataTransfer.items) {
      const items = Array.from(e.dataTransfer.items)
      const folderEntries: any[] = []
      const fileList: File[] = []

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const entry = (item as any).webkitGetAsEntry ? (item as any).webkitGetAsEntry() : null
        if (entry && entry.isDirectory) {
          folderEntries.push(entry)
        } else if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file && (file.type.startsWith('video/') || file.name.match(/\.(mp4|mov|mkv|avi|flv|webm)$/i))) {
            fileList.push(file)
          }
        }
      }

      if (folderEntries.length > 0) {
        const folderName = folderEntries[0].name

        let allExtractedFiles: File[] = []
        for (const fEntry of folderEntries) {
          const extracted = await extractVideosFromEntry(fEntry)
          allExtractedFiles = [...allExtractedFiles, ...extracted]
        }

        const newItems: VideoQueueItem[] = allExtractedFiles.map((f) => ({
          id: `drop-folder-${f.name}-${Math.random()}`,
          name: f.name,
          sizeMb: roundMb(f.size),
          file: f,
        }))

        if (newItems.length > 0) {
          setVideoQueue((prev) => [...prev, ...newItems])
          setInfoMessage(`🎉 拖拽文件夹 [${folderName}] 成功，自动加载 ${newItems.length} 个视频文件！`)
        } else {
          setError(`已成功拖入文件夹 [${folderName}]，但其中未发现支持的视频文件`)
        }
      } else if (fileList.length > 0) {
        const newItems: VideoQueueItem[] = fileList.map((f) => ({
          id: `drop-file-${f.name}-${Math.random()}`,
          name: f.name,
          sizeMb: roundMb(f.size),
          file: f,
        }))
        setVideoQueue((prev) => [...prev, ...newItems])
        setInfoMessage(`🎉 成功拖入 ${newItems.length} 个视频文件！`)
      }
    }
  }

  // 方式二：将文件夹拖入输出目录框
  async function handleOutputDirDrop(e: React.DragEvent) {
    e.preventDefault()
    if (!isDesktopApp) {
      setInfoMessage('浏览器无法获取输出目录绝对路径，自动归档仅在桌面端可用；成片仍可在历史记录中下载。')
      return
    }
    if (e.dataTransfer.items) {
      const items = Array.from(e.dataTransfer.items)
      for (let i = 0; i < items.length; i++) {
        const entry = (items[i] as any).webkitGetAsEntry ? (items[i] as any).webkitGetAsEntry() : null
        if (entry && entry.isDirectory) {
          // 桌面 WebView 若仍只能拿到目录名，则不写入无效相对路径。
          if (!isAbsolutePath(entry.fullPath || entry.name)) {
            setInfoMessage('请使用【选择】按钮或粘贴绝对路径设置输出目录。')
            return
          }
          setOutputDir(entry.fullPath || entry.name)
          setInfoMessage(`✨ 已拖入设置输出归档文件夹: ${entry.fullPath || entry.name}`)
          return
        }
      }
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return
    const newFiles = Array.from(e.target.files)
    const newItems: VideoQueueItem[] = newFiles.map((f) => ({
      id: `file-${f.name}-${Math.random()}`,
      name: f.name,
      sizeMb: roundMb(f.size),
      file: f,
    }))
    setVideoQueue((prev) => [...prev, ...newItems])
  }

  function roundMb(sizeBytes: number): number {
    return Math.round((sizeBytes / (1024 * 1024)) * 10) / 10
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files) {
      const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith('video/') || f.name.match(/\.(mp4|mov|mkv)$/i)
      )
      const newItems: VideoQueueItem[] = droppedFiles.map((f) => ({
        id: `file-${f.name}-${Math.random()}`,
        name: f.name,
        sizeMb: roundMb(f.size),
        file: f,
      }))
      setVideoQueue((prev) => [...prev, ...newItems])
    }
  }

  function removeItem(id: string) {
    setVideoQueue((prev) => prev.filter((i) => i.id !== id))
  }

  function toggleTargetLang(langId: string) {
    setSelectedTargetLangs((prev) => {
      if (prev.includes(langId)) {
        if (prev.length === 1) return prev
        return prev.filter((l) => l !== langId)
      }
      return [...prev, langId]
    })
  }

  function selectAllTargetLangs() {
    setSelectedTargetLangs(TARGET_LANGUAGES.map((l) => l.id))
  }

  function clearTargetLangs() {
    setSelectedTargetLangs(['zh'])
  }

  async function handleStartBatch() {
    setError(null)
    setInfoMessage(null)

    let currentSettings = loadSettings()
    if (!currentSettings.geminiApiKey || !currentSettings.xiaomiTtsKey) {
      const serverData = await fetchServerSettings()
      if (serverData && (serverData.geminiApiKey || serverData.xiaomiTtsKey)) {
        currentSettings = { ...currentSettings, ...serverData }
        saveSettings(currentSettings)
      }
    }

    if (!currentSettings.geminiApiKey) {
      setError('请先在系统偏好设置中填写 Gemini API Key')
      return
    }
    if (!currentSettings.xiaomiTtsKey) {
      setError('请先在系统偏好设置中填写小米 MiMo TTS Key')
      return
    }
    if (videoQueue.length === 0) {
      setError('请至少添加或扫描一个视频文件')
      return
    }
    if (selectedTargetLangs.length === 0) {
      setError('请至少勾选一个目标翻译语言')
      return
    }

    // 构建任务项
    const newItems: BatchItem[] = []
    videoQueue.forEach((vqItem, fIdx) => {
      selectedTargetLangs.forEach((tLang, lIdx) => {
        newItems.push({
          id: `batch-${fIdx}-${lIdx}-${Math.random().toString(36).substring(2, 7)}`,
          fileItem: vqItem,
          targetLang: tLang,
          status: 'idle',
          progress: 0,
          stage: 'pending',
          message: '等待排队...',
        })
      })
    })

    setBatchItems(newItems)
    setIsBatchRunning(true)
    const archiveOutputDir = canAutoArchive ? outputDir.trim() : undefined

    // 为每个任务项执行上传或本地路径注册
    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i]
      setBatchItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: 'uploading', message: '提交并发任务...' } : it))
      )

      try {
        let taskIdToUse = ''
        const currentModel = currentSettings.geminiModel || 'gemini-2.0-flash'

        if (item.fileItem.path) {
          // 先注册磁盘文件，使标准流水线可通过任务元数据定位文件
          // （无需重复上传或复制）。
          const registered = await registerLocalTask(item.fileItem.path, archiveOutputDir)
          taskIdToUse = registered.task_id
          await startTask(taskIdToUse, {
            gemini_api_key: currentSettings.geminiApiKey,
            gemini_api_url: currentSettings.geminiApiUrl || '',
            gemini_api_format: currentSettings.geminiApiFormat || 'Gemini',
            mimo_api_key: currentSettings.xiaomiTtsKey,
            gemini_model: currentModel,
            voice: currentSettings.mimoVoice || '冰糖',
            source_lang: currentSettings.sourceLang || 'auto',
            target_lang: item.targetLang,
            stream_mode: currentSettings.streamMode || 'streaming',
            original_audio_volume: currentSettings.originalAudioVolume ?? 0.2,
            output_dir: archiveOutputDir,
          })
        } else if (item.fileItem.file) {
          const uploadRes = await uploadVideo(item.fileItem.file)
          taskIdToUse = uploadRes.task_id
          await startTask(taskIdToUse, {
            gemini_api_key: currentSettings.geminiApiKey,
            gemini_api_url: currentSettings.geminiApiUrl || '',
            gemini_api_format: currentSettings.geminiApiFormat || 'Gemini',
            mimo_api_key: currentSettings.xiaomiTtsKey,
            gemini_model: currentModel,
            voice: currentSettings.mimoVoice || '冰糖',
            source_lang: currentSettings.sourceLang || 'auto',
            target_lang: item.targetLang,
            stream_mode: currentSettings.streamMode || 'streaming',
            original_audio_volume: currentSettings.originalAudioVolume ?? 0.2,
            output_dir: archiveOutputDir,
          })
        }

        setBatchItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  taskId: taskIdToUse,
                  status: 'processing',
                  progress: 10,
                  stage: 'extracting_audio',
                  message: '已分配处理节点，正在解析音轨',
                }
              : it
          )
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : '启动失败'
        setBatchItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, status: 'error', message: '启动失败', error: errMsg } : it))
        )
      }
    }
  }

  const totalTaskCount = videoQueue.length * selectedTargetLangs.length
  const completedCount = batchItems.filter((i) => i.status === 'complete').length
  const processingCount = batchItems.filter((i) => i.status === 'processing' || i.status === 'uploading').length
  const errorCount = batchItems.filter((i) => i.status === 'error').length
  const overallProgress =
    batchItems.length > 0
      ? Math.round(batchItems.reduce((acc, cur) => acc + cur.progress, 0) / batchItems.length)
      : 0

  return (
    <div className="w-full h-[calc(100vh-4.2rem)] overflow-hidden flex flex-col p-3 sm:p-5 max-w-7xl mx-auto">
      {/* 隐藏的原生文件夹选择器输入框（用于方式一：弹窗选择） */}
      <input
        ref={inputFolderPickerRef}
        type="file"
        {...({ webkitdirectory: '', directory: '' } as any)}
        className="hidden"
        onChange={handleInputFolderPickerSelect}
      />
      <input
        ref={outputFolderPickerRef}
        type="file"
        {...({ webkitdirectory: '', directory: '' } as any)}
        className="hidden"
        onChange={handleOutputFolderPickerSelect}
      />

      {/* 紧凑型顶部标题与说明 */}
      <div className="flex items-center justify-between pb-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-purple-100 dark:bg-purple-950 flex items-center justify-center">
            <Layers className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100 leading-none">
                批量视频转译工作台
              </h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 dark:bg-purple-950/80 text-purple-600 dark:text-purple-300">
                {isDesktopApp ? '三重目录选择 / 自动归档' : '批量上传 / 桌面端可自动归档'}
              </span>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              {isDesktopApp
                ? '支持：1. 点击【选择】弹窗 2. 拖拽文件夹至框内 3. 粘贴绝对路径。'
                : '浏览器可批量上传处理；自动归档需要桌面端提供输出目录绝对路径。'}
            </p>
          </div>
        </div>

        {batchItems.length > 0 && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-400">
              完成: <strong className="text-emerald-600 dark:text-emerald-400">{completedCount}</strong>/{batchItems.length}
            </span>
            {processingCount > 0 && (
              <span className="text-blue-500 font-medium">
                处理中: <strong>{processingCount}</strong>
              </span>
            )}
            {errorCount > 0 && (
              <span className="text-rose-500 font-medium">
                失败: <strong>{errorCount}</strong>
              </span>
            )}
            <span className="font-bold text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/60 px-2.5 py-1 rounded-lg">
              {overallProgress}%
            </span>
          </div>
        )}
      </div>

      {error && (
        <Alert variant="destructive" className="mb-2 py-2 rounded-xl text-xs shrink-0">
          <AlertCircle className="h-3.5 w-3.5" />
          <AlertDescription className="ml-2 font-medium">{error}</AlertDescription>
        </Alert>
      )}

      {infoMessage && (
        <Alert className="mb-2 py-2 rounded-xl text-xs border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0">
          <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
          <AlertDescription className="ml-2 font-medium">{infoMessage}</AlertDescription>
        </Alert>
      )}

      {/* 紧凑型文件夹路径卡片 (支持三重方式：弹窗 / 拖拽 / 粘贴) */}
      <div className="mb-3 p-3 rounded-2xl bg-white/80 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 shrink-0 backdrop-blur-md">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-center">
          {/* 1. 输入目录 */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-300 shrink-0 min-w-[70px]">
              <FolderOpen className="w-3.5 h-3.5 text-purple-600" />
              <span>输入目录:</span>
            </div>
            <div className="relative flex-1">
              <Input
                placeholder="选择/拖拽文件夹或粘贴路径"
                value={inputDir}
                onChange={(e) => setInputDir(e.target.value)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleInputDirDrop}
                className="h-8 text-xs bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 rounded-lg pr-2 font-mono"
                title="支持 1. 点击右侧【选择】弹窗 2. 拖拽文件夹至此处 3. 直接粘贴文本路径"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleInputDirectoryPicker}
              className="h-8 px-2.5 text-xs font-medium rounded-lg border-purple-200 hover:bg-purple-50 dark:hover:bg-purple-950 text-purple-700 dark:text-purple-300 shrink-0 cursor-pointer"
              title="弹窗选择本地文件夹"
            >
              <FolderOpen className="w-3.5 h-3.5 mr-1 text-purple-600" />
              选择
            </Button>
            <Button
              type="button"
              onClick={handleScanFolder}
              disabled={isScanning || !inputDir.trim()}
              className="h-8 px-3 text-xs font-medium rounded-lg bg-purple-600 hover:bg-purple-700 text-white shrink-0 cursor-pointer"
              title="扫描路径下的视频文件"
            >
              {isScanning ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <>
                  <Search className="w-3 h-3 mr-1" />
                  扫描
                </>
              )}
            </Button>
          </div>

          {/* 2. 输出目录 */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-300 shrink-0 min-w-[70px]">
              <FolderOutput className="w-3.5 h-3.5 text-blue-600" />
              <span>输出目录:</span>
            </div>
            <div className="relative flex-1">
              <Input
                placeholder={isDesktopApp ? '选择/拖拽文件夹或粘贴绝对路径' : '浏览器模式不支持自动归档'}
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleOutputDirDrop}
                disabled={!isDesktopApp}
                className="h-8 text-xs bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 rounded-lg font-mono disabled:opacity-60"
                title={isDesktopApp ? '支持绝对路径自动归档' : '自动归档仅桌面端可用'}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleOutputDirectoryPicker}
              disabled={!isDesktopApp}
              className="h-8 px-2.5 text-xs font-medium rounded-lg border-blue-200 hover:bg-blue-50 dark:hover:bg-blue-950 text-blue-700 dark:text-blue-300 shrink-0 cursor-pointer disabled:opacity-50"
              title={isDesktopApp ? '弹窗选择本地输出文件夹' : '自动归档仅桌面端可用'}
            >
              <FolderOutput className="w-3.5 h-3.5 mr-1 text-blue-600" />
              选择
            </Button>
          </div>
        </div>
        {!isDesktopApp && (
          <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
            当前为浏览器模式：成片请在历史记录下载；自动归档请使用桌面端。
          </p>
        )}
        {isDesktopApp && outputDir.trim() && !canAutoArchive && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            输出目录需为绝对路径才能自动归档（当前值会被忽略）。
          </p>
        )}
      </div>

      {/* 主面板网格（左右分栏，内部滚动，外层 overflow-hidden 固定一屏） */}
      <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-0">
        {/* 左栏 (5列)：视频文件队列 */}
        <div className="lg:col-span-5 flex flex-col h-full overflow-hidden bg-white/70 dark:bg-slate-900/50 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-3.5">
          <div className="flex items-center justify-between pb-2 shrink-0 border-b border-slate-100 dark:border-slate-800 mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              待转译视频 ({videoQueue.length})
            </span>
            {videoQueue.length > 0 && (
              <button
                type="button"
                onClick={() => setVideoQueue([])}
                className="text-[11px] font-medium text-rose-500 hover:underline"
              >
                清空列表
              </button>
            )}
          </div>

          <Input
            ref={fileInputRef}
            type="file"
            multiple
            accept="video/mp4,video/quicktime,video/x-matroska"
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* 紧凑型拖拽/手动添加区域 */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileInputRef.current?.click()
              }
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`w-full cursor-pointer transition-all rounded-xl p-3 flex flex-col items-center justify-center border border-dashed shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50 ${
              isDragging
                ? 'border-purple-500 bg-purple-50/40 dark:bg-purple-950/20'
                : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:border-slate-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <Upload className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                点击或拖拽添加视频文件
              </span>
            </div>
            <span className="text-[10px] text-slate-400 mt-0.5">支持 MP4, MOV, MKV</span>
          </div>

          {/* 可内部滚动的视频文件列表 */}
          <div className="flex-1 overflow-y-auto min-h-0 space-y-1.5 pt-2 pr-0.5">
            {videoQueue.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-4 text-slate-400 text-xs">
                <FileVideo className="w-8 h-8 stroke-[1.2] text-slate-300 dark:text-slate-600 mb-1" />
                <span>暂未添加视频文件</span>
                <span className="text-[10px] text-slate-400 mt-1">使用上方【选择/拖拽文件夹/扫描】添加</span>
              </div>
            ) : (
              videoQueue.map((item) => (
                <div
                  key={item.id}
                  className="p-2.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileVideo className="w-4 h-4 text-purple-600 shrink-0" />
                    <div className="min-w-0 flex flex-col">
                      <span className="font-medium text-slate-800 dark:text-slate-200 truncate max-w-[160px] sm:max-w-[200px]">
                        {item.name}
                      </span>
                      {item.path && (
                        <span className="text-[10px] text-slate-400 truncate max-w-[180px] font-mono">
                          {item.path}
                        </span>
                      )}
                    </div>
                    <span className="text-slate-400 text-[10px] shrink-0">
                      {item.sizeMb} MB
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    className="p-1 rounded text-slate-400 hover:text-rose-500"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右栏 (7列)：语言配置 & 批量任务进度矩阵 */}
        <div className="lg:col-span-7 flex flex-col h-full overflow-hidden space-y-3">
          {/* 上半卡片：语言选择与启动 */}
          <div className="p-3.5 rounded-2xl bg-white/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800 shrink-0 space-y-2.5">
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
              {/* 初始语言 */}
              <div className="sm:col-span-4 flex items-center gap-1.5">
                <span className="text-xs font-semibold text-slate-500 shrink-0">源语言:</span>
                <Select
                  value={settings.sourceLang || 'auto'}
                  onValueChange={(val) => {
                    if (!val) return
                    const updated: AppSettings = { ...settings, sourceLang: val }
                    setSettings(updated)
                    saveSettings(updated)
                  }}
                >
                  <SelectTrigger className="h-8 text-xs font-semibold bg-slate-100/80 dark:bg-slate-800/80 border-0 rounded-lg">
                    <SelectValue>{getLanguageDisplayName(settings.sourceLang, true)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="bg-white dark:bg-slate-900">
                    {SOURCE_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.id} value={lang.id} className="text-xs">
                        {lang.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 目标语言多选标题栏 */}
              <div className="sm:col-span-8 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">
                  目标语言 (已选 {selectedTargetLangs.length} 个)
                </span>
                <div className="flex gap-2 text-xs">
                  <button type="button" onClick={selectAllTargetLangs} className="text-purple-600 dark:text-purple-400 text-[11px]">
                    全选
                  </button>
                  <button type="button" onClick={clearTargetLangs} className="text-slate-400 text-[11px]">
                    重置
                  </button>
                </div>
              </div>
            </div>

            {/* 目标语言多选网格 (2行4列 紧凑) */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {TARGET_LANGUAGES.map((lang) => {
                const isChecked = selectedTargetLangs.includes(lang.id)
                const shortLabel = lang.label.replace(/\s*\(.*?\)/, '')
                return (
                  <button
                    key={lang.id}
                    type="button"
                    onClick={() => toggleTargetLang(lang.id)}
                    className={`h-8 px-2.5 rounded-xl text-xs font-medium flex items-center justify-between border transition-all cursor-pointer ${
                      isChecked
                        ? 'bg-purple-50/90 dark:bg-purple-950/60 border-purple-500/80 text-purple-700 dark:text-purple-300 font-semibold shadow-2xs'
                        : 'bg-slate-50/70 dark:bg-slate-800/40 border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span className="truncate">{shortLabel}</span>
                    {isChecked && <Check className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 shrink-0 ml-1" />}
                  </button>
                )
              })}
            </div>

            {/* 启动按钮 */}
            <div className="flex items-center justify-between pt-1 gap-3">
              <span className="text-[11px] text-slate-400">
                生成 <strong className="text-purple-600 dark:text-purple-400">{totalTaskCount}</strong> 个转译任务 ({videoQueue.length} 视频 × {selectedTargetLangs.length} 语言)
              </span>
              <Button
                onClick={handleStartBatch}
                disabled={isBatchRunning || videoQueue.length === 0 || selectedTargetLangs.length === 0}
                className="h-9 px-5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-medium text-xs transition-all cursor-pointer shrink-0"
              >
                {isBatchRunning ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    处理中...
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 mr-1.5 fill-current" />
                    启动批量转译 ({totalTaskCount})
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* 下半卡片：批量任务进度矩阵 (内部滚动) */}
          <div className="flex-1 overflow-hidden flex flex-col p-3.5 rounded-2xl bg-white/70 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800 min-h-0">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800 shrink-0">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                转译任务队列 ({batchItems.length})
              </span>
              <button
                type="button"
                onClick={pollBatchStatus}
                className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600"
              >
                <RefreshCw className="w-3 h-3" />
                刷新
              </button>
            </div>

            {batchItems.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-4 text-slate-400 text-xs">
                <span>暂无转译任务，配置后点击【启动批量转译】</span>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto min-h-0 space-y-2 pt-2 pr-0.5">
                {batchItems.map((item) => (
                  <div
                    key={item.id}
                    className="p-2.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileVideo className="w-4 h-4 text-purple-600 shrink-0" />
                      <div className="min-w-0 flex flex-col">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[140px] sm:max-w-[200px]">
                            {item.fileItem.name}
                          </span>
                          <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-300">
                            {getLanguageDisplayName(item.targetLang)}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400 truncate max-w-[180px]">{item.message}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <div className="w-24 flex flex-col space-y-0.5">
                        <div className="flex justify-between text-[10px] text-slate-400">
                          <span>{item.status === 'complete' ? '完成' : item.status === 'error' ? '失败' : '处理'}</span>
                          <span>{item.progress}%</span>
                        </div>
                        <div className="w-full bg-slate-200 dark:bg-slate-700 h-1 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              item.status === 'complete'
                                ? 'bg-emerald-500'
                                : item.status === 'error'
                                ? 'bg-rose-500'
                                : 'bg-blue-500'
                            }`}
                            style={{ width: `${item.progress}%` }}
                          />
                        </div>
                      </div>

                      {item.taskId && (
                        <button
                          type="button"
                          onClick={() => {
                            saveActiveTaskId(item.taskId!)
                            navigate(`/task/${item.taskId}`)
                          }}
                          className="p-1 rounded text-slate-500 hover:text-purple-600"
                          title="工作台"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {item.status === 'complete' && item.taskId && (
                        <a
                          href={getExportUrl(item.taskId)}
                          download
                          className="p-1 rounded text-emerald-600 hover:text-emerald-700"
                          title="下载"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
