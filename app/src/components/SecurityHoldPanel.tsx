import { useMemo, useState } from 'react'
import {
  ShieldAlert,
  ShieldCheck,
  EyeOff,
  UserCheck,
  XCircle,
  Loader2,
  Info,
  History,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import type { SecurityAction, SecurityAuditEntry, SecurityHit, TaskSecurityPayload } from '@/lib/api'

export interface SecurityHoldPanelProps {
  payload: TaskSecurityPayload | null
  loading?: boolean
  /** 当前所处的放行范围说明，如「Agent 会话共享源字幕」 */
  scopeHint?: string
  onResolve: (action: SecurityAction, note: string, includeWarn: boolean) => Promise<void>
  onAbort?: () => void
  abortLabel?: string
}

const ACTION_LABELS: Record<string, string> = {
  hold: '拦截（未发送云端）',
  acknowledge: '人工确认放行',
  redact: '一键脱敏',
  export_blocked: '导出前复检拦截',
}

const CATEGORY_TONE: Record<string, string> = {
  privacy: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
  classified: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
  military: 'bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/30',
  technology: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  geo: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30',
  custom: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30',
}

function formatTime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '标题'
  const total = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function formatTs(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function HitRow({ hit }: { hit: SecurityHit }) {
  const tone = CATEGORY_TONE[hit.category] ?? CATEGORY_TONE.custom
  return (
    <li
      className={`flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 p-3 rounded-xl border ${
        hit.cleared
          ? 'border-slate-200/70 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 opacity-70'
          : hit.severity === 'block'
          ? 'border-rose-200/80 dark:border-rose-900/70 bg-rose-50/50 dark:bg-rose-950/30'
          : 'border-amber-200/80 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-950/20'
      }`}
    >
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 w-10">{formatTime(hit.time)}</span>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border ${tone}`}>{hit.label}</span>
        {hit.cleared ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">已放行</span>
        ) : hit.severity === 'block' ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30">拦截</span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30">提醒</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-800 dark:text-slate-200 break-words">
          <span className="font-semibold">「{hit.match}」</span>
          <span className="text-slate-500 dark:text-slate-400"> · {hit.reason}</span>
        </p>
        {hit.excerpt && (
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 break-words line-clamp-2">{hit.excerpt}</p>
        )}
      </div>
    </li>
  )
}

/** 出境安全闸处置面板：列出命中项，提供一键脱敏 / 人工确认放行 / 终止三种处置。 */
export default function SecurityHoldPanel({ payload, loading, scopeHint, onResolve, onAbort, abortLabel }: SecurityHoldPanelProps) {
  const [note, setNote] = useState('')
  const [includeWarn, setIncludeWarn] = useState(false)
  const [busy, setBusy] = useState<SecurityAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [showAudit, setShowAudit] = useState(false)

  const report = payload?.report
  const hits = useMemo(() => {
    const list = report?.hits ?? []
    // 未处置的拦截项排最前，其次提醒，最后已放行
    const rank = (h: SecurityHit) => (h.cleared ? 2 : h.severity === 'block' ? 0 : 1)
    return [...list].sort((a, b) => rank(a) - rank(b))
  }, [report])
  const visibleHits = showAll ? hits : hits.slice(0, 8)
  const blocking = report?.blocking ?? 0
  const noteOk = note.trim().length >= 4

  async function run(action: SecurityAction) {
    if (action === 'acknowledge' && !noteOk) {
      setError('人工放行需填写不少于 4 个字的理由，将写入审计记录。')
      return
    }
    setBusy(action)
    setError(null)
    try {
      await onResolve(action, note.trim(), includeWarn)
    } catch (err) {
      setError(err instanceof Error ? err.message : '处置失败，请稍后重试')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="w-full max-w-4xl mb-6 rounded-2xl border border-rose-200/90 dark:border-rose-900/70 bg-white/95 dark:bg-slate-900/90 shadow-lg overflow-hidden animate-in fade-in slide-in-from-top-2">
      <header className="flex items-start gap-3 p-4 sm:p-5 bg-gradient-to-r from-rose-50 via-white to-white dark:from-rose-950/50 dark:via-slate-900 dark:to-slate-900 border-b border-rose-100 dark:border-rose-900/60">
        <div className="p-2 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 shrink-0">
          {blocking > 0 ? <ShieldAlert className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
        </div>
        <div className="min-w-0">
          <h3 className="font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100">
            出境安全闸 · {blocking > 0 ? `已拦截 ${blocking} 处疑似敏感信息` : '待处置项已清空'}
          </h3>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            检测在本机离线完成，命中后流程已暂停，<span className="font-semibold text-slate-800 dark:text-slate-200">尚未向任何云端模型发送台词</span>。
            请选择处置方式后继续。{scopeHint}
          </p>
          {report && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(report.by_category).map(([cat, count]) => {
                const label = hits.find((h) => h.category === cat)?.label ?? cat
                return (
                  <span key={cat} className={`text-[11px] px-2 py-0.5 rounded-md border ${CATEGORY_TONE[cat] ?? CATEGORY_TONE.custom}`}>
                    {label} × {count}
                  </span>
                )
              })}
              {report.cleared > 0 && (
                <span className="text-[11px] px-2 py-0.5 rounded-md border bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">
                  已放行 {report.cleared}
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="p-4 sm:p-5 space-y-4">
        {loading && !report ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" /> 正在本地复检…
          </div>
        ) : (
          <>
            <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {visibleHits.map((hit) => <HitRow key={hit.id} hit={hit} />)}
            </ul>
            {hits.length > 8 && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 flex items-center gap-1 cursor-pointer"
              >
                {showAll ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {showAll ? '收起' : `展开全部 ${hits.length} 处`}
              </button>
            )}
          </>
        )}

        <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-3 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400 flex gap-2">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
          <div className="space-y-1">
            <p>{report?.scope_note ?? '本地规则检测语音台词与标题，不上传任何内容；不识别画面中的证件、设施等视觉信息。'}</p>
            <p>一键脱敏只处理字幕文本（隐私 / 坐标 / 自定义词遮住命中片段，涉密与军事整句隐去）；<span className="font-semibold">原声音轨仍含原话</span>，导出时建议把原声音量调为 0。</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="block">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">处置理由（人工放行必填，≥4 字，写入审计记录）</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="例如：公开报道中的历史资料，已核实不涉密"
              className="mt-1 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-rose-500/30"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 sm:pb-3 cursor-pointer select-none">
            <input type="checkbox" checked={includeWarn} onChange={(e) => setIncludeWarn(e.target.checked)} className="accent-rose-600" />
            脱敏时一并处理「提醒」项
          </label>
        </div>

        {error && (
          <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => run('redact')}
            disabled={!!busy || !payload?.can_redact}
            title={payload?.can_redact ? '' : '已生成译文或成片，无法再脱敏源字幕；请编辑字幕后人工放行，或重新创建任务'}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white text-xs font-bold shadow-md active:scale-95 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'redact' ? <Loader2 className="w-4 h-4 animate-spin" /> : <EyeOff className="w-4 h-4" />}
            一键脱敏并继续
          </button>
          <button
            type="button"
            onClick={() => run('acknowledge')}
            disabled={!!busy || blocking === 0}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-bold active:scale-95 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'acknowledge' ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
            人工确认放行
          </button>
          {onAbort && (
            <button
              type="button"
              onClick={onAbort}
              disabled={!!busy}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 text-xs font-semibold cursor-pointer disabled:opacity-50"
            >
              <XCircle className="w-4 h-4" />
              {abortLabel ?? '终止，不出境'}
            </button>
          )}
        </div>

        {payload && payload.audit.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowAudit((v) => !v)}
              className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 flex items-center gap-1 cursor-pointer"
            >
              <History className="w-3.5 h-3.5" />
              审计记录（{payload.audit.length}）
              {showAudit ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            {showAudit && (
              <ol className="mt-2 space-y-1 text-[11px] text-slate-600 dark:text-slate-400">
                {[...payload.audit].reverse().map((entry: SecurityAuditEntry, i) => (
                  <li key={`${entry.ts}-${i}`} className="flex flex-wrap gap-x-2">
                    <span className="font-mono text-slate-400">{formatTs(entry.ts)}</span>
                    <span className="font-semibold text-slate-700 dark:text-slate-300">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                    {entry.target && <span>{entry.target}</span>}
                    {entry.blocking != null && <span>剩余拦截 {entry.blocking}</span>}
                    {entry.sentences != null && <span>脱敏 {entry.sentences} 句</span>}
                    {entry.note && <span className="text-slate-500">理由：{entry.note}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
