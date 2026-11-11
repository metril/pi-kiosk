import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Home as HomeI, FolderOpen, Tag, ScanLine, Copy as CopyI, ListOrdered, WifiOff } from 'lucide-react'
import { api, offlineStore, setErrorHandler } from './api'
import { ToastHost, HdrCtx } from './components/ui'
import { useBusy } from './store'
import { Spinner } from './components/ui'
import Idle from './components/Idle'
import Home from './screens/Home'
import Labels from './screens/Labels'
import Scan from './screens/Scan'
import CopyScreen from './screens/Copy'
import Queue from './screens/Queue'
import Files from './screens/Files'
import { SessionChip } from './components/Unlock'
import LockScreen from './components/LockScreen'
import { useSession, setSession } from './session'
import { usePoll } from './hooks'

const TABS = [
  { id: 'home', label: 'Home', icon: HomeI },
  { id: 'labels', label: 'Labels', icon: Tag },
  { id: 'scan', label: 'Scan', icon: ScanLine },
  { id: 'copy', label: 'Copy', icon: CopyI },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'queue', label: 'Queue', icon: ListOrdered },
] as const
export type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [tab, setTab] = useState<TabId>('home')
  const busy = useBusy()
  const sess = useSession()
  const unlocked = sess.state === 'unlocked'
  // Track the server session while unlocked (the Lock screen polls its own flow).
  usePoll((sg) => (unlocked ? api.unlockState(sg).then(setSession) : Promise.resolve()), 5000)
  useEffect(() => { if (!unlocked) setTab('home') }, [unlocked])
  const offline = useSyncExternalStore(offlineStore.sub, offlineStore.get)
  const bind = useCallback((h: Parameters<typeof setErrorHandler>[0]) => { setErrorHandler(h); return () => setErrorHandler(() => {}) }, [])
  const [t, setT] = useState<HTMLElement | null>(null), [r, setR] = useState<HTMLElement | null>(null)
  return (
    <ToastHost bind={bind}>
      <HdrCtx.Provider value={{ t, r }}>
      <div className="flex flex-col w-full h-full bg-bg relative">
        {!unlocked ? <LockScreen /> : <>
        <header className="h-12 shrink-0 flex items-center gap-2 px-2 border-b border-line">
          <h1 ref={setT} className="text-2xl font-bold shrink-0" />
          <div ref={setR} className="flex gap-2 items-center" />
          <div className="flex-1" />
          <SessionChip />
        </header>
        {offline && <div className="absolute top-0 left-0 right-0 h-12 z-20 bg-err text-white font-bold px-4 flex items-center gap-2"><WifiOff size={22} />Offline: service unreachable. Retrying…</div>}
        <main className="flex-1 min-h-0 p-2 overflow-hidden relative">
          {tab === 'home' && <Home go={setTab} />}
          {tab === 'labels' && <Labels />}
          {tab === 'scan' && <Scan />}
          {tab === 'copy' && <CopyScreen />}
          {tab === 'files' && <Files />}
          {tab === 'queue' && <Queue />}
        </main>
        <nav className="h-14 shrink-0 flex border-t border-line bg-panel">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex-1 flex flex-col items-center justify-center text-sm font-semibold border-t-4 ${tab === t.id ? 'bg-bg text-acc border-acc' : 'text-slate-300 border-transparent active:bg-line'}`}>
              <span className="relative"><t.icon size={24} />{(t.id === 'copy' || t.id === 'scan') && busy[t.id] && <span className="absolute -top-1 -right-2"><Spinner size={14} /></span>}</span>{t.label}
            </button>
          ))}
        </nav>
        </>}
        <Idle />
      </div>
      </HdrCtx.Provider>
    </ToastHost>
  )
}
