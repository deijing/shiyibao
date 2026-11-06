import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Download,
  Film,
  Loader2,
  Maximize2,
  Package,
  PlayCircle,
  MessageSquareText,
  ShieldAlert,
  Ship,
  Sparkles,
} from 'lucide-react'
import {
  checkExportSecurity,
  getExportUrl,
  getOriginalTrackUrl,
  getTaskStatus,
  getThumbnailUrl,
  getVideoUrl,
  type SecurityAction,
  type TaskStatus,
} from '@/lib/api'
import { exportWithSecurityCheck, useOriginalTrack, useOriginalVolume } from '@/lib/original-track'
import OriginalVolumeControl from '../OriginalVolumeControl'
import SecurityHoldPanel from '../SecurityHoldPanel'
import {
  confirmCampaign,
  formatMediaDuration,
  getBundleUrl,
  getCampaign,
  getSampleVideoUrl,
  getSessionSecurity,
  listMarkets,
  resolveAssetUrl,
  resolveSessionSecurity,
  type CampaignMarket,
  type CampaignSession,
  type MarketInfo,
  type SessionSecurityPayload,
} from '@/lib/agent-api'
import ReviewPanel, { CopyPanel } from './ReviewPanel'

const VOICE_OPTIONS = ['Chloe', 'Mia', 'Milo', 'Dean', '冰糖', '茉莉', '苏打', '白桦']
const SCENARIO_LABEL: Record<string, string> = { ecommerce: '跨境电商 / 品牌出海', culture: '文化出海', general: '通用视频出海' }
const LANG_LABEL: Record<string, string> = {
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  de: '德语',
  fr: '法语',
  es: '西语',
  ar: '阿语',
  auto: '自动检测',
}
const IDLE_STAGES = new Set(['planned', 'awaiting_review', 'security_hold', 'complete', 'error', 'missing'])
const KIND_DOT: Record<string, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-[var(--sail-red)]',
  api: 'bg-[var(--sail-blue)]',
  info: 'bg-slate-400',
}

function stageLabel(market: CampaignMarket): string {
  switch (market.stage) {
    case 'planned':
      return '待执行'
    case 'awaiting_review':
      return '待审核'
    case 'security_hold':
      return '安全拦截'
    case 'complete':
      return '已完成'
    case 'error':
      return '失败'
    case 'missing':
      return '已删除'
    default:
      return `${market.progress ?? 0}%`
  }
}

export default function CampaignPage() {
  const { campaignId = '' } = useParams<{ campaignId: string }>()
  // 按会话 id 重挂载：切换会话时清空上一个会话的选择、当前市场和在途请求结果。
  return <CampaignView key={campaignId} campaignId={campaignId} />
}

function CampaignView({ campaignId }: { campaignId: string }) {
  const [session, setSessionState] = useState<CampaignSession | null>(null)
  const [catalog, setCatalog] = useState<MarketInfo[]>([])
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [activeCode, setActiveCode] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 每次写入会话都递增版本号；轮询返回时若版本已变（期间有更新的写入），丢弃这份旧快照，
  // 否则「应用修改」后，一个早先发出的轮询会把市场状态写回 awaiting_review。
  const version = useRef(0)
  const setSession = useCallback((next: CampaignSession) => {
    version.current += 1
    setSessionState(next)
  }, [])

  const refresh = useCallback(async () => {
    const started = version.current
    try {
      const data = await getCampaign(campaignId)
      if (version.current !== started) return
      setSession(data)
      setError(null)
    } catch (err) {
      if (version.current !== started) return
      setError(err instanceof Error ? err.message : '加载会话失败')
    }
  }, [campaignId, setSession])

  useEffect(() => {
    void refresh()
    listMarkets().then(setCatalog).catch(() => setCatalog([]))
  }, [refresh])

  // 计划阶段：用 Agent 规划的市场与音色初始化选择（只做一次，之后允许用户全部取消再自选）。
  const selectionInitialized = useRef(false)
  useEffect(() => {
    if (session?.status === 'planned' && !selectionInitialized.current) {
      selectionInitialized.current = true
      setSelected(Object.fromEntries(session.plan.markets.map((m) => [m.code, m.voice])))
    }
  }, [session])

  // 出境安全闸：会话被拦截时拉取源台词的命中详情
  const [sessionSecurity, setSessionSecurity] = useState<SessionSecurityPayload | null>(null)
  const sessionStatus = session?.status
  useEffect(() => {
    if (sessionStatus !== 'security_hold') return
    let cancelled = false
    getSessionSecurity(campaignId)
      .then((data) => { if (!cancelled) setSessionSecurity(data) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : '读取安全检测结果失败') })
    return () => { cancelled = true }
  }, [sessionStatus, campaignId])

  const markets = useMemo(() => (session ? Object.values(session.markets) : []), [session])
  const isRunning = markets.some((m) => !IDLE_STAGES.has(m.stage))

  useEffect(() => {
    if (!session || session.status === 'planned') return
    if (!isRunning) return
    const timer = window.setInterval(() => void refresh(), 2500)
    return () => window.clearInterval(timer)
  }, [session, isRunning, refresh])

  useEffect(() => {
    if (markets.length > 0 && (!activeCode || !session?.markets[activeCode])) {
      setActiveCode(markets[0].code)
    }
  }, [markets, activeCode, session])

  const toggleMarket = (info: MarketInfo) => {
    setSelected((prev) => {
      const next = { ...prev }
      if (next[info.code]) delete next[info.code]
      else next[info.code] = info.voice
      return next
    })
  }

  const handleConfirm = async () => {
    if (!session) return
    setConfirming(true)
    setError(null)
    try {
      const updated = await confirmCampaign(
        session.id,
        Object.entries(selected).map(([code, voice]) => ({ code, voice })),
      )
      setSession(updated)
      setActiveCode(Object.keys(updated.markets)[0] ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败')
    } finally {
      setConfirming(false)
    }
  }

  const handleSecurityResolve = async (action: SecurityAction, note: string, includeWarn: boolean) => {
    if (!session) return
    const payload = await resolveSessionSecurity(session.id, { action, note, include_warn: includeWarn })
    setSessionSecurity(payload)
    if (payload.session) setSession(payload.session)
    await refresh()
  }

  const checkBundleSecurity = async (): Promise<string | null> => {
    if (!session) return null
    try {
      const data = await getSessionSecurity(session.id)
      const blocked = Object.entries(data.markets)
        .filter(([, m]) => m.report?.level === 'block')
        .map(([code]) => session.markets[code]?.name ?? code)
      if (blocked.length === 0) return null
      return `出境安全闸：${blocked.join('、')} 的字幕复检仍有未处置的敏感信息，请到对应市场的精修工作台处置后再打包。`
    } catch {
      return null
    }
  }

  if (!session) {
    return (
      <div className="sail-home min-h-[60vh] flex items-center justify-center">
        {error ? (
          <div className="text-center space-y-3">
            <p className="text-[var(--sail-red)]">{error}</p>
            <Link to="/" className="sail-ghost">返回出海工作台</Link>
          </div>
        ) : (
          <Loader2 className="w-6 h-6 animate-spin text-[var(--sail-blue)]" />
        )}
      </div>
    )
  }

  const active = activeCode ? session.markets[activeCode] : undefined
  const intent = session.intent
  const anyFinal = markets.some((m) => m.has_final)
  const media = session.source_media
  const sourceVideoUrl = media?.preview_task_id === session.source_task_id
    ? getVideoUrl(session.source_task_id)
    : media?.sample_id
      ? getSampleVideoUrl(media.sample_id, 'source')
      : media?.has_video
        ? getVideoUrl(session.source_task_id)
        : null
  const posterUrl = media?.poster
    ? resolveAssetUrl(media.poster)
    : media?.cover
      ? resolveAssetUrl(media.cover)
      : media?.preview_task_id
        ? getThumbnailUrl(media.preview_task_id)
        : undefined
  const durationLabel = formatMediaDuration(media?.duration)

  return (
    <div className="sail-home">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> 出海工作台
        </Link>

        {/* 源视频预览与需求意图 */}
        <div className="sail-card p-5 sm:p-6">
          <div className="grid gap-5 md:grid-cols-[288px_1fr] items-center">
            <div className="aspect-video rounded-xl overflow-hidden bg-[#0a1324] border border-[var(--sail-border)] relative shadow-sm">
              {sourceVideoUrl ? (
                <>
                  <video
                    src={sourceVideoUrl}
                    poster={posterUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full h-full object-cover bg-black"
                  />
                  <span className="sail-glass-pill absolute left-2.5 top-2.5 pointer-events-none">
                    {media?.sample_id ? '文化样片 · 原片' : '原片预览'}
                  </span>
                </>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-4 text-center bg-gradient-to-br from-[#0c1b36] to-[#132c52] text-white/80 relative">
                  {posterUrl && (
                    <>
                      <img
                        src={posterUrl}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover"
                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                      />
                      <div className="absolute inset-0 bg-[#06192c]/70 backdrop-blur-[1px]" />
                    </>
                  )}
                  <Film className="w-6 h-6 opacity-75 relative" />
                  <p className="text-xs font-medium relative">原片本地缓存已清理</p>
                  <p className="text-[11px] text-white/55 relative">会话轨迹、审核与文案仍可正常查看</p>
                </div>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="sail-eyebrow">
                  <span className="sail-dot" /> 出海任务 · {media?.title || session.source_filename || session.source_task_id.slice(0, 8)}
                </p>
                {media?.sample_id && (
                  <span className="sail-meta-pill">
                    <Sparkles className="w-3 h-3 text-[var(--sail-blue)]" /> 免上传体验样片
                  </span>
                )}
              </div>

              <h1 className="text-lg sm:text-xl font-bold leading-snug">「{session.prompt}」</h1>

              {(durationLabel || (media?.width && media?.height) || media?.source_lang || media?.segment_count) && (
                <div className="flex flex-wrap items-center gap-2">
                  {durationLabel && (
                    <span className="sail-meta-pill sail-tabular">
                      <Clock className="w-3 h-3 text-[var(--sail-blue)]" /> {durationLabel}
                    </span>
                  )}
                  {media?.width && media?.height && (
                    <span className="sail-meta-pill sail-tabular">
                      <Maximize2 className="w-3 h-3 text-[var(--sail-blue)]" /> {media.width}×{media.height}
                    </span>
                  )}
                  {media?.source_lang && (
                    <span className="sail-meta-pill">
                      原声：{LANG_LABEL[media.source_lang] ?? media.source_lang.toUpperCase()}
                    </span>
                  )}
                  {Boolean(media?.segment_count) && (
                    <span className="sail-meta-pill sail-tabular">
                      {media?.segment_count} 句识别台词
                    </span>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-1.5 text-xs">
                <span className="sail-chip">场景：{SCENARIO_LABEL[intent.scenario] ?? intent.scenario}</span>
                {intent.subject && <span className="sail-chip">主题：{intent.subject}</span>}
                {intent.audience && <span className="sail-chip">受众：{intent.audience}</span>}
                {intent.tone && <span className="sail-chip">语气：{intent.tone}</span>}
                {intent.keep_terms.length > 0 && <span className="sail-chip">保留术语：{intent.keep_terms.join('、')}</span>}
                <span className="sail-chip">意图解析：{intent.source === 'llm' ? '大模型' : '内置规则'}</span>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <p className="text-sm text-[var(--sail-red)] flex items-center gap-2"><AlertTriangle className="w-4 h-4" />{error}</p>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-6 min-w-0">
            {session.status === 'planned' ? (
              <PlanCard
                session={session}
                catalog={catalog}
                selected={selected}
                confirming={confirming}
                onToggle={toggleMarket}
                onVoice={(code, voice) => setSelected((prev) => ({ ...prev, [code]: voice }))}
                onConfirm={handleConfirm}
              />
            ) : (
              <>
                {session.status === 'security_hold' && (
                  <SecurityHoldPanel
                    payload={sessionSecurity?.source ?? null}
                    loading={!sessionSecurity}
                    scopeHint={`所有市场共用同一份源台词，处置一次即对 ${markets.length} 个市场生效。`}
                    onResolve={handleSecurityResolve}
                  />
                )}

                {/* 市场标签 */}
                <div className="flex flex-wrap items-center gap-2">
                  {markets.map((m) => (
                    <button
                      key={m.code}
                      type="button"
                      onClick={() => setActiveCode(m.code)}
                      className={`sail-tab ${m.code === activeCode ? 'is-active' : ''}`}
                    >
                      <span>{m.flag} {m.name}</span>
                      <span className={`sail-tab-badge stage-${m.stage}`}>{stageLabel(m)}</span>
                    </button>
                  ))}
                  <div className="flex-1" />
                  <a
                    href={getBundleUrl(session.id)}
                    onClick={exportWithSecurityCheck(undefined, checkBundleSecurity, setError)}
                    className={`sail-primary ${anyFinal ? '' : 'opacity-60'}`}
                    title="打包下载所有市场的成片、字幕、文案与 Agent 执行轨迹"
                  >
                    <Package className="w-4 h-4" /> 下载出海素材包
                  </a>
                </div>

                {active && (
                  <MarketView
                    session={session}
                    market={active}
                    sourceVideoUrl={sourceVideoUrl}
                    onSessionChange={setSession}
                    onRefresh={refresh}
                  />
                )}
              </>
            )}
          </div>

          <Timeline session={session} />
        </div>
      </div>
    </div>
  )
}

function PlanCard({
  session,
  catalog,
  selected,
  confirming,
  onToggle,
  onVoice,
  onConfirm,
}: {
  session: CampaignSession
  catalog: MarketInfo[]
  selected: Record<string, string>
  confirming: boolean
  onToggle: (info: MarketInfo) => void
  onVoice: (code: string, voice: string) => void
  onConfirm: () => void
}) {
  const lastAgent = [...session.messages].reverse().find((m) => m.role === 'agent')
  const options = catalog.length > 0 ? catalog : (session.plan.markets as unknown as MarketInfo[])
  return (
    <div className="sail-card p-6 space-y-5">
      <div className="flex items-start gap-3">
        <MessageSquareText className="w-5 h-5 mt-0.5 text-[var(--sail-blue)] shrink-0" />
        <p className="text-sm">{lastAgent?.content}</p>
      </div>

      <div>
        <h3 className="font-semibold mb-3">执行计划</h3>
        <ol className="grid gap-2 sm:grid-cols-2">
          {session.plan.steps.map((step, i) => (
            <li key={step.key} className="sail-step">
              <span className="sail-step-no">{i + 1}</span>
              <div>
                <p className="font-medium text-sm">{step.title}</p>
                <p className="text-xs text-muted-foreground">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h3 className="font-semibold mb-3">目标市场与配音音色（可调整）</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((info) => {
            const checked = Boolean(selected[info.code])
            return (
              <div key={info.code} className={`sail-market ${checked ? 'is-active' : ''}`}>
                <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                  <input type="checkbox" checked={checked} onChange={() => onToggle(info)} className="accent-[var(--sail-blue)]" />
                  <span className="truncate">{info.flag} {info.name}</span>
                  <span className="text-xs text-muted-foreground uppercase">{info.lang}</span>
                </label>
                {checked && (
                  <select
                    value={selected[info.code]}
                    onChange={(e) => onVoice(info.code, e.target.value)}
                    className="sail-input text-xs py-1"
                    aria-label={`${info.name} 配音音色`}
                  >
                    {VOICE_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {session.plan.markets.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">查看各市场本地化指令（Agent 生成）</summary>
          <div className="mt-2 space-y-2">
            {session.plan.markets.map((m) => (
              <pre key={m.code} className="whitespace-pre-wrap rounded-lg bg-[var(--sail-soft)] p-3">{m.flag} {m.name}{'\n'}{m.brief}</pre>
            ))}
          </div>
        </details>
      )}

      <button
        type="button"
        onClick={onConfirm}
        disabled={confirming || Object.keys(selected).length === 0}
        className="sail-primary w-full"
      >
        {confirming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ship className="w-4 h-4" />}
        确认计划，开始出海（{Object.keys(selected).length} 个市场）
      </button>
    </div>
  )
}

function MarketView({
  session,
  market,
  sourceVideoUrl,
  onSessionChange,
  onRefresh,
}: {
  session: CampaignSession
  market: CampaignMarket
  sourceVideoUrl: string | null
  onSessionChange: (s: CampaignSession) => void
  onRefresh: () => void
}) {
  const reviewable = market.stage === 'awaiting_review' || market.stage === 'complete'
  const [downloadError, setDownloadError] = useState<string | null>(null)

  return (
    <div className="space-y-5">
      {!reviewable && (
        <div className="sail-card p-5">
          {market.stage === 'security_hold' ? (
            <div className="text-sm flex items-start gap-2 text-rose-700 dark:text-rose-300">
              <ShieldAlert className="w-4 h-4 mt-0.5" />
              <div>
                <p className="font-semibold">{market.flag} {market.name} 已被出境安全闸拦截</p>
                <p className="mt-1 text-muted-foreground">源台词中检测到疑似敏感信息，尚未发送给翻译模型。请在上方「出境安全闸」面板处置后自动继续。</p>
              </div>
            </div>
          ) : market.stage === 'error' || market.stage === 'missing' ? (
            <div className="text-sm text-[var(--sail-red)] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5" />
              <div>
                <p className="font-semibold">{market.flag} {market.name} 处理失败</p>
                <p className="mt-1">{market.error || market.message}</p>
                {market.task_id && (
                  <Link to={`/task/${market.task_id}`} className="underline mt-2 inline-block">查看子任务日志</Link>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--sail-blue)]" />
                  {market.flag} {market.name} · {market.message || '排队中'}
                </span>
                <span className="font-mono">{market.progress ?? 0}%</span>
              </div>
              <div className="mt-3 h-2 rounded-full bg-[var(--sail-soft)] overflow-hidden">
                <div className="h-full bg-[var(--sail-blue)] transition-all" style={{ width: `${market.progress ?? 0}%` }} />
              </div>
              {market.task_id && (
                <Link to={`/task/${market.task_id}`} className="mt-3 inline-block text-xs text-muted-foreground underline">
                  查看实时处理日志
                </Link>
              )}
            </div>
          )}
        </div>
      )}

      {market.stage === 'complete' && market.task_id && (
        <div className="sail-card p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              {market.flag} {market.name} 成片{market.video_title ? ` · ${market.video_title}` : ''}
            </h3>
            <div className="flex gap-2">
              <Link to={`/task/${market.task_id}`} className="sail-ghost"><PlayCircle className="w-3.5 h-3.5" /> 精修工作台</Link>
              <a
                href={getExportUrl(market.task_id)}
                onClick={exportWithSecurityCheck(market.task_id, () => checkExportSecurity(market.task_id!), setDownloadError)}
                className="sail-ghost"
              >
                <Download className="w-3.5 h-3.5" /> 下载成片
              </a>
            </div>
          </div>
          {downloadError && (
            <p className="text-xs text-[var(--sail-red)] flex items-start gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                {downloadError}{' '}
                <Link to={`/task/${market.task_id}`} className="underline">去精修工作台修改字幕</Link>
              </span>
            </p>
          )}
          <MarketVideo
            key={`${market.task_id}-${market.applied_edits}`}
            taskId={market.task_id}
            marketLabel={`${market.flag} ${market.name} 译配`}
            sourceVideoUrl={sourceVideoUrl}
          />
        </div>
      )}

      {reviewable && (
        // 按市场重挂载：切换市场时丢弃上一个市场未提交的草稿和对话，避免误把日文编辑应用到美国版。
        <ReviewPanel key={`review-${market.code}`} session={session} market={market} onSessionChange={onSessionChange} onRefresh={onRefresh} />
      )}

      <CopyPanel key={`copy-${market.code}`} market={market} />
    </div>
  )
}

/** 成片播放：视频只含配音，原声单独跟随播放，可实时调节音量；支持一键切换原片同帧对照。 */
function MarketVideo({
  taskId,
  marketLabel,
  sourceVideoUrl,
}: {
  taskId: string
  marketLabel: string
  sourceVideoUrl: string | null
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingSyncRef = useRef<{ time: number; autoPlay: boolean } | null>(null)
  const [mode, setMode] = useState<'dubbed' | 'source'>('dubbed')
  const [status, setStatus] = useState<TaskStatus | null>(null)
  useEffect(() => { getTaskStatus(taskId).then(setStatus).catch(() => {}) }, [taskId])
  const hasOriginalTrack = Boolean(status?.separate_original && status?.original_track)
  const [originalVolume, setOriginalVolume] = useOriginalVolume(taskId, status?.original_audio_volume)
  const getMaster = useCallback(() => {
    const el = videoRef.current
    if (!el) return null
    return { time: el.currentTime, playing: !el.paused && !el.ended, rate: el.playbackRate, volume: el.muted ? 0 : el.volume }
  }, [])
  useOriginalTrack(
    mode === 'dubbed' && hasOriginalTrack ? getOriginalTrackUrl(taskId) : null,
    getMaster,
    originalVolume,
  )

  const switchMode = (next: 'dubbed' | 'source') => {
    if (next === mode) return
    const el = videoRef.current
    pendingSyncRef.current = {
      time: el ? el.currentTime : 0,
      autoPlay: el ? !el.paused && !el.ended : false,
    }
    setMode(next)
  }

  const handleLoadedMetadata = () => {
    const sync = pendingSyncRef.current
    const el = videoRef.current
    if (!sync || !el) return
    pendingSyncRef.current = null
    if (sync.time > 0 && Number.isFinite(el.duration)) {
      el.currentTime = Math.min(sync.time, Math.max(0, el.duration - 0.1))
    }
    if (sync.autoPlay) {
      el.play().catch(() => {})
    }
  }

  const activeSrc = mode === 'source' && sourceVideoUrl ? sourceVideoUrl : getVideoUrl(taskId)

  return (
    <div className="space-y-2.5">
      {sourceVideoUrl && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="sail-ab-switch" role="tablist" aria-label="成片与原片对照切换">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'dubbed'}
              onClick={() => switchMode('dubbed')}
              className={`sail-ab-btn ${mode === 'dubbed' ? 'is-active' : ''}`}
            >
              {marketLabel}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'source'}
              onClick={() => switchMode('source')}
              className={`sail-ab-btn ${mode === 'source' ? 'is-active' : ''}`}
            >
              🇨🇳 中文原片对照
            </button>
          </div>
          <span className="text-xs text-muted-foreground">切换时自动对齐播放时间轴</span>
        </div>
      )}
      <video
        ref={videoRef}
        src={activeSrc}
        controls
        playsInline
        onLoadedMetadata={handleLoadedMetadata}
        className="w-full rounded-xl bg-black max-h-[480px]"
      />
      {mode === 'dubbed' && hasOriginalTrack && (
        <div className="flex items-center justify-between gap-3">
          <OriginalVolumeControl value={originalVolume} onChange={setOriginalVolume} />
          <span className="text-xs text-slate-500">下载成片按当前原声音量混音</span>
        </div>
      )}
    </div>
  )
}

function Timeline({ session }: { session: CampaignSession }) {
  const items = [...session.timeline].reverse()
  return (
    <aside className="sail-card p-5 h-fit lg:sticky lg:top-24">
      <h3 className="font-semibold">Agent 执行轨迹</h3>
      <p className="text-xs text-muted-foreground mt-1">每一步决策与工具调用均可追溯，并随素材包导出</p>
      <ol className="mt-4 space-y-3 max-h-[70vh] overflow-y-auto pr-1">
        {items.length === 0 && <li className="text-xs text-muted-foreground">等待开始…</li>}
        {items.map((item, i) => {
          const market = item.market ? session.markets[item.market] : undefined
          return (
            <li key={`${item.ts}-${i}`} className="flex gap-3">
              <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${KIND_DOT[item.kind] ?? KIND_DOT.info}`} />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                  {new Date(item.ts).toLocaleTimeString()} · <span className="font-semibold text-foreground">{item.step}</span>
                  {market ? ` · ${market.flag}` : ''}
                </p>
                <p className="text-sm break-words">{item.detail}</p>
              </div>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
