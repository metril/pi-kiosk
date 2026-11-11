import { BusyOverlay } from './ui'
import { useBusy, useBusyInfo, patchBusyInfo, type BusyInfo, type BusyKey } from '../store'
import { useJob, cancelJob, cancelUnsupported } from '../progress'

function Inner({ kind, info }: { kind: BusyKey; info: BusyInfo }) {
  const job = useJob(kind, info)
  const live = kind === 'scan' || job.phase === 'scanning' || job.phase === 'printing'
  const canCancel = !!job.id && job.supported && live && !info.sending && !cancelUnsupported()
  const cancel = () => {
    if (!job.id) return
    patchBusyInfo(kind, { cancelling: true })
    // 202: the original POST ends with 409 once the device has stopped; keep "Cancelling…" until then
    cancelJob(kind, job.id).catch(() => patchBusyInfo(kind, { cancelling: false }))
  }
  const title = kind === 'copy' && job.phase === 'printing' ? 'Printing…' : kind === 'copy' && job.phase === 'scanning' ? 'Scanning original…' : info.title
  return <BusyOverlay title={title} line={info.line} startedAt={info.startedAt} pct={job.pct} page={job.page}
    hint={info.sending ? 'Almost done' : 'Please wait, do not open the scanner'} cancelling={info.cancelling}
    onCancel={canCancel || info.cancelling ? cancel : undefined} />
}

export default function JobOverlay({ kind }: { kind: BusyKey }) {
  const busy = useBusy(), info = useBusyInfo()[kind]
  return busy[kind] && info ? <Inner kind={kind} info={info} /> : null
}
