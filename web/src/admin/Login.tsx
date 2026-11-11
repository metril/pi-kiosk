import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { ScanLine } from 'lucide-react'
import { api } from './api'
import { Spinner } from './ui'

interface Start { login_id: string; qr_uri: string; user_code: string; expires_in: number }
type St = 'idle' | 'pending' | 'forbidden' | 'denied' | 'expired' | 'error' | 'limited'

export default function Login({ onDone }: { onDone: () => void }) {
  const [g, setG] = useState<Start | null>(null)
  const [qr, setQr] = useState('')
  const [state, setState] = useState<St>('idle')
  const [left, setLeft] = useState(0)

  const start = useCallback(async () => {
    setState('idle')
    try {
      const s = await api<Start>('login/start', 'POST')
      setQr(await QRCode.toDataURL(s.qr_uri, { margin: 1, width: 360 }))
      setG(s); setLeft(s.expires_in); setState('pending')
    } catch (e: any) { setState(e.status === 429 ? 'limited' : 'error') }
  }, [])
  useEffect(() => { start() }, [start])

  useEffect(() => {
    if (state !== 'pending' || !g) return
    const t = setInterval(async () => {
      try {
        const r = await api<{ state: string }>(`login/${g.login_id}`)
        if (r.state === 'ok') onDone()
        else if (r.state === 'expired') start()
        else if (r.state !== 'pending') setState(r.state as St)
      } catch { start() }
    }, 1500)
    const c = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000)
    return () => { clearInterval(t); clearInterval(c) }
  }, [state, g, onDone, start])
  useEffect(() => { if (state === 'pending' && g && left === 0) start() }, [left, state, g, start])

  const msg: Record<string, string> = {
    forbidden: 'This account is not a Papyrus admin. Sign in with an admin account.', denied: 'Sign-in was denied in Papyrus.',
    error: 'Could not reach Papyrus. Check the connection and try again.', limited: 'Too many attempts. Wait a minute, then try again.', expired: 'The code expired.',
  }
  const R = 20, C = 2 * Math.PI * R, frac = g ? left / g.expires_in : 0
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card" style={{ width: 'min(420px,100%)', padding: '32px 28px', textAlign: 'center' }}>
        <span className="ico" style={{ margin: '0 auto 14px' }}><ScanLine size={22} /></span>
        <h1 className="card-t" style={{ fontSize: 21 }}>Kiosk admin</h1>
        <p className="card-d" style={{ margin: '6px auto 22px' }}>Scan the code with your phone to sign in with Papyrus. An admin account is required.</p>
        {state === 'pending' && g ? <>
          <div style={{ display: 'inline-block', padding: 12, background: '#fff', borderRadius: 14, border: '1px solid var(--line)' }}>
            <img src={qr} alt="Sign-in QR code" width={260} height={260} style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />
          </div>
          <p className="muted" style={{ margin: '18px 0 4px', fontSize: 13 }}>Or enter this code in Papyrus</p>
          <p className="mono" style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: '.18em', paddingLeft: '.18em' }}>{g.user_code}</p>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginTop: 18 }} role="timer" aria-label={`Code expires in ${mm}`}>
            <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden><circle cx="24" cy="24" r={R} fill="none" stroke="var(--line)" strokeWidth="4" />
              <circle cx="24" cy="24" r={R} fill="none" stroke="var(--acc)" strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 24 24)" style={{ transition: 'stroke-dashoffset 1s linear' }} /></svg>
            <span style={{ textAlign: 'left', fontSize: 13 }}><b className="mono" style={{ fontSize: 15 }}>{mm}</b><br /><span className="muted">Waiting for approval</span></span>
          </div>
        </> : msg[state] ? <>
          <p role="alert" style={{ color: 'var(--danger)', background: 'var(--dsoft)', padding: '10px 12px', borderRadius: 10, fontSize: 14 }}>{msg[state]}</p>
          <button className="btn btn-pri" onClick={start}>Try again</button>
        </> : <p className="muted" style={{ display: 'flex', gap: 8, justifyContent: 'center' }}><Spinner />Getting a sign-in code</p>}
      </div>
    </div>
  )
}
