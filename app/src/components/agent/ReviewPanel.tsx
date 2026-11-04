import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, Loader2, MessageSquare, Send, ShieldCheck, ScanSearch } from 'lucide-react'
import { getSubtitles, type SubtitleSegment } from '@/lib/api'
import {
  applyMarket,
  reviewMarket,
  sendCampaignMessage,
  type CampaignMarket,
  type CampaignSession,
  type ReviewIssue,
  type RevisionChange,
} from '@/lib/agent-api'

const SEVERITY_STYLE: Record<ReviewIssue['severity'], string> = {
  high: 'bg-[var(--sail-red)] text-white',
  medium: 'bg-amber-500 text-white',
  low: 'bg-slate-400 text-white',
}
const SEVERITY_LABEL: Record<ReviewIssue['severity'], string> = { high: '高风险', medium: '需关注', low: '建议' }
const CATEGORY_LABEL: Record<string, string> = {
  compliance: '广告合规',
  culture: '文化适配',
  accuracy: '翻译准确',
  fluency: '表达自然',
  terminology: '术语一致',
}

interface ReviewPanelProps {
  session: CampaignSession
  market: CampaignMarket
  onSessionChange: (session: CampaignSession) => void
  onRefresh: () => void
}

// 放在模块级而非组件内：面板按市场重挂载（切换标签页）后仍能知道「已自动审核过 / 审核进行中」，
// 否则来回切换市场会重复发起审核（重复调用大模型），按钮也会在审核进行中重新变成可点。
const autoReviewed = new Set<string>()
const reviewsInFlight = new Map<string, Promise<void>>()

export default function ReviewPanel({ session, market, onSessionChange, onRefresh }: ReviewPanelProps) {
  const reviewKey = `${session.id}:${market.code}`
  const [segments, setSegments] = useState<SubtitleSegment[]>([])
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [reviewing, setReviewing] = useState(() => reviewsInFlight.has(reviewKey))
  const [applying, setApplying] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composing = useRef(false)
  const taskId = market.task_id
  const review = market.review
  const isComplete = market.stage === 'complete'

  useEffect(() => {
    if (!taskId) return
    setEdits({})
    getSubtitles(taskId).then(setSegments).catch(() => setSegments([]))
  }, [taskId, market.stage, market.applied_edits])

  // 重挂载时若审核仍在进行，等它结束再恢复按钮。
  useEffect(() => {
    const inflight = reviewsInFlight.get(reviewKey)
    if (!inflight) return
    let alive = true
    void inflight.finally(() => { if (alive) setReviewing(false) })
    return () => { alive = false }
  }, [reviewKey])

  const runReview = async () => {
    if (reviewsInFlight.has(reviewKey)) return
    setReviewing(true)
    setError(null)
    const job = (async () => {
      try {
        await reviewMarket(session.id, market.code)
        onRefresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : '审核失败')
      } finally {
        reviewsInFlight.delete(reviewKey)
        setReviewing(false)
      }
    })()
    reviewsInFlight.set(reviewKey, job)
    await job
  }

  // 译文就绪后 Agent 主动发起审核，无需用户手动触发。
  useEffect(() => {
    if (market.stage === 'awaiting_review' && !review && !autoReviewed.has(reviewKey)) {
      autoReviewed.add(reviewKey)
      void runReview()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.stage, review, reviewKey])

  const acceptSuggestion = (index: number, text: string) => {
    if (!text.trim()) return
    setEdits((prev) => ({ ...prev, [index]: text }))
  }

  const acceptAllIssues = () => {
    const next: Record<number, string> = { ...edits }
    for (const issue of review?.issues ?? []) {
      if (issue.suggestion) next[issue.index] = issue.suggestion
    }
    setEdits(next)
  }

  const handleChat = async () => {
    const message = chatInput.trim()
    if (!message) return
    setChatBusy(true)
    setError(null)
    try {
      await sendCampaignMessage(session.id, market.code, message)
      setChatInput('')
      onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '对话修订失败')
    } finally {
      setChatBusy(false)
    }
  }

  const pendingEdits = useMemo(
    () =>
      Object.entries(edits)
        .map(([index, text]) => ({ index: Number(index), text: text.trim() }))
        .filter(({ index, text }) => text && text !== segments.find((s) => s.index === index)?.translated_text),
    [edits, segments],
  )

  const handleApply = async () => {
    setApplying(true)
    setError(null)
    try {
      const updated = await applyMarket(session.id, market.code, pendingEdits, true)
      onSessionChange(updated)
      setEdits({})
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败')
    } finally {
      setApplying(false)
    }
  }

  const marketMessages = session.messages.filter((m) => m.market === market.code)
  const issueByIndex = new Map((review?.issues ?? []).map((issue) => [issue.index, issue]))

  return (
    <div className="space-y-5">
      {/* 合规审核 */}
      <div className="sail-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[var(--sail-blue)]" />
            <h3 className="font-semibold">{market.flag} {market.name} · 合规与本地化审核</h3>
          </div>
          <div className="flex items-center gap-2">
            {review && (
              <span className="sail-score" title="本地化质量评分">
                {review.score}<small>/100</small>
              </span>
            )}
            <button type="button" onClick={runReview} disabled={reviewing} className="sail-ghost">
              {reviewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
              {review ? '重新审核' : '开始审核'}
            </button>
          </div>
        </div>

        {reviewing && !review && (
          <p className="mt-4 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Agent 正在对照 {market.name} 广告法规与文化习惯逐句审核…
          </p>
        )}

        {review && (
          <>
            <p className="mt-3 text-sm text-muted-foreground">{review.summary}</p>
            {review.issues.length > 0 && !isComplete && (
              <button type="button" onClick={acceptAllIssues} className="mt-3 sail-ghost">
                <Check className="w-3.5 h-3.5" /> 采纳全部建议
              </button>
            )}
            <ul className="mt-3 space-y-3">
              {review.issues.map((issue) => {
                const accepted = edits[issue.index] === issue.suggestion && !!issue.suggestion
                return (
                  <li key={`${issue.index}-${issue.source}`} className="rounded-xl border border-[var(--sail-rule)] p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`px-2 py-0.5 rounded-full font-semibold ${SEVERITY_STYLE[issue.severity]}`}>
                        {SEVERITY_LABEL[issue.severity]}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-[var(--sail-soft)]">
                        {CATEGORY_LABEL[issue.category] ?? issue.category}
                      </span>
                      <span className="text-muted-foreground">第 {issue.index + 1} 句</span>
                      {issue.source === 'rule' && <span className="text-muted-foreground">· 规则命中</span>}
                    </div>
                    <p className="mt-2 text-sm">{issue.reason}</p>
                    <p className="mt-2 text-sm line-through decoration-[var(--sail-red)]/60 text-muted-foreground">
                      {issue.original}
                    </p>
                    {issue.suggestion && (
                      <div className="mt-1 flex items-start justify-between gap-3">
                        <p className="text-sm font-medium text-[var(--sail-blue)]">→ {issue.suggestion}</p>
                        {!isComplete && (
                          <button
                            type="button"
                            onClick={() => acceptSuggestion(issue.index, issue.suggestion)}
                            className={`sail-ghost shrink-0 ${accepted ? 'is-active' : ''}`}
                          >
                            <Check className="w-3.5 h-3.5" /> {accepted ? '已采纳' : '采纳'}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer">审核依据（{review.rules.length} 条市场规则）</summary>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                {review.rules.map((rule) => <li key={rule}>{rule}</li>)}
              </ul>
            </details>
          </>
        )}
      </div>

      {/* 对话修订 */}
      <div className="sail-card p-5">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-[var(--sail-blue)]" />
          <h3 className="font-semibold">和 Agent 对话修改</h3>
        </div>
        <div className="mt-3 space-y-3 max-h-80 overflow-y-auto">
          {marketMessages.length === 0 && (
            <p className="text-xs text-muted-foreground">例如：「语气再活泼一点」「把价格换算成日元」「品牌名保持英文」</p>
          )}
          {marketMessages.map((msg, i) => (
            <div key={`${msg.ts}-${i}`} className={msg.role === 'user' ? 'text-right' : ''}>
              <div className={`inline-block max-w-[90%] text-left rounded-2xl px-3 py-2 text-sm ${
                msg.role === 'user' ? 'bg-[var(--sail-blue)] text-white' : 'bg-[var(--sail-soft)]'
              }`}>
                {msg.content}
              </div>
              {msg.changes && msg.changes.length > 0 && (
                <ChangeList changes={msg.changes} edits={edits} disabled={isComplete} onAccept={acceptSuggestion} />
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            // WebKit（Tauri 的 WKWebView）在提交输入法候选的那次回车 keydown 之前就触发了 compositionend，
            // isComposing 已是 false；再用 keyCode 229 和自己记录的组合状态兜底，避免回车上屏时把半句话发出去。
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { window.setTimeout(() => { composing.current = false }, 0) }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || composing.current) return
              if (chatBusy) return
              void handleChat()
            }}
            placeholder="告诉 Agent 你想怎么改…"
            className="sail-input flex-1"
            disabled={chatBusy}
            maxLength={1000}
          />
          <button type="button" onClick={handleChat} disabled={chatBusy || !chatInput.trim()} className="sail-primary px-4">
            {chatBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* 逐句译文 */}
      <div className="sail-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">逐句译文（可直接编辑）</h3>
          <span className="text-xs text-muted-foreground">{segments.length} 句 · 待提交修改 {pendingEdits.length} 处</span>
        </div>
        <div className="mt-3 max-h-[420px] overflow-y-auto divide-y divide-[var(--sail-rule)]">
          {segments.map((seg) => {
            const issue = issueByIndex.get(seg.index)
            const value = edits[seg.index] ?? seg.translated_text
            return (
              <div key={seg.index} className="py-2.5 grid gap-1.5 sm:grid-cols-[48px_1fr]">
                <span className={`text-xs font-mono pt-1 ${issue ? 'text-[var(--sail-red)] font-bold' : 'text-muted-foreground'}`}>
                  #{seg.index + 1}{issue ? ' ⚑' : ''}
                </span>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">{seg.source_text}</p>
                  <textarea
                    value={value}
                    rows={1}
                    disabled={applying}
                    onChange={(e) => setEdits((prev) => ({ ...prev, [seg.index]: e.target.value }))}
                    className={`sail-input w-full resize-y text-sm ${edits[seg.index] !== undefined && edits[seg.index] !== seg.translated_text ? 'is-edited' : ''}`}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {error && (
        <p className="text-sm text-[var(--sail-red)] flex items-center gap-2"><AlertTriangle className="w-4 h-4" />{error}</p>
      )}

      {(!isComplete || pendingEdits.length > 0) && (
        <button type="button" onClick={handleApply} disabled={applying} className="sail-primary w-full">
          {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {pendingEdits.length > 0
            ? `应用 ${pendingEdits.length} 处修改并${isComplete ? '重新' : ''}生成配音成片`
            : '确认译文，生成配音成片'}
        </button>
      )}
    </div>
  )
}

function ChangeList({
  changes,
  edits,
  disabled,
  onAccept,
}: {
  changes: RevisionChange[]
  edits: Record<number, string>
  disabled: boolean
  onAccept: (index: number, text: string) => void
}) {
  return (
    <ul className="mt-2 space-y-2 text-left">
      {changes.map((change) => {
        const accepted = edits[change.index] === change.suggestion
        return (
          <li key={change.index} className="rounded-xl border border-[var(--sail-rule)] p-2.5 text-xs">
            <p className="text-muted-foreground">第 {change.index + 1} 句 · {change.reason}</p>
            <p className="mt-1 line-through text-muted-foreground">{change.original}</p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="font-medium text-[var(--sail-blue)]">→ {change.suggestion}</p>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onAccept(change.index, change.suggestion)}
                  className={`sail-ghost shrink-0 ${accepted ? 'is-active' : ''}`}
                >
                  {accepted ? '已采纳' : '采纳'}
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function CopyPanel({ market }: { market: CampaignMarket }) {
  const [copied, setCopied] = useState<string | null>(null)
  const platforms = market.copy?.platforms ?? []
  if (platforms.length === 0) return null

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  }

  return (
    <div className="sail-card p-5">
      <h3 className="font-semibold">{market.flag} {market.name} · 平台发布文案</h3>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {platforms.map((p) => {
          const full = [p.titles[0], '', p.description, '', p.hashtags.join(' '), p.cta].filter(Boolean).join('\n')
          return (
            <div key={p.platform} className="rounded-xl border border-[var(--sail-rule)] p-4 text-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[var(--sail-blue)]">{p.platform}</span>
                <button type="button" onClick={() => copyText(p.platform, full)} className="sail-ghost">
                  <Copy className="w-3.5 h-3.5" /> {copied === p.platform ? '已复制' : '复制全部'}
                </button>
              </div>
              <ol className="list-decimal pl-5 space-y-1">
                {p.titles.map((t) => <li key={t}>{t}</li>)}
              </ol>
              {p.description && <p className="text-muted-foreground whitespace-pre-line">{p.description}</p>}
              {p.hashtags.length > 0 && <p className="text-[var(--sail-blue)]">{p.hashtags.join(' ')}</p>}
              {p.cta && <p className="font-medium">{p.cta}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
