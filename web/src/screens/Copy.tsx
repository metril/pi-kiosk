import { useState } from 'react'
import { Minus, Plus, Copy as CopyI } from 'lucide-react'
import { api, ApiError } from '../api'
import { setBusy as setB, isBusy, useBusy } from '../store'
import { Spinner, Title, useToast, errMsg } from '../components/ui'

export default function CopyScreen() {
  const toast = useToast()
  const [n, setN] = useState(1), [color, setColor] = useState(true), [duplex, setDuplex] = useState(false)
  const busy = useBusy().copy
  const clamp = (v: number) => Math.min(99, Math.max(1, v))
  const go = async () => {
    if (isBusy('copy')) return
    setB('copy', true)
    try { await api.copy({ copies: n, mode: color ? 'Color' : 'Gray', duplex }); toast('Copy finished', 'ok') }
    catch (e) { if (!(e instanceof ApiError)) toast(errMsg(e)) } finally { setB('copy', false) }
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
      <button className="btn btn-ok !min-h-[80px] text-3xl" disabled={busy} onClick={go}>
        {busy ? <><Spinner size={32} />Copying… please wait</> : <><CopyI size={32} />Copy</>}
      </button>
    </div>
  )
}
