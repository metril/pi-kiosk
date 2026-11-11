import { useCallback, useEffect, useRef, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { useConfig, useAsleep } from '../store'
import { useSession, getSession, setSession, wasUnlocked } from '../session'
import { Qr } from './Unlock'
import { Spinner } from './ui'

const Dot = ({ ok, label }: { ok: boolean | undefined; label: string }) => (
  <span className="flex items-center gap-2 text-lg text-slate-300">
    <span className={`w-4 h-4 rounded-full ${ok === undefined ? 'bg-line' : ok ? 'bg-ok' : 'bg-err'}`} />{label}
  </span>
)

/** Mounted only while awake, so readiness polling stops when the screen sleeps. */
function Ready() {
  const { data } = usePoll((sg) => api.kioskStatus(sg), 15000)
  return <div className="flex gap-6"><Dot ok={data?.printer_ready} label="Printer" /><Dot ok={data?.scanner_ready} label="Scanner" /></div>
}

function Clock() {
  const [t, setT] = useState(() => new Date())
  useEffect(() => { const i = setInterval(() => setT(new Date()), 5000); return () => clearInterval(i) }, [])
  return <span className="text-4xl font-bold tabular-nums">{t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
}

/** Full-screen sign-in. The device-grant flow starts on first touch/wake and restarts only while awake. */
export default function LockScreen() {
  const s = useSession(), cfg = useConfig(), asleep = useAsleep()
  const [err, setErr] = useState('')
  const armed = useRef(wasUnlocked())  // touched since the screen last slept
  const awake = useRef(!asleep); awake.current = !asleep
  const next = useRef(0), busy = useRef(false), wasAsleep = useRef(asleep)

  const tick = useCallback(async () => {
    const st = getSession().state
    if (!armed.current || !awake.current || busy.current || Date.now() < next.current || st === 'pending' || st === 'unlocked') return
    busy.current = true
    try {
      if (st === 'denied') next.current = Date.now() + 5000
      setSession(await api.unlockStart()); setErr('')
    } catch (e: any) {
      const wait = e?.status === 429 ? e.retryAfter ?? 30 : 15
      next.current = Date.now() + wait * 1000
      setErr(e?.status === 429 ? 'Too many attempts, retrying shortly' : 'Sign-in service unreachable, retrying…')
    } finally { busy.current = false }
  }, [])
  const touch = () => { armed.current = true; tick() }

  useEffect(() => {
    if (asleep) armed.current = false
    else if (wasAsleep.current) { armed.current = true; tick() }  // the wake touch counts
    wasAsleep.current = asleep
  }, [asleep, tick])
  useEffect(() => { const i = setInterval(tick, 1000); return () => clearInterval(i) }, [tick])
  // Track server-side flow state (phone approval, expiry, HA lock).
  usePoll((sg) => api.unlockState(sg).then(setSession), 2000)

  const pending = s.state === 'pending' && s.qr_uri
  return (
    <div className="w-full h-full bg-bg flex flex-col p-4 gap-3" onPointerDown={touch}>
      <div className="flex items-center justify-between h-12 shrink-0">
        <h1 className="text-3xl font-bold truncate">{cfg?.name || 'Kiosk'}</h1>
        <Clock />
      </div>
      <div className="flex-1 min-h-0 bg-panel border border-line rounded-2xl flex items-center justify-center gap-8 px-6">
        {pending ? (
          <>
            <Qr text={s.qr_uri!} size={260} />
            <div className="flex flex-col gap-3 min-w-0">
              <div className="text-3xl font-bold flex items-center gap-2"><Smartphone size={32} />Sign in with your phone</div>
              <div className="text-lg text-slate-300">Scan the code, sign in, and enter</div>
              <div className="text-6xl font-bold tracking-[0.12em] text-acc">{s.user_code}</div>
              <div className="flex items-center gap-2 text-slate-400"><Spinner size={18} />Waiting for approval…</div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <Smartphone size={72} className="text-acc" />
            <div className="text-4xl font-bold">Sign in with your phone</div>
            <div className="text-xl text-slate-300">
              {err || (s.state === 'denied' ? 'Request denied. Touch the screen to retry.'
                : armed.current ? 'Getting your sign-in code…' : 'Touch the screen to start')}
            </div>
            {armed.current && !err && s.state !== 'denied' && <Spinner size={28} />}
          </div>
        )}
      </div>
      <div className="h-8 shrink-0 flex items-center justify-center">{!asleep && <Ready />}</div>
    </div>
  )
}
