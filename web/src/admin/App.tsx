import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, Config, setUnauth, View } from './api'
import Login from './Login'
import { Contacts, General, Labelmaker, Mqtt, Presets, StatusPanel } from './Sections'

const TABS = ['General', 'Contacts', 'Presets', 'Label maker', 'Home Assistant', 'Status'] as const
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [draft, setDraft] = useState<Config | null>(null)
  const orig = useRef('')
  const [tab, setTab] = useState<(typeof TABS)[number]>('General')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const v = await api<View>('settings')
      setView(v); setDraft(clone(v.config)); orig.current = JSON.stringify(v.config); setAuthed(true)
    } catch (e) { if (e instanceof ApiError && e.status === 401) setAuthed(false); else setMsg('Could not load settings') }
  }, [])
  useEffect(() => { setUnauth(() => setAuthed(false)); load() }, [load])

  const dirty = !!draft && JSON.stringify(draft) !== orig.current
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault() }
    addEventListener('beforeunload', h); return () => removeEventListener('beforeunload', h)
  }, [dirty])

  const set = useCallback((f: (c: Config) => void) => setDraft((d) => { const n = clone(d!); f(n); return n }), [])
  const save = async () => {
    setBusy(true); setMsg('')
    try {
      const v = await api<View>('settings', 'PUT', { config: draft })
      setView(v); setDraft(clone(v.config)); orig.current = JSON.stringify(v.config); setMsg('Saved and applied')
    } catch (e: any) { setMsg(e.body?.error?.detail ? `Invalid: ${Array.isArray(e.body.error.detail) ? e.body.error.detail.map((d: any) => `${(d.loc || []).join('.')} ${d.msg}`).join('; ') : e.body.error.detail}` : `Save failed: ${e.message}`) }
    setBusy(false)
  }
  const logout = async () => { await api('logout', 'POST').catch(() => {}); setAuthed(false) }

  if (authed === null) return <p className="p-6 text-sm text-slate-500">Loading...</p>
  if (!authed) return <Login onDone={load} />
  if (!view || !draft) return <p className="p-6 text-sm text-slate-500">{msg || 'Loading...'}</p>
  const p = { cfg: draft, set }
  return (
    <div className="mx-auto max-w-5xl px-4 pb-28 pt-4">
      <header className="mb-4 flex items-center justify-between"><h1 className="text-lg font-semibold">{draft.name || 'Kiosk'} admin</h1></header>
      <div className="grid gap-4 md:grid-cols-[11rem_1fr]">
        <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Sections">
          {TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={'whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm ' + (t === tab ? 'bg-sky-600 text-white' : 'hover:bg-slate-200 dark:hover:bg-slate-800')}>{t}</button>)}
        </nav>
        <main className="min-w-0 space-y-4">
          {tab === 'General' && <General {...p} />}
          {tab === 'Contacts' && <Contacts {...p} view={view} />}
          {tab === 'Presets' && <Presets {...p} view={view} />}
          {tab === 'Label maker' && <Labelmaker {...p} saved={view.config} />}
          {tab === 'Home Assistant' && <Mqtt {...p} saved={view.config} />}
          {tab === 'Status' && <StatusPanel links={view.links} onLogout={logout} />}
        </main>
      </div>
      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/95">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <span className="text-sm text-slate-500">{dirty ? 'Unsaved changes' : msg || 'No changes'}</span>
          <div className="flex gap-2">
            <button className="btn" disabled={!dirty || busy} onClick={() => { setDraft(JSON.parse(orig.current)); setMsg('') }}>Discard</button>
            <button className="btn btn-pri" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
