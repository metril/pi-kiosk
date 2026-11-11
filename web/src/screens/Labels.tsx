import { useEffect, useRef, useState } from 'react'
import { Star, RotateCw, X } from 'lucide-react'
import { api, thumbs, ApiError, type LabelJob } from '../api'
import { usePoll } from '../hooks'
import { Spinner, Title, Pager, useToast, errMsg } from '../components/ui'

const DONE = ['done', 'failed', 'canceled']

function JobToast({ id, onClose }: { id: string; onClose: () => void }) {
  const [job, setJob] = useState<LabelJob | null>(null)
  const toast = useToast()
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose
  const toastRef = useRef(toast); toastRef.current = toast
  useEffect(() => {
    let alive = true
    let finished = false
    let inflight = false
    let closeT: ReturnType<typeof setTimeout> | undefined
    const ctl = new AbortController()
    const tick = async () => {
      if (inflight || finished) return
      inflight = true
      try {
        const j = await api.labelJob(id, ctl.signal)
        if (!alive || finished) return
        setJob(j)
        if (DONE.includes(j.status)) {
          finished = true
          clearInterval(t)
          if (j.status === 'failed') toastRef.current(j.error || 'Print failed')
          closeT = setTimeout(() => { if (alive) onCloseRef.current() }, j.status === 'done' ? 1500 : 3000)
        }
      } catch { /* shown globally */ } finally { inflight = false }
    }
    const t = setInterval(tick, 1000); tick()
    return () => { alive = false; clearInterval(t); clearTimeout(closeT); ctl.abort() }
  }, [id])
  const st = job?.status ?? 'queued'
  const color = st === 'done' ? 'bg-ok text-black' : st === 'failed' ? 'bg-err text-white' : st === 'canceled' ? 'bg-warn text-black' : 'bg-acc text-black'
  return (
    <div className={`absolute top-2 left-2 right-2 z-20 rounded-xl px-4 flex items-center gap-3 min-h-[64px] font-bold text-xl shadow-lg ${color}`}>
      {!DONE.includes(st) && <Spinner />}
      <span className="flex-1 capitalize">{st === 'done' ? 'Printed' : st === 'queued' ? 'Queued…' : st}{job?.label_count ? ` · ${job.label_count} label${job.label_count > 1 ? 's' : ''}` : ''}</span>
      {!DONE.includes(st)
        ? <button className="btn btn-err min-h-[48px]" onClick={() => api.cancelLabel(id).catch(() => {})}><X />Cancel</button>
        : <button className="btn min-h-[48px] text-white" onClick={onClose}>OK</button>}
    </div>
  )
}

export default function Labels() {
  const presets = usePoll(api.presets, 60000)
  const hist = usePoll(() => api.history(10), 15000)
  const [job, setJob] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const start = async (fn: () => Promise<{ job_id: string }>) => {
    if (busy) return
    setBusy(true)
    try { setJob((await fn()).job_id) } catch (e) { if (!(e instanceof ApiError)) toast(errMsg(e)) } finally { setBusy(false) }
  }
  const list = [...(presets.data ?? [])].sort((a, b) => Number(b.favorite) - Number(a.favorite))
  return (
    <div className="h-full flex flex-col relative">
      <Title>Labels</Title>
      {job && <JobToast id={job} onClose={() => setJob(null)} />}
      <Pager cols={3} rows={2} className="h-[212px] shrink-0"
        items={list.length ? list.map((p) => (
          <button key={p.id} disabled={busy} onClick={() => start(() => api.printPreset(p.id))}
            className="btn flex-col !items-start !justify-center !gap-0 text-left min-w-0">
            <span className="flex items-center gap-1 w-full"><span className="truncate">{p.name}</span>{p.favorite && <Star size={16} className="text-warn shrink-0" fill="currentColor" />}</span>
            <span className="text-sm text-slate-400 font-normal">{p.tape_width_mm ? `${p.tape_width_mm}mm ` : ''}{p.label_type}</span>
          </button>
        )) : [<div key="none" className="col-span-3 text-slate-400 text-lg p-4">{presets.data ? 'No presets saved.' : ''}</div>]} />
      <div className="text-slate-300 font-semibold leading-none my-1">Recent</div>
      <div className="flex gap-2 overflow-hidden flex-1 min-h-0">
        {(hist.data?.items ?? []).slice(0, 5).map((h) => (
          <div key={h.id} className="bg-panel border border-line rounded-xl p-1 flex flex-col items-center w-[136px] shrink-0">
            <div className="h-12 w-full bg-white rounded flex items-center justify-center overflow-hidden">
              <img src={thumbs.label(h.id)} alt="" className="max-h-12 max-w-full object-contain" />
            </div>
            <button className="btn w-full mt-1 !px-1 text-base" disabled={busy} onClick={() => start(() => api.reprint(h.id))}>
              <RotateCw size={18} />Again
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
