import { useEffect, useRef, useState } from 'react'
import { X, Lock, User } from 'lucide-react'
import QRCode from 'qrcode'
import { api, type UnlockState } from '../api'
import { useSession, useUnlockOpen, setSession, closeUnlock } from '../session'
import { Spinner } from './ui'

export function Qr({ text, size = 200 }: { text: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => { if (ref.current) QRCode.toCanvas(ref.current, text, { width: size, margin: 2 }).catch(() => {}) }, [text, size])
  return <canvas ref={ref} width={size} height={size} className="rounded-xl bg-white" style={{ width: size, height: size }} />
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

export function UnlockModal() {
  const open = useUnlockOpen()
  const [st, setSt] = useState<UnlockState | null>(null)
  const [err, setErr] = useState('')
  const [left, setLeft] = useState(0)
  const startedAt = useRef(0)

  const start = async () => {
    setErr(''); setSt(null)
    try { const s = await api.unlockStart(); setSt(s); startedAt.current = Date.now(); setLeft(s.expires_in ?? 0); setSession(s) }
    catch (e: any) { setErr(e?.status === 429 ? 'Too many attempts, wait a moment' : 'Could not start unlock') }
  }
  useEffect(() => { if (open) start(); else setSt(null) }, [open])
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => api.unlockState().then((s) => { setSt((p) => (s.state === 'pending' ? { ...p, ...s } : s)); setSession(s) }).catch(() => {}), 2000)
    return () => clearInterval(t)
  }, [open])
  useEffect(() => {
    if (!open || st?.state !== 'pending') return
    const t = setInterval(() => setLeft(Math.max(0, (st.expires_in ?? 0) - Math.floor((Date.now() - startedAt.current) / 1000))), 1000)
    return () => clearInterval(t)
  }, [open, st?.state, st?.expires_in])
  if (!open) return null
  const pending = st?.state === 'pending'
  return (
    <div className="absolute inset-0 z-50 bg-black/90 flex items-center justify-center">
      <div className="bg-panel border border-line rounded-2xl p-4 w-[640px] relative">
        <button className="btn !min-h-[56px] absolute top-2 right-2" onClick={() => closeUnlock(false)} aria-label="Cancel"><X /></button>
        <div className="text-2xl font-bold mb-3 flex items-center gap-2"><Lock />Unlock with your phone</div>
        {pending && st?.qr_uri ? (
          <div className="flex gap-4 items-center">
            <Qr text={st.qr_uri} size={240} />
            <div className="flex flex-col gap-2">
              <div className="text-lg text-slate-300">Scan the code, sign in, and enter</div>
              <div className="text-5xl font-bold tracking-[0.15em] text-acc">{st.user_code}</div>
              <div className="text-lg text-slate-300">Expires in {fmt(left)}</div>
              <div className="flex items-center gap-2 text-slate-400"><Spinner size={18} />Waiting for approval…</div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-6">
            {err ? <div className="text-err text-xl">{err}</div>
              : st?.state === 'denied' ? <div className="text-err text-xl">Request denied</div>
              : st?.state === 'expired' ? <div className="text-warn text-xl">Code expired</div>
              : <Spinner size={40} />}
            {(err || st?.state === 'denied' || st?.state === 'expired') && <button className="btn btn-acc" onClick={start}>Try again</button>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Header chip; also pings /kiosk/unlock/touch (max every 15s) on touch while unlocked. */
export function SessionChip() {
  const s = useSession()
  const unlocked = s.state === 'unlocked'
  const [left, setLeft] = useState(0)
  const base = useRef({ at: 0, rem: 0 })
  const last = useRef(0)
  useEffect(() => {
    const t = setInterval(() => api.unlockState().then(setSession).catch(() => {}), 5000)
    api.unlockState().then(setSession).catch(() => {})
    return () => clearInterval(t)
  }, [])
  useEffect(() => { base.current = { at: Date.now(), rem: s.remaining_s ?? 0 }; setLeft(s.remaining_s ?? 0) }, [s.remaining_s, unlocked])
  useEffect(() => {
    if (!unlocked) return
    const t = setInterval(() => setLeft(Math.max(0, base.current.rem - Math.floor((Date.now() - base.current.at) / 1000))), 1000)
    const down = () => {
      const n = Date.now()
      if (n - last.current < 15_000) return
      last.current = n
      api.unlockTouch().then(setSession).catch(() => {})
    }
    window.addEventListener('pointerdown', down, true)
    return () => { clearInterval(t); window.removeEventListener('pointerdown', down, true) }
  }, [unlocked])
  if (!unlocked) return null
  return (
    <div className="absolute top-1 right-2 z-20 flex items-center gap-2 bg-panel border border-line rounded-xl pl-3 h-12">
      <User size={20} className="text-acc" /><span className="font-semibold max-w-[140px] truncate">{s.user || 'User'}</span>
      <span className="text-slate-300 tabular-nums">{fmt(left)}</span>
      <button className="btn !min-h-[48px] !min-w-[48px] !px-3 !rounded-l-none" onClick={() => api.lock().then(setSession).catch(() => {})}><Lock size={20} />Lock</button>
    </div>
  )
}
