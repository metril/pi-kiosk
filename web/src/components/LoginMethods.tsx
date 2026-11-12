import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { api, ApiError, type LoginUser, type UnlockState } from '../api'
import { setSession } from '../session'
import { PinPad, Spinner } from './ui'

/** Users for the pick-lists; refetched on demand (e.g. after Papyrus says a user is gone). */
function useUsers(want: (u: LoginUser) => boolean) {
  const [users, setUsers] = useState<LoginUser[] | null>(null)
  const [failed, setFailed] = useState(false)
  const load = () => api.unlockUsers().then((u) => { setUsers(u.filter(want)); setFailed(false) }).catch(() => setFailed(true))
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  return { users, failed, reload: load }
}

function Picker({ title, note, users, failed, onPick }: { title: string; note?: string; users: LoginUser[] | null; failed: boolean; onPick: (u: LoginUser) => void }) {
  return (
    <div className="w-full h-full flex flex-col gap-2 min-h-0">
      <div className="text-2xl font-bold shrink-0">{title}</div>
      <div className="text-warn min-h-[24px] shrink-0 truncate">{note}</div>
      {failed && !users ? <div className="text-lg text-slate-300">Can't load the user list, retrying…</div>
        : !users ? <Spinner size={28} />
        : !users.length ? <div className="text-lg text-slate-300">No users available</div>
        : <div data-scroll className="flex-1 min-h-0 overflow-y-auto grid grid-cols-3 gap-2 content-start">
            {users.map((u) => <button key={u.id} className="btn h-14 truncate" onClick={() => onPick(u)}>{u.display_name}</button>)}
          </div>}
    </div>
  )
}

export function ApproveView({ s }: { s: UnlockState }) {
  const { users, failed, reload } = useUsers(() => true)
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
  return <Picker title="Who are you?" note={msg} users={users} failed={failed} onPick={pick} />
}

const mins = (s: number) => (s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${Math.max(1, Math.ceil(s))} seconds`)

export function PinView({ length }: { length: number }) {
  const { users, failed, reload } = useUsers((u) => u.has_pin)
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
  if (!user) return <Picker title="Who are you?" users={users} failed={failed} onPick={(u) => { setMsg(''); setUser(u) }} />
  return <PinPad inline autoLength={length} title={user.display_name} message={msg} busy={busy} resetKey={attempt} onSubmit={submit} onCancel={() => { setUser(null); setMsg('') }} />
}
