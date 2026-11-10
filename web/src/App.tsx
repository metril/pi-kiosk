import { useCallback, useState, useSyncExternalStore } from 'react'
import { Home as HomeI, Tag, ScanLine, Copy as CopyI, ListOrdered, WifiOff } from 'lucide-react'
import { offlineStore, setErrorHandler } from './api'
import { ToastHost } from './components/ui'
import { useBusy } from './store'
import { Spinner } from './components/ui'
import Idle from './components/Idle'
import Home from './screens/Home'
import Labels from './screens/Labels'
import Scan from './screens/Scan'
import CopyScreen from './screens/Copy'
import Queue from './screens/Queue'

const TABS = [
  { id: 'home', label: 'Home', icon: HomeI },
  { id: 'labels', label: 'Labels', icon: Tag },
  { id: 'scan', label: 'Scan', icon: ScanLine },
  { id: 'copy', label: 'Copy', icon: CopyI },
  { id: 'queue', label: 'Queue', icon: ListOrdered },
] as const
export type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [tab, setTab] = useState<TabId>('home')
  const busy = useBusy()
  const offline = useSyncExternalStore(offlineStore.sub, offlineStore.get)
  const bind = useCallback((h: Parameters<typeof setErrorHandler>[0]) => { setErrorHandler(h); return () => setErrorHandler(() => {}) }, [])
  return (
    <ToastHost bind={bind}>
      <div className="flex w-[800px] h-[480px] bg-bg relative">
        <nav className="w-20 h-full flex flex-col border-r border-line bg-panel">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex-1 flex flex-col items-center justify-center gap-1 text-sm font-semibold border-l-4 ${tab === t.id ? 'bg-bg text-acc border-acc' : 'text-slate-300 border-transparent active:bg-line'}`}>
              <span className="relative"><t.icon size={28} />{(t.id === 'copy' || t.id === 'scan') && busy[t.id] && <span className="absolute -top-1 -right-2"><Spinner size={16} /></span>}</span>{t.label}
            </button>
          ))}
        </nav>
        <main className="w-[720px] h-full p-2 pt-0 overflow-hidden relative">
          {offline && <div className="absolute top-0 left-0 right-0 z-20 bg-err text-white font-bold px-4 py-2 flex items-center gap-2"><WifiOff size={22} />Offline: service unreachable. Retrying…</div>}
          {tab === 'home' && <Home go={setTab} />}
          {tab === 'labels' && <Labels />}
          {tab === 'scan' && <Scan />}
          {tab === 'copy' && <CopyScreen />}
          {tab === 'queue' && <Queue />}
        </main>
        <Idle />
      </div>
    </ToastHost>
  )
}
