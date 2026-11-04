import { apiFetch, apiUrl } from './api'
import { loadSettings } from '@/components/SettingsPanel'

export interface MarketInfo {
  code: string
  name: string
  name_en: string
  flag: string
  lang: string
  voice: string
  platforms: string[]
  currency: string
  units: string
  tone: string
  rules: string[]
}

export interface AgentIntent {
  scenario: 'ecommerce' | 'culture' | 'general'
  subject: string
  audience: string
  tone: string
  markets: string[]
  platforms: string[]
  keep_terms: string[]
  constraints: string[]
  need_review: boolean
  need_copy: boolean
  source: 'llm' | 'rule'
}

export interface PlanStep {
  key: string
  title: string
  detail: string
}

export interface ReviewIssue {
  index: number
  original: string
  suggestion: string
  reason: string
  severity: 'high' | 'medium' | 'low'
  category: string
  source: 'llm' | 'rule'
}

export interface MarketReview {
  market: string
  score: number
  summary: string
  issues: ReviewIssue[]
  rules: string[]
}

export interface PlatformCopy {
  platform: string
  titles: string[]
  hashtags: string[]
  description: string
  cta: string
}

export interface CampaignMarket {
  code: string
  name: string
  flag: string
  lang: string
  voice: string
  platforms: string[]
  brief: string
  task_id: string | null
  stage: string
  progress?: number
  message?: string
  error?: string | null
  video_title?: string | null
  has_final?: boolean
  review: MarketReview | null
  copy: { platforms: PlatformCopy[]; source?: string } | null
  applied_edits: number
}

export interface TimelineItem {
  ts: string
  step: string
  detail: string
  kind: 'info' | 'success' | 'warning' | 'error' | 'api'
  market: string | null
}

export interface RevisionChange {
  index: number
  original: string
  suggestion: string
  reason: string
}

export interface ChatMessage {
  role: 'user' | 'agent'
  content: string
  ts: string
  market?: string
  changes?: RevisionChange[]
}

export interface SourceMediaInfo {
  filename?: string | null
  title?: string | null
  duration?: number | null
  width?: number | null
  height?: number | null
  source_lang?: string | null
  segment_count?: number | null
  sample_id?: string | null
  poster?: string | null
  has_video?: boolean
  preview_task_id?: string | null
  /** 存在项目目录里的封面帧，原片被清理后仍可用 */
  cover?: string | null
}

export interface SampleSegment {
  index: number
  start: number
  end: number
  source_text: string
  dubbed_text: string
  risk_note?: string
  translation_note?: string
}

export interface SampleItem {
  id: string
  scenario: 'ecommerce' | 'culture' | 'general'
  tag: string
  title: string
  filename: string
  poster: string
  duration: number
  width: number
  height: number
  source_lang: string
  dub_market: string
  dub_lang: string
  dub_label: string
  markets: string[]
  highlight: string
  prompt: string
  segments: SampleSegment[]
  source_video_url: string
  dubbed_video_url: string
  source_author: string
  source_title: string
  source_url: string
}

export interface MaterializedSample {
  task_id: string
  sample_id: string
  filename: string
  title: string
  duration: number
  width: number
  height: number
  source_lang: string
  segment_count: number
  prompt: string
  markets: string[]
  poster: string
}

export interface CampaignSession {
  id: string
  created_at: string
  prompt: string
  source_task_id: string
  source_filename?: string
  source_media?: SourceMediaInfo
  intent: AgentIntent
  plan: { markets: CampaignMarket[]; steps: PlanStep[] }
  status: 'planned' | 'running' | 'awaiting_review' | 'complete' | 'error'
  markets: Record<string, CampaignMarket>
  messages: ChatMessage[]
  timeline: TimelineItem[]
}

export interface CampaignSummary {
  id: string
  prompt: string
  created_at: string
  status: string
  markets: string[]
  source_task_id: string
  source_filename?: string | null
  source_title?: string | null
  source_duration?: number | null
  sample_id?: string | null
  poster?: string | null
  preview_task_id?: string | null
  cover?: string | null
  has_source_video?: boolean
  scenario?: string | null
}

/** 本地已保存的模型配置；留空字段由后端回退到服务端设置。 */
function aiConfig() {
  const s = loadSettings()
  return {
    gemini_api_key: s.geminiApiKey || '',
    gemini_model: s.geminiModel || undefined,
    gemini_api_url: s.geminiApiUrl || undefined,
    gemini_api_format: s.geminiApiFormat || undefined,
    mimo_api_key: s.xiaomiTtsKey || '',
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.detail || `请求失败 (${res.status})`)
  return data as T
}

function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify({ ...aiConfig(), ...body }) })
}

export const listMarkets = () => request<MarketInfo[]>('/api/agent/markets')

export function resolveAssetUrl(path: string): string {
  return path.startsWith('/api/') ? apiUrl(path) : path
}

export function formatMediaDuration(seconds?: number | null): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.max(1, Math.round(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export function formatRelativeTime(dateStr?: string | null): string {
  if (!dateStr) return ''
  const ts = new Date(dateStr).getTime()
  if (Number.isNaN(ts)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 45) return '刚刚'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Date(dateStr).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export async function listSamples(): Promise<SampleItem[]> {
  const items = await request<SampleItem[]>('/api/agent/samples')
  return items.map((item) => ({
    ...item,
    poster: resolveAssetUrl(item.poster),
    source_video_url: apiUrl(item.source_video_url),
    dubbed_video_url: apiUrl(item.dubbed_video_url),
  }))
}

export async function materializeSample(sampleId: string): Promise<MaterializedSample> {
  const data = await post<MaterializedSample>(`/api/agent/samples/${encodeURIComponent(sampleId)}/use`)
  return { ...data, poster: resolveAssetUrl(data.poster) }
}

export const getSampleVideoUrl = (sampleId: string, variant: 'source' | 'dubbed' = 'source') =>
  apiUrl(`/api/agent/samples/${encodeURIComponent(sampleId)}/video?variant=${variant}`)

export const listCampaigns = () => request<CampaignSummary[]>('/api/agent/sessions')

export const getCampaign = (id: string) => request<CampaignSession>(`/api/agent/session/${id}`)

export const createCampaign = (sourceTaskId: string, prompt: string) =>
  post<CampaignSession>('/api/agent/session', { source_task_id: sourceTaskId, prompt })

export function confirmCampaign(id: string, markets: { code: string; voice?: string }[]) {
  const s = loadSettings()
  return post<CampaignSession>(`/api/agent/session/${id}/confirm`, {
    markets,
    duration_mode: s.durationMode || 'adaptive',
    original_audio_volume: s.originalAudioVolume ?? 0.2,
    stream_mode: s.streamMode || 'streaming',
  })
}

export const reviewMarket = (id: string, code: string) =>
  post<{ review: MarketReview; copy: { platforms: PlatformCopy[] } }>(
    `/api/agent/session/${id}/markets/${code}/review`,
  )

export const applyMarket = (id: string, code: string, edits: { index: number; text: string }[], continueRender = true) =>
  post<CampaignSession>(`/api/agent/session/${id}/markets/${code}/apply`, {
    edits,
    continue_render: continueRender,
  })

export const sendCampaignMessage = (id: string, market: string, message: string) =>
  post<{ reply: string; changes: RevisionChange[] }>(`/api/agent/session/${id}/message`, { market, message })

export const getBundleUrl = (id: string) => apiUrl(`/api/agent/session/${id}/bundle`)
