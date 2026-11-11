import { useState } from 'react'
import { Play, Lock } from 'lucide-react'
import { api, ApiError, type Job } from '../api'
import { usePoll } from '../hooks'
import { refreshStatus } from '../status'
import { ConfirmBtn, PinPad, Title, useToast, errMsg } from '../components/ui'

export default function Queue() {
  const toast = useToast()
  const q = usePoll(api.heldJobs, 10000)
  const [pinFor, setPinFor] = useState<Job | null>(null)
  const [pinMsg, setPinMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const release = async (j: Job, pin?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await api.release(j.id, pin)
      toast('Released', 'ok'); setPinFor(null); setPinMsg(''); q.refresh(); refreshStatus()
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) { setPinFor(j); setPinMsg(pin ? 'Wrong PIN' : '') }
      else if (e instanceof ApiError && e.status === 429) { setPinFor(null); toast('Too many attempts. Try again in a few minutes.') }
      else toast(errMsg(e))
    } finally { setBusy(false) }
  }
  const cancel = async (j: Job) => { try { await api.cancelJob(j.id); q.refresh(); refreshStatus() } catch { /* toast shown */ } }
  const jobs = q.data?.items ?? []
  return (
    <div className="h-full flex flex-col relative">
      <Title right={<span className="text-slate-300 text-lg">{q.data ? `${q.data.total} held` : ''}</span>}>Queue</Title>
      <div data-scroll className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0">
        {q.data && !jobs.length && <div className="text-slate-400 text-xl p-6 text-center">No held jobs</div>}
        {jobs.map((j) => (
          <div key={j.id} className="bg-panel border border-line rounded-xl p-2 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-lg font-semibold truncate flex items-center gap-1">{j.has_pin && <Lock size={16} className="text-warn shrink-0" />}{j.title}</div>
              <div className="text-sm text-slate-400">{j.copies}x · {j.media}{j.duplex ? ' · duplex' : ''} · {j.source_type}</div>
            </div>
            <button className="btn btn-ok" disabled={busy} onClick={() => release(j)}><Play size={20} />Release</button>
            <ConfirmBtn label="Cancel" confirmLabel="Cancel job?" onConfirm={() => cancel(j)} />
          </div>
        ))}
      </div>
      {pinFor && <PinPad busy={busy} message={pinMsg} onCancel={() => setPinFor(null)} onSubmit={(p) => release(pinFor, p)} />}
    </div>
  )
}
