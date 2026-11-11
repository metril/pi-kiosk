import { useEffect, useRef, useState } from 'react'
import { Lock, User } from 'lucide-react'
import QRCode from 'qrcode'
import { api } from '../api'
import { useSession, setSession } from '../session'

export function Qr({ text, size = 200 }: { text: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => { if (ref.current) QRCode.toCanvas(ref.current, text, { width: size, margin: 2 }).catch(() => {}) }, [text, size])
  return <canvas ref={ref} width={size} height={size} className="rounded-xl bg-white" style={{ width: size, height: size }} />
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
// Papyrus display_name, or an email/username turned into "First Last".
const friendly = (u?: string | null) => {
  if (!u) return "User"
  if (/\s/.test(u) && !u.includes("@")) return u
  return u.split("@")[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || u
}

/** Header chip; also pings /kiosk/unlock/touch (max every 15s) on touch while unlocked. */
export function SessionChip() {
  const s = useSession()
  const unlocked = s.state === 'unlocked'
  const [left, setLeft] = useState(0)
  const base = useRef({ at: 0, rem: 0 })
  const last = useRef(0)
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
    <div className="flex items-center gap-2 bg-panel border border-line rounded-xl pl-3 h-11 min-w-0">
      <User size={20} className="text-acc shrink-0" /><span className="font-semibold min-w-0 truncate">{friendly(s.user)}</span>
      <span className="text-slate-300 tabular-nums">{fmt(left)}</span>
      <button className="btn !min-h-[44px] h-11 !px-3 !rounded-l-none" onClick={() => api.lock().then(setSession).catch(() => {})}><Lock size={20} />Lock</button>
    </div>
  )
}
