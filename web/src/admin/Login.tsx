import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { api } from './api'

interface Start { login_id: string; qr_uri: string; user_code: string; expires_in: number }

export default function Login({ onDone }: { onDone: () => void }) {
  const [g, setG] = useState<Start | null>(null)
  const [qr, setQr] = useState('')
  const [state, setState] = useState<'idle' | 'pending' | 'forbidden' | 'denied' | 'expired' | 'error' | 'limited'>('idle')

  const start = useCallback(async () => {
    setState('idle')
    try {
      const s = await api<Start>('login/start', 'POST')
      setG(s); setState('pending')
      setQr(await QRCode.toDataURL(s.qr_uri, { margin: 1, width: 220 }))
    } catch (e: any) { setState(e.status === 429 ? 'limited' : 'error') }
  }, [])
  useEffect(() => { start() }, [start])

  useEffect(() => {
    if (state !== 'pending' || !g) return
    const t = setInterval(async () => {
      try {
        const r = await api<{ state: string }>(`login/${g.login_id}`)
        if (r.state === 'ok') onDone()
        else if (r.state !== 'pending') setState(r.state as any)
      } catch { setState('expired') }
    }, 1500)
    return () => clearInterval(t)
  }, [state, g, onDone])

  const msg: Record<string, string> = {
    forbidden: 'This account is not a Papyrus admin.', denied: 'Sign-in was denied.',
    expired: 'The code expired.', error: 'Could not reach Papyrus.', limited: 'Too many attempts, wait a minute.',
  }
  return (
    <div className="mx-auto flex min-h-screen max-w-sm items-center px-4">
      <div className="card w-full text-center">
        <h1 className="mb-1 text-lg font-semibold">Kiosk admin</h1>
        <p className="mb-4 text-sm text-slate-500">Sign in with your Papyrus account (admin role required).</p>
        {state === 'pending' && g && <>
          {qr && <img src={qr} alt="QR code" className="mx-auto rounded bg-white" width={220} height={220} />}
          <p className="mt-3 text-xs text-slate-500">Scan, or open Papyrus and enter</p>
          <p className="font-mono text-3xl font-bold tracking-widest">{g.user_code}</p>
          <p className="mt-2 text-xs text-slate-500">Waiting for approval...</p>
        </>}
        {msg[state] && <><p className="mb-3 text-sm text-red-600 dark:text-red-400">{msg[state]}</p><button className="btn btn-pri" onClick={start}>Try again</button></>}
      </div>
    </div>
  )
}
