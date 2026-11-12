import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { api, ApiError, type LoginUser, type UnlockState } from '../api'
import { setSession } from '../session'
import { Keyboard, PinPad, Spinner } from './ui'

/** Recent users plus a "Someone else" search. `mode='pin'` limits to users with a PIN. */
function UserPicker({ mode, note, reloadKey, onPick, onSearching, onLeave }: {
  mode?: 'pin'; note?: string; reloadKey: number; onPick: (u: LoginUser) => void
  onSearching: (v: boolean) => void; onLeave: () => void
}) {
  const [recent, setRecent] = useState<LoginUser[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<LoginUser[] | null>(null)
  const [qFailed, setQFailed] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const ac = new AbortController()
    let tm: ReturnType<typeof setTimeout> | undefined
    api.unlockUsers({ mode }, ac.signal).then((u) => { setRecent(u); setFailed(false); if (!u.length) setSearching(true) })
      .catch(() => { if (!ac.signal.aborted) { setFailed(true); tm = setTimeout(() => setRetry((n) => n + 1), 3000) } })
    return () => { ac.abort(); clearTimeout(tm) }
  }, [mode, reloadKey, retry])
  useEffect(() => { onSearching(searching); return () => onSearching(false) }, [searching, onSearching])
  const term = q.trim()
  useEffect(() => {
    if (!searching || term.length < 2) { setHits(null); setQFailed(''); return }
    const ac = new AbortController()
    const t = setTimeout(() => {
      api.unlockUsers({ q: term, mode }, ac.signal).then((u) => { setHits(u); setQFailed('') }).catch((e) => { if (!ac.signal.aborted) setQFailed(e instanceof ApiError && e.code === 'rate_limited' ? 'Too many searches, wait a moment' : "Can't reach the user list") })
    }, 250)
    return () => { clearTimeout(t); ac.abort() }
  }, [term, searching, mode, reloadKey])
  const name = 'btn h-12 !min-h-[48px] !px-2 text-base leading-tight'
  const label = (u: LoginUser) => <span className="line-clamp-2 break-words text-center min-w-0">{u.display_name}</span>

  if (searching) return (
    <div className="w-full h-full flex flex-col gap-1.5 min-h-0">
      <div className="flex gap-1.5 shrink-0">
        <button className="btn !min-h-[44px] h-11 w-24" onClick={() => { if (recent?.length) { setSearching(false); setQ('') } else onLeave() }}>Back</button>
        <div className="flex-1 min-w-0 bg-bg rounded-xl h-11 px-3 flex items-center text-xl truncate" aria-label="Search">
          {q ? <span className="truncate whitespace-pre">{q}</span> : <span className="text-slate-500">Type a name…</span>}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1.5 content-start h-[94px] shrink-0">
        {hits?.length ? hits.map((u) => <button key={u.id} className={`btn h-11 !min-h-[44px] !px-1 text-sm leading-tight`} onClick={() => onPick(u)}>{label(u)}</button>)
          : <div className="col-span-4 text-slate-300 self-center text-center">{qFailed || note || (term.length < 2 ? 'Type at least 2 letters' : hits ? 'No matches' : '')}</div>}
      </div>
      <Keyboard value={q} onChange={setQ} />
    </div>
  )
  return (
    <div className="w-full h-full flex flex-col gap-2 min-h-0">
      <div className="flex items-center gap-2 shrink-0">
        <div className="text-2xl font-bold flex-1 truncate">Who are you?</div>
        <button className="btn h-12 !min-h-[48px]" onClick={() => setSearching(true)}>Someone else</button>
      </div>
      <div className="text-warn min-h-[24px] shrink-0 truncate">{note}</div>
      {failed && !recent ? <div className="text-lg text-slate-300">Can't load users, retrying…</div>
        : !recent ? <Spinner size={28} />
        : <div data-scroll className="flex-1 min-h-0 overflow-y-auto grid grid-cols-2 gap-2 content-start">
            {recent.map((u) => <button key={u.id} className={name} onClick={() => onPick(u)}>{label(u)}</button>)}
          </div>}
    </div>
  )
}

export function ApproveView({ s, onSearching, onLeave }: { s: UnlockState; onSearching: (v: boolean) => void; onLeave: () => void }) {
  const [rk, setRk] = useState(0)
  const reload = () => setRk((n) => n + 1)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = s.state === 'pending' && s.match_code
  const pick = async (u: LoginUser) => {
    if (busy) return
    setBusy(true); setNote('')
    try { setSession(await api.unlockApprove(u.id)) }
    catch (e) {
      const c = e instanceof ApiError ? e.code : ''
      setNote(c === 'unknown_user' ? 'That user is no longer available' : c === 'rate_limited' ? 'Too many requests, try again shortly' : c === 'request_rejected' ? 'A request is already waiting for that user' : 'Could not send the request')
      if (c === 'unknown_user') reload()
    } finally { setBusy(false) }
  }
  if (pending) return (
    <div className="flex items-center gap-10">
      <div className="text-[9rem] leading-none font-bold tabular-nums text-acc" aria-label="Match code">{s.match_code}</div>
      <div className="flex flex-col gap-3">
        <div className="text-3xl font-bold flex items-center gap-2"><ShieldCheck size={32} />Approve on your phone</div>
        <div className="text-lg text-slate-300">Pick this number on your phone</div>
        <div className="flex items-center gap-2 text-slate-400"><Spinner size={18} />Waiting for approval…</div>
        <button className="btn w-40" onClick={() => api.lock().then(setSession).catch(() => {})}>Cancel</button>
      </div>
    </div>
  )
  const msg = note || (s.state === 'denied' ? 'Request denied' : s.state === 'expired' ? 'Request expired, try again' : '')
  return <UserPicker note={msg} reloadKey={rk} onPick={pick} onSearching={onSearching} onLeave={onLeave} />
}

const mins = (s: number) => (s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${Math.max(1, Math.ceil(s))} seconds`)

export function PinView({ length, onSearching, onLeave }: { length: number; onSearching: (v: boolean) => void; onLeave: () => void }) {
  const [rk, setRk] = useState(0)
  const reload = () => { setUser(null); setRk((n) => n + 1) }
  const [user, setUser] = useState<LoginUser | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const submit = async (pin: string) => {
    if (!user || busy) return
    setBusy(true); setMsg('')
    try { setSession(await api.unlockPin(user.id, pin)) }
    catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'wrong_pin') setMsg(typeof e.data?.remaining === 'number' ? `Wrong PIN, ${e.data.remaining} ${e.data.remaining === 1 ? 'try' : 'tries'} left` : 'Wrong PIN')
        else if (e.code === 'locked') setMsg(`Too many tries. Locked for ${mins(Number(e.data?.retry_after ?? e.retryAfter ?? 900))}`)
        else if (e.code === 'pin_unavailable') { setMsg('PIN not available'); reload() }
        else if (e.code === 'rate_limited') setMsg('Too many attempts, wait a minute')
        else setMsg('Sign-in failed, try again')
      } else setMsg('Sign-in failed, try again')
      setAttempt((n) => n + 1)
    } finally { setBusy(false) }
  }
  if (!user) return <UserPicker mode="pin" note={msg} reloadKey={rk} onPick={(u) => { setMsg(''); setUser(u) }} onSearching={onSearching} onLeave={onLeave} />
  return <PinPad inline autoLength={length} title={user.display_name} message={msg} busy={busy} resetKey={attempt} onSubmit={submit} onCancel={() => { setUser(null); setMsg('') }} />
}
