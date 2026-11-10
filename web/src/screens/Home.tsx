import type { ReactNode } from 'react'
import { Printer, ScanLine, Tag, Pause } from 'lucide-react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { Title } from '../components/ui'
import type { TabId } from '../App'

type Lvl = 'ok' | 'warn' | 'err'
const bg: Record<Lvl, string> = { ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err' }
const LABEL_ERR: Record<string, string> = {
  printer_busy: 'Printer busy with a job',
  printer_disconnected: 'Printer not connected (USB)',
  printer_io_error: 'USB communication error',
  status_timeout: 'Printer not answering',
  bridge_not_configured: 'Bridge not configured',
  bridge_unreachable: 'Bridge unreachable',
  bridge_cert_mismatch: 'Bridge certificate changed',
  bridge_unpaired: 'Bridge not paired',
  bridge_busy: 'Bridge busy',
  bridge_error: 'Bridge error',
}

function Tile({ icon, title, lvl, text, sub, onClick }: { icon: ReactNode; title: string; lvl: Lvl | null; text: string; sub?: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="bg-panel border border-line rounded-2xl p-4 text-left flex flex-col gap-2 min-h-[150px] active:bg-line">
      <div className="flex items-center gap-2 text-lg text-slate-300">{icon}{title}</div>
      <div className="flex items-center gap-3">
        <span className={`w-6 h-6 rounded-full shrink-0 ${lvl ? bg[lvl] : 'bg-line'}`} />
        <span className="text-3xl font-bold leading-tight">{text}</span>
      </div>
      {sub && <div className="text-lg text-slate-300">{sub}</div>}
    </button>
  )
}

export default function Home({ go }: { go: (t: TabId) => void }) {
  const pr = usePoll(api.printerStatus, 10000)
  const sc = usePoll(api.scannerStatus, 10000)
  const lb = usePoll(api.labelStatus, 10000)
  const held = usePoll(api.heldJobs, 10000)

  let p: [Lvl | null, string, string?] = [null, 'Checking…']
  if (pr.data) {
    const d = pr.data
    p = d.state === 5 ? ['err', 'Stopped', d.state_message] : !d.accepting_jobs ? ['warn', 'Not accepting', d.state_message] : d.state === 4 ? ['ok', 'Printing'] : ['ok', 'Ready']
    const low = d.markers.filter((m) => m.level >= 0 && m.level <= 10)[0]
    if (low && p[0] === 'ok') p = ['warn', p[1], `${low.name} low (${low.level}%)`]
  } else if (pr.error) p = ['err', 'Unreachable']

  let s: [Lvl | null, string] = [null, 'Checking…']
  if (sc.data) s = !sc.data.available ? ['err', 'Offline'] : sc.data.busy ? ['warn', 'Busy'] : ['ok', 'Ready']
  else if (sc.error) s = ['err', 'Unreachable']

  let l: [Lvl | null, string, string?] = [null, 'Checking…']
  if (lb.data) {
    const d = lb.data
    const friendly = d.error_code ? LABEL_ERR[d.error_code] ?? d.error ?? d.error_code : undefined
    l = d.error_code === 'printer_busy' || d.error_code === 'bridge_busy' ? ['warn', 'Busy', friendly]
      : d.connected && !d.error_code ? ['ok', 'Ready'] : ['err', 'Problem', friendly ?? d.error ?? 'Not connected']
  } else if (lb.error) l = ['err', 'Unreachable']

  const n = held.data?.total
  return (
    <div className="h-full flex flex-col">
      <Title>Home</Title>
      <div className="grid grid-cols-2 gap-3 flex-1 pb-2 content-start">
        <Tile icon={<Printer />} title="Printer" lvl={p[0]} text={p[1]} sub={p[2]} />
        <Tile icon={<ScanLine />} title="Scanner" lvl={s[0]} text={s[1]} />
        <Tile icon={<Tag />} title="Label maker" lvl={l[0]} text={l[1]} sub={l[2]} onClick={() => go('labels')} />
        <Tile icon={<Pause />} title="Held jobs" lvl={n === undefined ? null : n > 0 ? 'warn' : 'ok'} text={n === undefined ? '…' : String(n)} sub={n ? 'Tap to release' : 'Nothing waiting'} onClick={() => go('queue')} />
      </div>
    </div>
  )
}
