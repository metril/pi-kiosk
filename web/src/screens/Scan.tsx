import { useEffect, useState } from 'react'
import { ScanLine, Send as SendI, X, FileText, Eye, Printer, Trash2 } from 'lucide-react'
import { api, thumbs, type Scan, type ScanProfile } from '../api'
import { usePoll } from '../hooks'
import { setBusy as setB, startBusy, isBusy, useBusy, getBusyInfo } from '../store'
import { refreshStatus } from '../status'
import { failMsg } from '../progress'
import JobOverlay from '../components/JobOverlay'
import SendPanel from '../components/Send'
import Viewer from '../components/Viewer'
import { Spinner, Title, Pager, useToast, ConfirmBtn } from '../components/ui'

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
  const [sendFor, setSendFor] = useState<Scan | null>(null)
  const [viewing, setViewing] = useState<Scan | null>(null)
  const [act, setAct] = useState<Scan | null>(null)
  const [copies, setCopies] = useState(1), [duplex, setDuplex] = useState(false), [pb, setPb] = useState(false)
  const profiles: ScanProfile[] = Array.isArray(prof.data) ? prof.data : prof.data?.items ?? []

  const pick = (p: ScanProfile) => { setSel(p.id); setSrc(p.source); setMode(p.color_mode); setRes(p.resolution); setFmt(p.format) }
  useEffect(() => { if (sel === null && profiles[0]) pick(profiles[0]) }, [profiles, sel])

  const scan = async () => {
    if (isBusy('scan')) return
    startBusy('scan', { title: 'Scanning…', line: `${src} · ${res} dpi · ${mode}` })
    try {
      let s = await api.startScan({ resolution: res, mode, format: src === 'ADF' ? 'pdf' : fmt, source: src })
      // POST /scans is synchronous; poll defensively in case a server returns early.
      for (let i = 0; s.status === 'scanning' && i < 300; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        s = (await api.scans(10)).items.find((x) => x.scan_id === s.scan_id) ?? s
      }
      if (s.status === 'failed') toast(s.error_message || 'Scan failed')
      else if (s.status === 'cancelled') toast('Scan cancelled', 'ok')
      else { toast(`Scanned ${s.page_count} page${s.page_count === 1 ? '' : 's'}`, 'ok'); setAct(s) }
      scans.refresh()
    } catch (e) {
      const m = failMsg(e, 'Scan', !!getBusyInfo('scan')?.cancelling)
      if (m) toast(m, m === 'Scan cancelled' ? 'ok' : 'err')
    } finally { setB('scan', false); refreshStatus() }
  }
  const print = async (s: Scan) => {
    setPb(true)
    try { await api.printScan(s.scan_id, copies, duplex); toast('Sent to printer', 'ok'); setAct(null) } catch { /* toasted */ } finally { setPb(false) }
  }
  const remove = async (s: Scan) => {
    try { await api.deleteScan(s.scan_id); setAct(null); scans.refresh() } catch { /* toasted */ }
  }

  return (
    <div className="h-full flex flex-col gap-2 relative">
      <Title>Scan</Title>
      <Pager compact cols={4} rows={1} className="h-[64px] shrink-0"
        items={profiles.length ? profiles.map((p) => (
          <button key={p.id} onClick={() => pick(p)} className={`btn min-w-0 ${sel === p.id ? 'btn-acc' : ''}`}><span className="truncate">{p.name}</span></button>
        )) : [<div key="none" className="text-slate-400 p-3 col-span-4">{prof.data ? 'No scan profiles' : ''}</div>]} />
      <div className="flex gap-2 shrink-0">
        <Cycle label="Source" value={src} opts={opts.data?.sources ?? ['Flatbed', 'ADF']} onChange={setSrc} />
        <Cycle label="Mode" value={mode} opts={opts.data?.modes ?? ['Color', 'Gray']} onChange={setMode} />
        <Cycle label="DPI" value={res} opts={opts.data?.resolutions ?? [150, 300, 600]} onChange={setRes} />
        <button className="btn btn-ok flex-[1.4] text-xl" disabled={busy} onClick={scan}>
          {busy ? <><Spinner />Scanning…</> : <><ScanLine />Scan</>}
        </button>
      </div>
      <div className="text-slate-300 font-semibold leading-none">Results</div>
      <div data-scroll className="flex gap-2 overflow-x-auto overflow-y-hidden flex-1 min-h-0">
        {(scans.data?.items ?? []).map((s) => (
          <div key={s.scan_id} className="bg-panel border border-line rounded-xl p-1 w-[120px] shrink-0 flex flex-col">
            <div className="flex-1 min-h-0 bg-slate-200 rounded flex items-center justify-center overflow-hidden relative">
              {s.status === 'completed' ? <button className="w-full h-full flex items-center justify-center" onClick={() => setAct(s)} aria-label="Scan actions"><img src={thumbs.scan(s.scan_id)} alt="" className="max-h-full max-w-full object-contain" /></button> : <FileText className={s.status === 'failed' ? 'text-err' : 'text-slate-500'} />}
            </div>
            <div className="text-xs text-slate-300 text-center py-0.5">{s.status === 'completed' ? `${s.page_count}p ${s.format}` : s.status}</div>
            <button className="btn !px-1" disabled={s.status !== 'completed'} onClick={() => setAct(s)}><SendI size={18} />Actions</button>
          </div>
        ))}
      </div>
      {busy && <JobOverlay kind="scan" />}
      {viewing && <Viewer src={`/papyrus/scans/${viewing.scan_id}/download`} title={`Scan ${viewing.page_count}p ${viewing.format}`} onClose={() => setViewing(null)} />}
      {sendFor && <SendPanel scanId={sendFor.scan_id} onClose={() => setSendFor(null)} onDeleted={scans.refresh} />}
      {act && (
        <div className="absolute inset-0 z-30 bg-black/85 flex items-center justify-center">
          <div className="bg-panel border border-line rounded-2xl p-3 w-[520px] flex flex-col gap-2">
            <div className="flex items-center justify-between text-xl font-bold">Scan {act.page_count}p {act.format}<button className="btn" onClick={() => setAct(null)} aria-label="Close"><X /></button></div>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn" onClick={() => { setViewing(act); setAct(null) }}><Eye />Preview</button>
              <button className="btn btn-acc" onClick={() => { setSendFor(act); setAct(null) }}><SendI />Send</button>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn" onClick={() => setCopies((c) => Math.max(1, c - 1))}>-</button><span className="text-2xl font-bold w-10 text-center">{copies}</span>
              <button className="btn" onClick={() => setCopies((c) => Math.min(99, c + 1))}>+</button>
              <button className={`btn ${duplex ? 'btn-acc' : ''}`} onClick={() => setDuplex(!duplex)}>Duplex</button>
              <button className="btn btn-ok flex-1" disabled={pb} onClick={() => print(act)}>{pb ? <Spinner /> : <Printer />}Print</button>
            </div>
            <ConfirmBtn label="Delete" icon={<Trash2 />} onConfirm={() => remove(act)} />
          </div>
        </div>
      )}
    </div>
  )
}
