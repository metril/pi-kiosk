import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api'
import type { BusyInfo, BusyKey } from './store'
import { errMsg } from './components/ui'

function useLoop(on: boolean, ms: number, fn: () => Promise<void>) {
  const f = useRef(fn); f.current = fn
  useEffect(() => {
    if (!on) return
    let live = true, busy = false
    const run = async () => { if (busy || !live) return; busy = true; try { await f.current() } catch { /* keep last */ } finally { busy = false } }
    run()
    const t = setInterval(run, ms)
    return () => { live = false; clearInterval(t) }
  }, [on, ms])
}

export interface Job { id?: string; pct: number | null; page: number | null; phase?: string; supported: boolean }
const NONE: Job = { pct: null, page: null, supported: false }
/** Epoch ms; naive timestamps are UTC. NaN if unparseable (then the item is accepted). */
const ts = (v: string) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(v) ? v : v + 'Z')
const pctOf = (v: unknown) => (typeof v === 'number' ? v : null)

/** Polls the running scan (newest 'scanning' item) or copy; supported=false on older Papyrus. */
export function useJob(kind: BusyKey, info: BusyInfo): Job {
  const [j, setJ] = useState<Job>(NONE)
  useLoop(!info.sending, 1000, async () => {
    if (kind === 'scan') {
      const it = (await api.scans(5)).items.find((s) => s.status === 'scanning' && !(ts(s.created_at) < info.startedAt - 5000))
      setJ(it ? { id: it.scan_id, pct: pctOf(it.progress_pct), page: it.page_count > 0 ? it.page_count : null, supported: 'progress_pct' in it } : NONE)
    } else if (info.copyId) {
      const c = await api.copyStatus(info.copyId)
      setJ({ id: info.copyId, pct: pctOf(c.progress_pct), page: null, phase: c.phase, supported: true })
    }
  })
  return j
}

/** Cancel is hidden for the session once Papyrus answers 404 (too old). */
let noCancel = false
export const cancelUnsupported = () => noCancel
export async function cancelJob(kind: BusyKey, id: string) {
  try { await (kind === 'scan' ? api.cancelScan(id) : api.cancelCopy(id)) }
  catch (e) { if (e instanceof ApiError && e.status === 404) noCancel = true; throw e }
}

/** Toast text for a failed scan/copy POST; null = say nothing. 409 after cancel is the expected outcome. */
export function failMsg(e: unknown, what: 'Scan' | 'Copy', cancelling: boolean): string | null {
  if (e instanceof ApiError) {
    if (e.code === 'locked') return null
    if (e.status === 409 && (cancelling || /cancel/i.test(e.code))) return `${what} cancelled`
    return e.message
  }
  return errMsg(e)
}

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c?.randomUUID) return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16) })
}
