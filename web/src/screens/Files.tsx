import { useState } from 'react'
import { HardDrive, Cloud, Printer, Eye, X, Minus, Plus } from 'lucide-react'
import { api, dl } from '../api'
import Browse, { previewable, type Picked, type Src } from '../components/Browse'
import Viewer from '../components/Viewer'
import { Title, useToast, Spinner } from '../components/ui'

export default function Files() {
  const toast = useToast()
  const [src, setSrc] = useState<Src>('smb')
  const [f, setF] = useState<Picked | null>(null)
  const [view, setView] = useState(false)
  const [copies, setCopies] = useState(1), [duplex, setDuplex] = useState(false)
  const [busy, setBusy] = useState(false)

  const url = f && (f.src === 'smb' ? dl.smb(f.ref, f.path) : dl.cloud(f.ref, f.path, f.entry.id))
  const print = async () => {
    if (!f) return
    setBusy(true)
    try { await api.printRemote({ source: f.src, ref: f.ref, path: f.path, ...(f.src === 'cloud' && f.entry.id ? { file_id: f.entry.id } : {}), copies, duplex }); toast('Sent to printer', 'ok'); setF(null) }
    catch { /* toasted */ } finally { setBusy(false) }
  }
  const printBtn = <button className="btn btn-acc" disabled={busy} onClick={() => { setView(false); }}><Printer />Print</button>

  return (
    <div className="h-full flex flex-col gap-2 relative">
      <Title right={<div className="flex gap-2">
        <button className={`btn ${src === 'smb' ? 'btn-acc' : ''}`} onClick={() => setSrc('smb')}><HardDrive />Shares</button>
        <button className={`btn ${src === 'cloud' ? 'btn-acc' : ''}`} onClick={() => setSrc('cloud')}><Cloud />Cloud</button></div>}>Files</Title>
      <div className="flex-1 min-h-0"><Browse key={src} src={src} onFile={(p) => { setF(p); setView(false) }} /></div>
      {f && !view && (
        <div className="absolute inset-0 z-30 bg-black/85 flex items-center justify-center">
          <div className="bg-panel border border-line rounded-2xl p-4 w-[520px] flex flex-col gap-3">
            <div className="flex items-center justify-between text-xl font-bold gap-2"><span className="truncate">{f.entry.name}</span><button className="btn" onClick={() => setF(null)}><X /></button></div>
            {previewable(f.entry.name) ? <button className="btn" onClick={() => setView(true)}><Eye />Preview</button> : <div className="text-slate-400">Preview not available. Print only.</div>}
            <div className="flex items-center gap-2">
              <span className="text-lg w-20">Copies</span>
              <button className="btn" onClick={() => setCopies((c) => Math.max(1, c - 1))}><Minus /></button>
              <span className="text-2xl font-bold w-12 text-center">{copies}</span>
              <button className="btn" onClick={() => setCopies((c) => Math.min(99, c + 1))}><Plus /></button>
              <button className={`btn flex-1 ${duplex ? 'btn-acc' : ''}`} onClick={() => setDuplex(!duplex)}>Duplex</button>
            </div>
            <button className="btn btn-ok text-xl" disabled={busy} onClick={print}>{busy ? <Spinner /> : <Printer />}Print</button>
          </div>
        </div>
      )}
      {f && view && url && <Viewer src={url} title={f.entry.name} onClose={() => setView(false)} actions={printBtn} />}
    </div>
  )
}
