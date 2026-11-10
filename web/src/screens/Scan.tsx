import { useEffect, useState } from 'react'
import { ScanLine, Send, X, FileText } from 'lucide-react'
import { api, thumbs, ApiError, type Scan, type ScanProfile, type KioskConfig } from '../api'
import { usePoll } from '../hooks'
import { setBusy as setB, isBusy, useBusy, useConfig } from '../store'
import { Spinner, Title, useToast, errMsg } from '../components/ui'

type Dest = { id: string; label: string; run: (id: string) => Promise<{ message: string }> }
function destinations(c: KioskConfig | null): Dest[] {
  const d = c?.destinations
  if (!d) return []
  const out: Dest[] = []
  if (d.paperless) out.push({ id: 'paperless', label: 'Paperless', run: (id) => api.sendScan(id, 'paperless', {}, undefined) })
  if (d.smb) { const m = d.smb; out.push({ id: 'smb', label: 'Network share', run: (id) => api.sendScan(id, 'smb', { share_id: m.share_id, remote_path: m.path }) }) }
  if (d.cloud) { const m = d.cloud; out.push({ id: 'cloud', label: 'Cloud', run: (id) => api.sendScan(id, 'cloud', { provider_id: m.provider_id }) }) }
  if (d.email) { const m = d.email; out.push({ id: 'email', label: 'Email', run: (id) => api.sendScan(id, 'email', {}, { to: m.to }) }) }
  return out
}

function Cycle({ label, value, opts, onChange }: { label: string; value: string | number; opts: (string | number)[]; onChange: (v: any) => void }) {
  const next = () => { if (opts.length) onChange(opts[(opts.indexOf(value) + 1) % opts.length]) }
  return (
    <button className="btn flex-col !gap-0 flex-1" onClick={next}>
      <span className="text-xs text-slate-400 font-normal">{label}</span>{value}
    </button>
  )
}

export default function ScanScreen() {
  const toast = useToast()
  const prof = usePoll(api.profiles, 60000)
  const opts = usePoll(api.scanOptions, 60000)
  const scans = usePoll(() => api.scans(10), 5000)
  const [sel, setSel] = useState<number | null>(null)
  const [src, setSrc] = useState('Flatbed'), [mode, setMode] = useState('Color'), [res, setRes] = useState(300), [fmt, setFmt] = useState('pdf')
  const busy = useBusy().scan
  const DESTS = destinations(useConfig())
  const [sendFor, setSendFor] = useState<Scan | null>(null)
  const [sending, setSending] = useState<string | null>(null)
  const profiles: ScanProfile[] = Array.isArray(prof.data) ? prof.data : prof.data?.items ?? []

  const pick = (p: ScanProfile) => { setSel(p.id); setSrc(p.source); setMode(p.color_mode); setRes(p.resolution); setFmt(p.format) }
  useEffect(() => { if (sel === null && profiles[0]) pick(profiles[0]) }, [profiles, sel])

  const scan = async () => {
    if (isBusy('scan')) return
    setB('scan', true)
    try {
      let s = await api.startScan({ resolution: res, mode, format: src === 'ADF' ? 'pdf' : fmt, source: src })
      // POST /scans is synchronous; poll defensively in case a server returns early.
      for (let i = 0; s.status === 'scanning' && i < 300; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        s = (await api.scans(10)).items.find((x) => x.scan_id === s.scan_id) ?? s
      }
      if (s.status === 'failed') toast(s.error_message || 'Scan failed')
      else toast(`Scanned ${s.page_count} page${s.page_count === 1 ? '' : 's'}`, 'ok')
      scans.refresh()
    } catch (e) { if (!(e instanceof ApiError)) toast(errMsg(e)) } finally { setB('scan', false) }
  }
  const send = async (d: Dest) => {
    if (!sendFor || sending) return
    setSending(d.id)
    try { toast((await d.run(sendFor.scan_id)).message || 'Sent', 'ok'); setSendFor(null) }
    catch (e) { if (!(e instanceof ApiError)) toast(errMsg(e)) } finally { setSending(null) }
  }

  return (
    <div className="h-full flex flex-col gap-2 relative">
      <Title>Scan</Title>
      <div className="flex gap-2 overflow-x-auto shrink-0 -mt-1">
        {profiles.map((p) => (
          <button key={p.id} onClick={() => pick(p)} className={`btn shrink-0 ${sel === p.id ? 'btn-acc' : ''}`}>{p.name}</button>
        ))}
        {prof.data && !profiles.length && <div className="text-slate-400 p-3">No scan profiles</div>}
      </div>
      <div className="flex gap-2 shrink-0">
        <Cycle label="Source" value={src} opts={opts.data?.sources ?? ['Flatbed', 'ADF']} onChange={setSrc} />
        <Cycle label="Mode" value={mode} opts={opts.data?.modes ?? ['Color', 'Gray']} onChange={setMode} />
        <Cycle label="DPI" value={res} opts={opts.data?.resolutions ?? [150, 300, 600]} onChange={setRes} />
        <button className="btn btn-ok flex-[1.4] text-xl" disabled={busy} onClick={scan}>
          {busy ? <><Spinner />Scanning…</> : <><ScanLine />Scan</>}
        </button>
      </div>
      <div className="text-slate-300 font-semibold">Results</div>
      <div className="flex gap-2 overflow-x-auto flex-1 min-h-0 pb-1">
        {(scans.data?.items ?? []).map((s) => (
          <div key={s.scan_id} className="bg-panel border border-line rounded-xl p-1 w-[120px] shrink-0 flex flex-col">
            <div className="flex-1 min-h-0 bg-slate-200 rounded flex items-center justify-center overflow-hidden relative">
              {s.status === 'completed' ? <img src={thumbs.scan(s.scan_id)} alt="" className="max-h-full max-w-full object-contain" /> : <FileText className={s.status === 'failed' ? 'text-err' : 'text-slate-500'} />}
            </div>
            <div className="text-xs text-slate-300 text-center py-0.5">{s.status === 'completed' ? `${s.page_count}p ${s.format}` : s.status}</div>
            <button className="btn !min-h-[56px] !px-1" disabled={s.status !== 'completed'} onClick={() => setSendFor(s)}><Send size={18} />Send</button>
          </div>
        ))}
      </div>
      {sendFor && (
        <div className="absolute inset-0 z-30 bg-black/85 flex items-center justify-center">
          <div className="bg-panel border border-line rounded-2xl p-4 w-[420px] flex flex-col gap-2">
            <div className="flex items-center justify-between text-xl font-bold">Send to<button className="btn !min-h-[56px]" onClick={() => setSendFor(null)}><X /></button></div>
            {!DESTS.length && <div className="text-slate-400 p-2">No destinations configured</div>}
            {DESTS.map((d) => <button key={d.id} className="btn btn-acc" disabled={!!sending} onClick={() => send(d)}>{sending === d.id ? <Spinner /> : null}{d.label}</button>)}
          </div>
        </div>
      )}
    </div>
  )
}
