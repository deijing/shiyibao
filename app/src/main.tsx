import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { getRuntimeHealth } from './lib/api'

const Router = window.__SHIYIBAO_DESKTOP__ ? HashRouter : BrowserRouter

function DesktopBootstrap() {
  const [ready, setReady] = useState(!window.__SHIYIBAO_DESKTOP__)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => {
    setFailed(false)
    setAttempt((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!window.__SHIYIBAO_DESKTOP__) return

    let cancelled = false
    const deadline = Date.now() + 60_000

    const waitForBackend = async () => {
      while (!cancelled && Date.now() < deadline) {
        try {
          await getRuntimeHealth()
          if (!cancelled) setReady(true)
          return
        } catch {
          await new Promise((resolve) => window.setTimeout(resolve, 250))
        }
      }

      if (!cancelled) setFailed(true)
    }

    void waitForBackend()
    return () => {
      cancelled = true
    }
  }, [attempt])

  if (ready) return <App />

  return (
    <main className="desktop-bootstrap">
      <img className="desktop-bootstrap__logo" src="/logo.png" alt="视译宝" />
      <h1>视译宝</h1>
      {failed ? (
        <>
          {/* 外壳换端口重试时会重建窗口，这里的计时也随之重来；真正走到这一步说明
              外壳仍在重试，或已彻底放弃并弹过错误框——后者重试无用，得重开应用。 */}
          <p>本地服务尚未就绪。可再等一会儿重试；若已弹出启动失败提示，请退出应用后重新打开。</p>
          <button type="button" onClick={retry}>重新检测</button>
        </>
      ) : (
        <>
          <div className="desktop-bootstrap__spinner" aria-hidden="true" />
          <p>正在启动本地视频服务，首次启动可能需要几十秒…</p>
        </>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <DesktopBootstrap />
    </Router>
  </StrictMode>,
)
