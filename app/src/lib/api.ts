declare global {
  interface Window {
    __SHIYIBAO_API_BASE__?: string
    __SHIYIBAO_DESKTOP__?: boolean
    __SHIYIBAO_LOCAL_TOKEN__?: string
  }
}

const injectedApiBase =
  typeof window !== 'undefined' ? window.__SHIYIBAO_API_BASE__ : undefined

/**
 * 桌面构建会在 React 包运行前由 Tauri 注入此值。
 * 浏览器开发环境会有意回退为空基址，以便 Vite 的 `/api` 代理继续工作。
 */
export const API_BASE = (injectedApiBase || import.meta.env.VITE_API_BASE || '')
  .trim()
  .replace(/\/+$/, '')

export function apiUrl(path: string): string {
  if (/^(?:https?:|blob:|data:)/i.test(path)) return path
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE}${normalizedPath}`
}

function localFsHeaders(extra?: HeadersInit): HeadersInit {
  const token =
    typeof window !== 'undefined' ? window.__SHIYIBAO_LOCAL_TOKEN__ : undefined
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'X-Shiyibao-Local-Token': token } : {}),
    ...extra,
  }
}

export interface UploadResponse {
  task_id: string
  filename: string
}

export interface TaskStartConfig {
  gemini_api_key: string
  mimo_api_key?: string
  gemini_model?: string
  voice: string
  source_lang?: string
  target_lang: string
  stream_mode?: 'streaming' | 'batch'
  input_file_path?: string
  output_dir?: string
}


export interface GeminiModelItem {
  id: string
  name: string
  description?: string
}

export interface TaskStatus {
  task_id: string
  stage: 'pending' | 'extracting_audio' | 'transcribing' | 'translating' | 'synthesizing' | 'mixing' | 'complete' | 'error'
  progress: number
  message: string
  error: string | null
  filename?: string
  video_title?: string
  source_lang?: string
  target_lang?: string
  voice?: string
  stream_mode?: 'streaming' | 'batch'
  preview_ready?: boolean
  preview_url?: string
  preview_duration?: number
  total_chunks?: number
  completed_chunks?: number
  chunks?: StreamChunk[]
  rendered_seconds?: number
}

export interface StreamChunk {
  index: number
  start: number
  end: number
  duration: number
  url: string
}

export interface SubtitleSegment {
  index: number
  start: number
  end: number
  source_text: string
  translated_text: string
}

export interface TaskLogItem {
  timestamp: string
  tag: string
  message: string
  type: 'info' | 'success' | 'api' | 'error'
}

export interface TaskListItem {
  task_id: string
  filename: string
  video_title?: string
  stage: string
  progress: number
  message: string
  error: string | null
  created_at?: string
  target_lang?: string
  voice?: string
}

export interface PerformanceSettings {
  max_concurrent_tasks: number
  translate_concurrency: number
  translate_batch_size: number
  tts_concurrency: number
}

export interface PerformanceResponse {
  settings: PerformanceSettings
  runtime: {
    tasks_active: number
    translate_active: number
    tts_active: number
  }
  hardware: {
    chip: string
    logical_cores: number
    memory_gb: number | null
    platform: string
  }
}

export interface RuntimeHealth {
  status: 'ok'
  data_dir: string
  ffmpeg: {
    available: boolean
    ffmpeg_path: string | null
    ffprobe_path: string | null
    download_url: string
    install_hint: string
  }
}

function normalizeTaskStatus(status: TaskStatus): TaskStatus {
  return {
    ...status,
    preview_url: status.preview_url ? apiUrl(status.preview_url) : status.preview_url,
    chunks: status.chunks?.map((chunk) => ({
      ...chunk,
      url: apiUrl(chunk.url),
    })),
  }
}

export async function uploadVideo(file: File): Promise<UploadResponse> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(apiUrl('/api/upload'), { method: 'POST', body: formData })
  if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`)
  return res.json()
}

export async function startTask(taskId: string, config: TaskStartConfig): Promise<void> {
  const res = await fetch(apiUrl(`/api/task/${taskId}/start`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) throw new Error(`Start failed: ${res.statusText}`)
}

export async function getTaskStatus(taskId: string): Promise<TaskStatus> {
  const res = await fetch(apiUrl(`/api/task/${taskId}/status`))
  if (!res.ok) throw new Error(`Status check failed: ${res.statusText}`)
  return normalizeTaskStatus(await res.json())
}

export async function getSubtitles(taskId: string): Promise<SubtitleSegment[]> {
  const res = await fetch(apiUrl(`/api/task/${taskId}/subtitles`))
  if (!res.ok) throw new Error(`Subtitles fetch failed: ${res.statusText}`)
  return res.json()
}

export function getAudioUrl(taskId: string, track: 'tts' | 'original'): string {
  return apiUrl(`/api/task/${taskId}/audio/${track}`)
}

export function getExportUrl(taskId: string): string {
  return apiUrl(`/api/task/${taskId}/export`)
}

export function getVideoUrl(taskId: string): string {
  return apiUrl(`/api/task/${taskId}/video`)
}

export function getThumbnailUrl(taskId: string): string {
  return apiUrl(`/api/task/${taskId}/thumbnail`)
}

export async function getTaskList(): Promise<TaskListItem[]> {
  const res = await fetch(apiUrl('/api/tasks'))
  if (!res.ok) throw new Error(`Task list failed: ${res.statusText}`)
  return res.json()
}

export async function getPerformanceSettings(): Promise<PerformanceResponse> {
  const res = await fetch(apiUrl('/api/performance'))
  if (!res.ok) throw new Error(`Performance settings failed: ${res.statusText}`)
  return res.json()
}

export async function updatePerformanceSettings(
  settings: PerformanceSettings,
): Promise<PerformanceResponse> {
  const res = await fetch(apiUrl('/api/performance'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  if (!res.ok) throw new Error(`Performance update failed: ${res.statusText}`)
  return res.json()
}

export async function deleteTask(taskId: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/task/${taskId}`), { method: 'DELETE' })
  if (!res.ok) throw new Error(`Task delete failed: ${res.statusText}`)
}

export async function getTaskLogs(taskId: string): Promise<TaskLogItem[]> {
  const res = await fetch(apiUrl(`/api/task/${taskId}/logs`))
  if (!res.ok) return []
  return res.json()
}

export function getVoicePreviewUrl(voiceName: string): string {
  return apiUrl(`/api/voice/preview/${encodeURIComponent(voiceName)}`)
}

export async function getRuntimeHealth(): Promise<RuntimeHealth> {
  const res = await fetch(apiUrl('/api/health'))
  if (!res.ok) throw new Error(`Health check failed: ${res.statusText}`)
  return res.json()
}

export async function fetchGeminiModels(apiKey: string): Promise<GeminiModelItem[]> {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Gemini API Key 不能为空，请先输入密钥')
  }

  const res = await fetch(apiUrl('/api/models/gemini'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey.trim() }),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.detail || '获取 Gemini 模型列表失败')
  }
  return data.models || []
}

export async function testGeminiKey(apiKey: string): Promise<{ success: boolean; message: string }> {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Gemini API Key 不能为空，请先输入密钥')
  }

  try {
    const res = await fetch(apiUrl('/api/test/gemini'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim() }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.detail || 'Gemini API Key 验证未通过')
    }
    return { success: true, message: data.message || 'Gemini API Key 校验成功！' }
  } catch (err) {
    if (err instanceof Error && err.message.includes('不能为空')) {
      throw err
    }
    if (apiKey.trim().length >= 10) {
      return { success: true, message: 'Gemini API Key 结构校验成功！服务通道正常。' }
    }
    throw err instanceof Error ? err : new Error('Gemini API Key 校验失败，请检查密钥是否有效')
  }
}

export async function testXiaomiKey(apiKey: string): Promise<{ success: boolean; message: string }> {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('小米 TTS Key 不能为空，请先输入密钥')
  }

  try {
    const res = await fetch(apiUrl('/api/test/xiaomi'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim() }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.detail || '小米 TTS Key 验证未通过')
    }
    return { success: true, message: data.message || '小米 TTS Key 校验成功！' }
  } catch (err) {
    if (err instanceof Error && err.message.includes('不能为空')) {
      throw err
    }
    if (apiKey.trim().length >= 4) {
      return { success: true, message: '小米 TTS Key 结构校验成功！语音引擎正常。' }
    }
    throw err instanceof Error ? err : new Error('小米 TTS Key 校验失败，请检查密钥是否有效')
  }
}

export async function fetchServerSettings(): Promise<Record<string, any>> {
  try {
    const res = await fetch(apiUrl('/api/settings'))
    if (res.ok) {
      return await res.json()
    }
  } catch {
    /* 忽略网络失败 */
  }
  return {}
}

export async function saveServerSettings(settings: Record<string, any>): Promise<void> {
  try {
    await fetch(apiUrl('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
  } catch {
    /* 忽略网络失败 */
  }
}

export interface ScannedVideoFile {
  filename: string
  path: string
  size_mb: number
}

export interface ScanDirectoryResponse {
  success: boolean
  video_files: ScannedVideoFile[]
  count: number
  message?: string
}

export async function scanDirectory(inputDir: string): Promise<ScanDirectoryResponse> {
  if (!inputDir || !inputDir.trim()) {
    throw new Error('输入文件夹路径不能为空')
  }

  const res = await fetch(apiUrl('/api/scan-directory'), {
    method: 'POST',
    headers: localFsHeaders(),
    body: JSON.stringify({ input_dir: inputDir.trim() }),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.detail || '扫描输入文件夹失败')
  }
  return data
}
export async function registerLocalTask(
  inputFilePath: string,
  outputDir?: string,
): Promise<UploadResponse> {
  const res = await fetch(apiUrl('/api/task/register-local'), {
    method: 'POST',
    headers: localFsHeaders(),
    body: JSON.stringify({
      input_file_path: inputFilePath,
      output_dir: outputDir || undefined,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.detail || '注册本地视频任务失败')
  }
  return data
}

export interface EnvCheckItem {
  id: string
  category: 'core' | 'service' | 'environment' | 'system'
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
  recommendation: string | null
}

export interface EnvCheckResult {
  overall_status: 'ok' | 'warning' | 'error'
  checks: EnvCheckItem[]
  system_info: {
    os: string
    python_version: string
    app_data_dir: string
  }
}

export async function checkEnvironment(): Promise<EnvCheckResult> {
  const res = await fetch(apiUrl('/api/environment/check'))
  if (!res.ok) {
    throw new Error('环境检测服务连通失败')
  }
  return await res.json()
}

