import { useState } from 'react'
import { Minus, Plus, Copy as CopyI } from 'lucide-react'
import { api } from '../api'
import { setBusy as setB, startBusy, isBusy, useBusy, getBusyInfo } from '../store'
import { refreshStatus } from '../status'
import { failMsg, newId } from '../progress'
import JobOverlay from '../components/JobOverlay'
import { Title, useToast } from '../components/ui'

export default function CopyScreen() {
  const toast = useToast()
  const [n, setN] = useState(1), [color, setColor] = useState(true), [duplex, setDuplex] = useState(false)
  const busy = useBusy().copy
  const clamp = (v: number) => Math.min(99, Math.max(1, v))
  const go = async () => {
    if (isBusy('copy')) return
    const copy_id = newId()
    startBusy('copy', { title: 'Copying…', copyId: copy_id, line: `${n} ${n === 1 ? 'copy' : 'copies'} · ${color ? 'Color' : 'Gray'}${duplex ? ' · Duplex' : ''}` })
    try {
      const r: any = await api.copy({ copy_id, copies: n, mode: color ? 'Color' : 'Gray', duplex })
      if (r?.status === 'cancelled' || r?.job?.status === 'cancelled') toast('Copy cancelled', 'ok'); else toast('Copy finished', 'ok')
    }
    catch (e) {
      const m = failMsg(e, 'Copy', !!getBusyInfo('copy')?.cancelling)
      if (m) toast(m, m === 'Copy cancelled' ? 'ok' : 'err')
    } finally { setB('copy', false); refreshStatus() }
  }
  const seg = (on: boolean) => `btn flex-1 ${on ? 'btn-acc' : ''}`
  return (
    <div className="h-full flex flex-col gap-3 relative">
      <Title>Copy</Title>
      <div className="flex items-center justify-center gap-4">
        <button className="btn !w-24 !min-h-[80px]" disabled={busy} onClick={() => setN(clamp(n - 1))}><Minus size={36} /></button>
        <div className="text-center w-40"><div className="text-7xl font-bold">{n}</div><div className="text-slate-400">copies</div></div>
        <button className="btn !w-24 !min-h-[80px]" disabled={busy} onClick={() => setN(clamp(n + 1))}><Plus size={36} /></button>
      </div>
      <div className="flex gap-2">
        <button className={seg(color)} disabled={busy} onClick={() => setColor(true)}>Color</button>
        <button className={seg(!color)} disabled={busy} onClick={() => setColor(false)}>Gray</button>
        <button className={seg(duplex)} disabled={busy} onClick={() => setDuplex(!duplex)}>{duplex ? 'Duplex: on' : 'Duplex: off'}</button>
      </div>
      {busy && <JobOverlay kind="copy" />}
      <button className="btn btn-ok !min-h-[80px] text-3xl" disabled={busy} onClick={go}>
        <CopyI size={32} />Copy
      </button>
    </div>
  )
}
