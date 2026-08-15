import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = { children: ReactNode }
type State = { error: Error | null }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('AppErrorBoundary', error, info.componentStack)
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleHome = () => {
    this.setState({ error: null })
    if (window.__SHIYIBAO_DESKTOP__) {
      window.location.hash = '#/'
      window.location.reload()
      return
    }
    window.location.assign('/')
  }

  render() {
    if (!this.state.error) {
      return (
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          {this.props.children}
        </div>
      )
    }

    return (
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <div className="space-y-2">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            页面出现异常
          </h1>
          <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
            交互组件或数据解析出错。可刷新页面恢复，或返回首页重新开始。
          </p>
        </div>
        <pre className="max-w-lg overflow-auto rounded-xl bg-slate-100 px-3 py-2 text-left text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {this.state.error.message}
        </pre>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={this.handleReload}>刷新页面</Button>
          <Button variant="outline" onClick={this.handleHome}>
            返回首页
          </Button>
        </div>
      </div>
    )
  }
}
