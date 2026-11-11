import type { ReactNode } from 'react'
import { useState } from 'react'
import { Printer, ScanLine, Tag, Pause, FolderOpen, Smartphone, Lock, FileText, Receipt, Image, Book, Mail, Folder, Archive, type LucideIcon } from 'lucide-react'
import { api, ApiError, type KioskPreset } from '../api'
import { usePoll } from '../hooks'
import { Title, Pager, Spinner, useToast, errMsg } from '../components/ui'
import { useConfig, setBusy, isBusy } from '../store'
import { ensureUnlocked } from '../session'
import { Qr } from '../components/Unlock'
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

const PRESET_ICONS: Record<string, LucideIcon> = { 'file-text': FileText, receipt: Receipt, image: Image, book: Book, mail: Mail, folder: Folder, archive: Archive, scan: ScanLine }

const cell = 'bg-panel border border-line rounded-xl px-3 py-2 text-left flex flex-col justify-between min-w-0 min-h-0 overflow-hidden active:bg-line relative h-full w-full'
function Tile({ icon, title, lvl, text, sub, onClick }: { icon: ReactNode; title: string; lvl: Lvl | null; text: string; sub?: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className={cell}>
      <div className="flex items-center gap-1.5 text-base text-slate-300 w-full [&_svg]:w-5 [&_svg]:h-5 [&_svg]:shrink-0">{icon}<span className="truncate">{title}</span></div>
      <div className="flex items-center gap-2 min-w-0 w-full">
        <span className={`w-4 h-4 rounded-full shrink-0 ${lvl ? bg[lvl] : 'bg-line'}`} />
        <span className="text-2xl font-bold leading-tight truncate">{text}</span>
      </div>
      <div className="text-sm text-slate-300 truncate w-full min-h-[20px]">{sub}</div>
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
  const cfg = useConfig(), toast = useToast()
  const [running, setRunning] = useState<string | null>(null)
  const [qr, setQr] = useState(false)
  const run = async (p: KioskPreset) => {
    if (running || isBusy('scan')) return
    setRunning(p.id); setBusy('scan', true)
    try {
      if (p.needs_unlock && !(await ensureUnlocked())) return
      const sc = p.scan ?? {}
      const s = await api.startScan({ resolution: 300, mode: 'Color', format: 'pdf', source: 'Flatbed', ...sc })
      if (s.status === 'failed') return toast(s.error_message || 'Scan failed')
      if (!p.targets.length) return toast('Scanned', 'ok')
      const r = await api.send({ scan_id: s.scan_id, targets: p.targets, post: p.post, delete_after: p.delete_after })
      toast(r.all_ok ? 'Scanned and sent' : 'Scanned, but some steps failed', r.all_ok ? 'ok' : 'err')
    } catch (e) { if (!(e instanceof ApiError)) toast(errMsg(e)) } finally { setRunning(null); setBusy('scan', false) }
  }
  const tiles: ReactNode[] = [
    <Tile key="pr" icon={<Printer />} title="Printer" lvl={p[0]} text={p[1]} sub={p[2]} />,
    <Tile key="sc" icon={<ScanLine />} title="Scanner" lvl={s[0]} text={s[1]} />,
    ...(cfg?.presets ?? []).map((p) => {
      const Ico = PRESET_ICONS[p.icon ?? ''] ?? ScanLine
      return (
        <button key={p.id} onClick={() => run(p)} disabled={!!running} className={`${cell} disabled:opacity-60`}>
          <div className="flex items-center gap-1.5 text-base text-slate-300 pr-6 [&_svg]:w-5 [&_svg]:h-5">{running === p.id ? <Spinner size={20} /> : <Ico />}<span className="truncate">Scan preset</span></div>
          <div className="text-xl font-bold leading-tight line-clamp-2">{p.label ?? p.id}</div>
          {(p.needs_unlock || p.targets.length > 0) && <Lock size={20} className="absolute top-2 right-2 text-warn" />}
        </button>
      )
    }),
    <Tile key="fi" icon={<FolderOpen />} title="Files" lvl={null} text="Browse" sub="Shares and cloud" onClick={() => go('files')} />,
    ...(cfg?.public_url ? [<Tile key="qr" icon={<Smartphone />} title="Print from phone" lvl={null} text="Show QR" onClick={() => setQr(true)} />] : []),
    <Tile key="lb" icon={<Tag />} title="Label maker" lvl={l[0]} text={l[1]} sub={l[2]} onClick={() => go('labels')} />,
    <Tile key="hj" icon={<Pause />} title="Held jobs" lvl={n === undefined ? null : n > 0 ? 'warn' : 'ok'} text={n === undefined ? '…' : String(n)} sub={n ? 'Tap to release' : 'Nothing waiting'} onClick={() => go('queue')} />,
  ]
  return (
    <div className="h-full flex flex-col relative">
      <Title>Home</Title>
      <Pager items={tiles} cols={4} rows={3} className="flex-1" />
      {qr && cfg?.public_url && (
        <div className="fixed inset-0 z-30 bg-black/90 flex items-center justify-center" onClick={() => setQr(false)}>
          <div className="bg-panel border border-line rounded-2xl p-4 flex items-center gap-4">
            <Qr text={cfg.public_url} size={280} />
            <div className="flex flex-col gap-2 w-[360px]">
              <div className="text-2xl font-bold">Scan to print from your phone</div>
              <div className="text-slate-300 break-all">{cfg.public_url}</div>
              <div className="text-slate-400">Tap anywhere to close. Jobs appear in Queue.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
