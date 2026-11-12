import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Home, Layers, Printer, ScanLine, Settings2, CheckCircle2, AlertCircle } from 'lucide-react'
import { api, ApiError, Config, setUnauth, View } from './api'
import Login from './Login'
import { General, LoginMethods, Labelmaker, Mqtt, Presets, StatusPanel } from './Sections'
import { Spinner } from './ui'

const TABS = [['General', Settings2], ['Presets', Layers], ['Label maker', Printer], ['Home Assistant', Home], ['Status', Activity]] as const
type Tab = (typeof TABS)[number][0]
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
const errText = (e: any) => e.body?.error?.detail ? `Invalid: ${Array.isArray(e.body.error.detail) ? e.body.error.detail.map((d: any) => `${(d.loc || []).join('.')} ${d.msg}`).join('; ') : e.body.error.detail}` : `Save failed: ${e.message}`

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [draft, setDraft] = useState<Config | null>(null)
  const [user, setUser] = useState('')
  const orig = useRef('')
  const [tab, setTab] = useState<Tab>(() => (TABS.find((t) => t[0] === decodeURIComponent(location.hash.slice(1)))?.[0]) ?? 'General')
  const [busy, setBusy] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [toast, setToast] = useState<{ k: 'ok' | 'err'; m: string } | null>(null)
  const tt = useRef<number>()
  const say = useCallback((k: 'ok' | 'err', m: string) => { setToast({ k, m }); clearTimeout(tt.current); tt.current = window.setTimeout(() => setToast(null), k === 'err' ? 7000 : 3000) }, [])

  const load = useCallback(async () => {
    try {
      const v = await api<View>('settings')
      setView(v); setDraft(clone(v.config)); orig.current = JSON.stringify(v.config); setAuthed(true)
      api<{ user: string }>('session').then((s) => setUser(s.user)).catch(() => {})
    } catch (e) { if (e instanceof ApiError && e.status === 401) setAuthed(false); else setLoadErr('Could not load settings.') }
  }, [])
  useEffect(() => { setUnauth(() => setAuthed(false)); load() }, [load])
  useEffect(() => { history.replaceState(null, '', '#' + encodeURIComponent(tab)) }, [tab])

  const dirty = !!draft && JSON.stringify(draft) !== orig.current
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    addEventListener('beforeunload', h); return () => removeEventListener('beforeunload', h)
  }, [dirty])

  const set = useCallback((f: (c: Config) => void) => setDraft((d) => { const n = clone(d!); f(n); return n }), [])
  const save = async () => {
    setBusy(true)
    try {
      const v = await api<View>('settings', 'PUT', { config: draft })
      setView(v); setDraft(clone(v.config)); orig.current = JSON.stringify(v.config); say('ok', 'Settings saved and applied')
    } catch (e: any) { say('err', errText(e)) }
    setBusy(false)
  }
  const logout = async () => { await api('logout', 'POST').catch(() => {}); setAuthed(false); setView(null); setDraft(null) }

  if (authed === null && !loadErr) return <p className="muted" style={{ padding: 24, display: 'flex', gap: 8 }}><Spinner />Loading</p>
  if (authed === false) return <Login onDone={load} />
  if (!view || !draft) return <p style={{ padding: 24 }} className="muted">{loadErr || 'Loading'}</p>
  const p = { cfg: draft, set }
  return (
    <div className="mx-auto max-w-6xl px-4 md:px-6" style={{ paddingBottom: 110 }}>
      <div className="md:grid md:grid-cols-[14rem_1fr] md:gap-8">
        <aside className="md:sticky md:top-0 md:h-screen md:py-6" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="flex items-center gap-3 py-4 md:pb-6 md:pt-0">
            <span className="ico" style={{ width: 38, height: 38 }}><ScanLine size={20} /></span>
            <div style={{ minWidth: 0 }}><div style={{ fontWeight: 650, letterSpacing: '-.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{draft.name || 'Kiosk'}</div><div className="muted" style={{ fontSize: 12.5 }}>Admin settings</div></div>
          </div>
          <nav aria-label="Sections" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-3 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0">
            {TABS.map(([t, I]) => <button key={t} className="nav-b" style={{ width: 'auto' }} aria-current={t === tab ? 'page' : undefined} onClick={() => setTab(t)}><I size={17} aria-hidden />{t}</button>)}
          </nav>
          {user && <div className="muted hidden md:block" style={{ marginTop: 'auto', fontSize: 12.5, padding: '0 12px' }}>Signed in as<br /><b style={{ color: 'var(--fg)', fontWeight: 600 }}>{user}</b></div>}
        </aside>
        <main className="min-w-0 py-2 md:py-6" style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          {tab === 'General' && <><General {...p} /><LoginMethods {...p} toast={say} /></>}
          {tab === 'Presets' && <Presets {...p} view={view} />}
          {tab === 'Label maker' && <Labelmaker {...p} saved={view.config} />}
          {tab === 'Home Assistant' && <Mqtt {...p} saved={view.config} />}
          {tab === 'Status' && <StatusPanel links={view.links} user={user || 'admin'} onLogout={logout} toast={say} />}
        </main>
      </div>
      {dirty && <div className="savebar" role="region" aria-label="Unsaved changes">
        <span style={{ fontSize: 14, fontWeight: 550 }}>You have unsaved changes</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={busy} onClick={() => { setDraft(JSON.parse(orig.current)); say('ok', 'Changes discarded') }}>Discard</button>
          <button className="btn btn-pri" disabled={busy} onClick={save}>{busy && <Spinner />}{busy ? 'Saving' : 'Save changes'}</button>
        </div>
      </div>}
      {toast && <div className="toast" role="status" style={dirty ? undefined : { bottom: 24 }}>{toast.k === 'ok' ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}{toast.m}</div>}
    </div>
  )
}
