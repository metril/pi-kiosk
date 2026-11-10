import { useCallback, useEffect, useRef, useState } from 'react'

/** Poll fn every ms; returns data/error/refresh. fn receives an AbortSignal. */
export function usePoll<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const f = useRef(fn); f.current = fn
  const alive = useRef(true)
  const seq = useRef(0)
  const inflight = useRef(false)
  const ctl = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    if (inflight.current || !alive.current) return
    inflight.current = true
    const my = ++seq.current
    const c = new AbortController(); ctl.current = c
    try {
      const d = await f.current(c.signal)
      if (alive.current && my === seq.current) { setData(d); setError(null) }
    } catch (e) {
      if (alive.current && my === seq.current && !c.signal.aborted) setError(e)
    } finally { inflight.current = false }
  }, [])
  useEffect(() => {
    alive.current = true
    refresh()
    const t = setInterval(refresh, ms)
    return () => { alive.current = false; clearInterval(t); ctl.current?.abort(); inflight.current = false; seq.current++ }
  }, [refresh, ms])
  return { data, error, refresh }
}
