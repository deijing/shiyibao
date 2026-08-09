import React, { useState } from 'react'
import { Copy, Check, Terminal } from 'lucide-react'

interface MarkdownRendererProps {
  content: string
  className?: string
}

function parseInlineFormatting(text: string) {
  // Regex to split on bold (**...**), inline code (`...`), italic (*...* or _..._), strikethrough (~~...~~)
  const tokens = text.split(/(\*\*.*?\*\*|`.*?`|\*.*?\*|_.*?_|~~.*?~~)/g)

  return tokens.map((token, i) => {
    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      return (
        <strong key={i} className="font-bold text-slate-900 dark:text-white">
          {token.slice(2, -2)}
        </strong>
      )
    }
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      return (
        <code
          key={i}
          className="bg-purple-50 dark:bg-purple-950/80 text-purple-800 dark:text-purple-300 px-1.5 py-0.5 rounded-md font-mono text-[11px] border border-purple-200 dark:border-purple-800/80 shadow-2xs mx-0.5"
        >
          {token.slice(1, -1)}
        </code>
      )
    }
    if (
      ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) &&
      token.length > 2
    ) {
      return (
        <em key={i} className="italic text-slate-700 dark:text-slate-300">
          {token.slice(1, -1)}
        </em>
      )
    }
    if (token.startsWith('~~') && token.endsWith('~~') && token.length > 4) {
      return (
        <del key={i} className="line-through opacity-70">
          {token.slice(2, -2)}
        </del>
      )
    }
    return token
  })
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="my-3 rounded-2xl overflow-hidden border border-slate-700/80 bg-slate-900 shadow-md">
      <div className="bg-slate-800/90 px-3.5 py-1.5 flex items-center justify-between border-b border-slate-700/60">
        <span className="text-[11px] font-mono text-purple-300 flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-purple-400" />
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="text-slate-400 hover:text-slate-200 text-[11px] flex items-center gap-1 cursor-pointer transition-colors px-2 py-0.5 rounded-md hover:bg-slate-700/60"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          {copied ? '已复制' : '复制代码'}
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-[11px] font-mono leading-relaxed text-slate-100 custom-scrollbar">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
  if (!content) return null

  const lines = content.split('\n')
  const elements: React.ReactNode[] = []

  let inCodeBlock = false
  let codeBuffer: string[] = []
  let codeLang = ''

  let inTable = false
  let tableHeader: string[] = []
  let tableRows: string[][] = []

  const flushTable = (keyIndex: number) => {
    if (!inTable) return
    elements.push(
      <div key={`table-${keyIndex}`} className="my-3 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700/80 shadow-2xs">
        <table className="w-full text-xs text-left border-collapse">
          <thead>
            <tr className="bg-purple-50/80 dark:bg-purple-950/60 border-b border-slate-200 dark:border-slate-700">
              {tableHeader.map((th, i) => (
                <th key={i} className="px-3.5 py-2 font-bold text-purple-950 dark:text-purple-200 border-r border-slate-200 dark:border-slate-700/60 last:border-r-0">
                  {parseInlineFormatting(th.trim())}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row, rIdx) => (
              <tr key={rIdx} className="border-b border-slate-100 dark:border-slate-800 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                {row.map((cell, cIdx) => (
                  <td key={cIdx} className="px-3.5 py-2 text-slate-800 dark:text-slate-200 border-r border-slate-100 dark:border-slate-800 last:border-r-0">
                    {parseInlineFormatting(cell.trim())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
    inTable = false
    tableHeader = []
    tableRows = []
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    const trimmed = line.trim()

    // 1. Code Block Fence (```)
    if (trimmed.startsWith('```')) {
      if (inTable) flushTable(idx)

      if (inCodeBlock) {
        // Close code block
        elements.push(<CodeBlock key={`code-${idx}`} code={codeBuffer.join('\n')} language={codeLang} />)
        inCodeBlock = false
        codeBuffer = []
        codeLang = ''
      } else {
        // Open code block
        inCodeBlock = true
        codeLang = trimmed.replace(/^```/, '').trim()
        codeBuffer = []
      }
      continue
    }

    if (inCodeBlock) {
      codeBuffer.push(line)
      continue
    }

    // 2. Tables (| col1 | col2 |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())

      // Skip delimiter row like |---|---|
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        continue
      }

      if (!inTable) {
        inTable = true
        tableHeader = cells
        tableRows = []
      } else {
        tableRows.push(cells)
      }
      continue
    } else if (inTable) {
      flushTable(idx)
    }

    // Empty line
    if (!trimmed) {
      elements.push(<div key={`blank-${idx}`} className="h-2" />)
      continue
    }

    // 3. Horizontal Rule
    if (/^(---|[*]{3,}|_{3,})$/.test(trimmed)) {
      elements.push(
        <hr key={`hr-${idx}`} className="my-3 border-t border-slate-200 dark:border-slate-700/80" />
      )
      continue
    }

    // 4. Headings
    if (trimmed.startsWith('# ')) {
      elements.push(
        <h2
          key={`h1-${idx}`}
          className="text-base font-extrabold text-purple-900 dark:text-purple-200 pt-3 pb-1.5 border-b border-purple-200/80 dark:border-purple-800/80 flex items-center gap-2"
        >
          {parseInlineFormatting(trimmed.replace(/^#\s+/, ''))}
        </h2>
      )
      continue
    }
    if (trimmed.startsWith('## ')) {
      elements.push(
        <h3
          key={`h2-${idx}`}
          className="text-sm font-bold text-purple-800 dark:text-purple-300 pt-2.5 pb-1 flex items-center gap-2"
        >
          {parseInlineFormatting(trimmed.replace(/^##\s+/, ''))}
        </h3>
      )
      continue
    }
    if (trimmed.startsWith('### ')) {
      elements.push(
        <h4
          key={`h3-${idx}`}
          className="text-xs font-bold text-slate-800 dark:text-slate-200 pt-2 pb-0.5"
        >
          {parseInlineFormatting(trimmed.replace(/^###\s+/, ''))}
        </h4>
      )
      continue
    }
    if (trimmed.startsWith('#### ')) {
      elements.push(
        <h5
          key={`h4-${idx}`}
          className="text-xs font-semibold text-slate-700 dark:text-slate-300 pt-1"
        >
          {parseInlineFormatting(trimmed.replace(/^####\s+/, ''))}
        </h5>
      )
      continue
    }

    // 5. Blockquote
    if (trimmed.startsWith('> ')) {
      elements.push(
        <blockquote
          key={`quote-${idx}`}
          className="p-3 my-2 rounded-xl bg-purple-50/90 dark:bg-purple-950/50 border-l-4 border-purple-500 text-purple-950 dark:text-purple-200 text-xs italic shadow-2xs"
        >
          {parseInlineFormatting(trimmed.replace(/^>\s+/, ''))}
        </blockquote>
      )
      continue
    }

    // 6. Unordered List
    if (/^[-*+]\s+/.test(trimmed)) {
      const itemText = trimmed.replace(/^[-*+]\s+/, '')
      elements.push(
        <div key={`ul-${idx}`} className="flex items-start gap-2.5 pl-1 py-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-500 dark:bg-purple-400 shrink-0 mt-1.5" />
          <div className="flex-1 text-xs text-slate-800 dark:text-slate-200 leading-relaxed">
            {parseInlineFormatting(itemText)}
          </div>
        </div>
      )
      continue
    }

    // 7. Numbered List
    if (/^\d+\.\s+/.test(trimmed)) {
      const numMatch = trimmed.match(/^(\d+)\.\s+/)
      const num = numMatch ? numMatch[1] : '1'
      const itemText = trimmed.replace(/^\d+\.\s+/, '')
      elements.push(
        <div key={`ol-${idx}`} className="flex items-start gap-2.5 pl-1 py-0.5">
          <span className="text-[10px] font-bold font-mono text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-950/80 px-1.5 py-0.2 rounded-md shrink-0 border border-purple-200 dark:border-purple-800/60">
            {num}.
          </span>
          <div className="flex-1 text-xs text-slate-800 dark:text-slate-200 leading-relaxed">
            {parseInlineFormatting(itemText)}
          </div>
        </div>
      )
      continue
    }

    // Normal Paragraph
    elements.push(
      <p key={`p-${idx}`} className="text-xs text-slate-800 dark:text-slate-200 leading-relaxed py-0.5 font-normal">
        {parseInlineFormatting(trimmed)}
      </p>
    )
  }

  if (inTable) flushTable(lines.length)

  return <div className={`space-y-1 select-text ${className}`}>{elements}</div>
}
