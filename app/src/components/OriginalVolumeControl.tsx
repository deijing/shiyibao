import { AudioWaveform } from 'lucide-react'

interface OriginalVolumeControlProps {
  value: number
  onChange: (value: number) => void
  /** dark：叠在视频控制条上；light：放在视频下方 */
  variant?: 'dark' | 'light'
}

/** 原视频声音（底片原声）实时音量；成片导出按此值混音。 */
export default function OriginalVolumeControl({ value, onChange, variant = 'light' }: OriginalVolumeControlProps) {
  const percent = Math.round(value * 100)
  const dark = variant === 'dark'
  return (
    <label
      className={`flex items-center gap-2 select-none ${dark ? 'text-white/85' : 'text-slate-600 dark:text-slate-300'}`}
      title="原视频声音音量：拖动实时生效，导出成片时按此音量混入"
    >
      <AudioWaveform className="h-4 w-4 shrink-0" />
      <span className="text-[12px] font-medium whitespace-nowrap">原声</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
        className={`w-20 h-6 cursor-pointer ${dark ? 'accent-white' : 'accent-[var(--sail-blue,#0b4f8a)]'}`}
        aria-label="原视频声音音量"
      />
      <span className={`w-9 text-right font-mono text-[12px] ${dark ? 'text-white/70' : 'text-slate-500'}`}>{percent}%</span>
    </label>
  )
}
