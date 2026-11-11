import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Delete, ChevronLeft, ChevronRight } from 'lucide-react'
import { ApiError } from '../api'

// ---- toasts
type T = { id: number; msg: string; kind: 'err' | 'ok' }
const Ctx = createContext<(msg: string, kind?: 'err' | 'ok') => void>(() => {})
export const useToast = () => useContext(Ctx)
let n = 0
export function ToastHost({ children, bind }: { children: ReactNode; bind: (fn: (e: ApiError) => void) => void }) {
  const [list, setList] = useState<T[]>([])
  const push = useCallback((msg: string, kind: 'err' | 'ok' = 'err') => {
    const id = ++n
    setList((l) => [...l.slice(-2), { id, msg, kind }])
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 5000)
  }, [])
  useEffect(() => bind((e) => push(e.message)), [bind, push])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed bottom-16 left-2 right-2 z-40 flex flex-col gap-2 pointer-events-none">
        {list.map((t) => (
          <div key={t.id} className={`rounded-xl px-4 py-3 text-lg font-semibold ${t.kind === 'err' ? 'bg-err text-white' : 'bg-ok text-black'}`}>{t.msg}</div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong')

// ---- inline confirm button: first tap arms, second tap confirms
export function ConfirmBtn({ label, confirmLabel = 'Sure?', onConfirm, className = '', icon }: { label: string; confirmLabel?: string; onConfirm: () => void; className?: string; icon?: ReactNode }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t) }, [armed])
  return (
    <button className={`btn ${armed ? 'btn-err' : ''} ${className}`} onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}>
      {icon}{armed ? confirmLabel : label}
    </button>
  )
}

// ---- numeric PIN keypad (two columns so it fits the 800x480 content area)
export function PinPad({ onSubmit, onCancel, busy, message }: { onSubmit: (pin: string) => void; onCancel: () => void; busy?: boolean; message?: string }) {
  const [pin, setPin] = useState('')
  const add = (d: string) => setPin((p) => (p.length < 8 ? p + d : p))
  return (
    <div className="absolute inset-0 z-30 bg-black/85 flex items-center justify-center">
      <div className="bg-panel border border-line rounded-2xl p-3 w-[620px] flex gap-3">
        <div className="flex-1 flex flex-col gap-2 min-w-0">
          <div className="text-xl font-bold">Enter release PIN</div>
          <div className="text-warn min-h-[24px]">{message}</div>
          <div className="bg-bg rounded-xl h-14 flex items-center justify-center text-3xl tracking-[0.5em]">{'•'.repeat(pin.length) || ' '}</div>
          <div className="flex-1" />
          <button className="btn btn-acc w-full" disabled={!pin || busy} onClick={() => onSubmit(pin)}>{busy ? 'Checking…' : 'Release'}</button>
        </div>
        <div className="grid grid-cols-3 gap-2 w-[300px] shrink-0">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} className="btn text-2xl" onClick={() => add(d)}>{d}</button>)}
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn text-2xl" onClick={() => add('0')}>0</button>
          <button className="btn" onClick={() => setPin((p) => p.slice(0, -1))}><Delete /></button>
        </div>
      </div>
    </div>
  )
}

export function Spinner({ size = 24, className = '', label }: { size?: number; className?: string; label?: string }) {
  return <span role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    className={`block shrink-0 aspect-square rounded-full border-current border-t-transparent animate-spin motion-reduce:animate-none ${className}`}
    style={{ width: size, height: size, borderStyle: 'solid', borderWidth: Math.max(2, Math.round(size / 8)) }} />
}

/** Full-area "working" state: big spinner, elapsed timer, optional percent bar and two-tap cancel. */
export function BusyOverlay({ title, line, startedAt, pct, page, hint, onCancel, cancelling }: {
  title: string; line?: string; startedAt: number; pct?: number | null; page?: number | null; hint?: string
  onCancel?: () => void; cancelling?: boolean
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000))
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t) }, [armed])
  const known = typeof pct === 'number'
  const sub = [page ? `Page ${page} scanned` : '', known ? `${Math.round(pct!)}%` : ''].filter(Boolean).join(' · ') || hint
  return (
    <div className="absolute inset-0 z-20 bg-bg flex flex-col items-center justify-center gap-3 text-center">
      <Spinner size={96} className="text-acc" />
      <div role="status" aria-live="polite" className="text-3xl font-bold leading-none">{cancelling ? 'Cancelling…' : title}</div>
      {line && <div className="text-slate-300 leading-none">{line}</div>}
      <div className="text-5xl font-bold tabular-nums leading-none">{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')}</div>
      <div className="w-[480px] max-w-full h-2 rounded-full bg-line overflow-hidden">
        {known ? <div className="h-full bg-acc transition-[width]" style={{ width: `${Math.min(100, Math.max(0, pct!))}%` }} />
          : <div className="h-full w-2/5 bg-acc rounded-full animate-indet motion-reduce:animate-none" />}
      </div>
      <div className="text-slate-400 leading-none min-h-[16px] tabular-nums">{sub}</div>
      {onCancel && (
        <button className={`btn w-[320px] ${armed || cancelling ? 'btn-err' : ''}`} disabled={cancelling}
          onClick={() => (armed ? (setArmed(false), onCancel()) : setArmed(true))}>
          {cancelling ? 'Cancelling…' : armed ? 'Tap again to cancel' : 'Cancel'}
        </button>
      )}
    </div>
  )
}

// Header slots: Title portals the screen title and its right-hand actions into the app header.
export const HdrCtx = createContext<{ t: HTMLElement | null; r: HTMLElement | null }>({ t: null, r: null })
export const Title = ({ children, right }: { children: ReactNode; right?: ReactNode }) => {
  const { t, r } = useContext(HdrCtx)
  return <>{t && createPortal(children, t)}{r && right && createPortal(right, r)}</>
}

/** Paged grid with swipe, arrow buttons and page dots. compact: single row flanked by arrows. */
export function Pager({ items, cols, rows, compact, className = '' }: { items: ReactNode[]; cols: number; rows: number; compact?: boolean; className?: string }) {
  const per = cols * rows, pages = Math.max(1, Math.ceil(items.length / per))
  const [p, setP] = useState(0)
  const pg = Math.min(p, pages - 1)
  const x0 = useRef<number | null>(null)
  const go = (d: number) => setP(Math.min(pages - 1, Math.max(0, pg + d)))
  const arrow = (d: number, I: typeof ChevronLeft) => <button className="btn !px-0 !min-w-[44px] w-11 shrink-0" disabled={d < 0 ? pg === 0 : pg === pages - 1} onClick={() => go(d)} aria-label={d < 0 ? 'Previous page' : 'Next page'}><I /></button>
  const dots = <div className={`flex justify-center gap-2 items-center ${compact ? 'h-3' : 'flex-1'}`} data-testid="dots">{Array.from({ length: pages }, (_, i) => <span key={i} className={`rounded-full ${compact ? 'w-2 h-2' : 'w-3 h-3'} ${i === pg ? 'bg-acc' : 'bg-line'}`} />)}</div>
  const grid = (
    <div className="grid gap-2 flex-1 min-w-0 min-h-0" style={{ gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gridTemplateRows: `repeat(${rows},minmax(0,1fr))`, touchAction: 'pan-y' }}
      onPointerDown={(e) => { x0.current = e.clientX }}
      onPointerUp={(e) => { if (x0.current !== null && Math.abs(e.clientX - x0.current) > 50) go(e.clientX < x0.current ? 1 : -1); x0.current = null }}>
      {items.slice(pg * per, (pg + 1) * per)}
    </div>
  )
  if (compact) return (
    <div className={`flex flex-col gap-1 min-h-0 ${className}`}>
      <div className="flex gap-2 flex-1 min-h-0">{pages > 1 && arrow(-1, ChevronLeft)}{grid}{pages > 1 && arrow(1, ChevronRight)}</div>
      {pages > 1 && dots}
    </div>
  )
  return (
    <div className={`flex flex-col gap-2 min-h-0 ${className}`}>
      {grid}
      {pages > 1 && <div className="flex gap-2 items-center h-12 shrink-0">{arrow(-1, ChevronLeft)}{dots}{arrow(1, ChevronRight)}</div>}
    </div>
  )
}
