import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { Delete } from 'lucide-react'
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
      <div className="fixed bottom-2 left-24 right-2 z-40 flex flex-col gap-2 pointer-events-none">
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

// ---- numeric PIN keypad
export function PinPad({ onSubmit, onCancel, busy, message }: { onSubmit: (pin: string) => void; onCancel: () => void; busy?: boolean; message?: string }) {
  const [pin, setPin] = useState('')
  const add = (d: string) => setPin((p) => (p.length < 8 ? p + d : p))
  return (
    <div className="absolute inset-0 z-30 bg-black/85 flex items-center justify-center">
      <div className="bg-panel border border-line rounded-2xl p-4 w-[360px]">
        <div className="text-xl font-bold mb-1">Enter release PIN</div>
        <div className="text-warn min-h-[24px] mb-1">{message}</div>
        <div className="bg-bg rounded-xl h-14 mb-3 flex items-center justify-center text-3xl tracking-[0.5em]">{'•'.repeat(pin.length) || ' '}</div>
        <div className="grid grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} className="btn text-2xl" onClick={() => add(d)}>{d}</button>)}
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn text-2xl" onClick={() => add('0')}>0</button>
          <button className="btn" onClick={() => setPin((p) => p.slice(0, -1))}><Delete /></button>
        </div>
        <button className="btn btn-acc w-full mt-2" disabled={!pin || busy} onClick={() => onSubmit(pin)}>{busy ? 'Checking…' : 'Release'}</button>
      </div>
    </div>
  )
}

export function Spinner({ size = 24 }: { size?: number }) {
  return <span className="inline-block rounded-full border-4 border-line border-t-acc animate-spin" style={{ width: size, height: size }} />
}

export const Title = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <div className="flex items-center justify-between h-14 shrink-0"><h1 className="text-2xl font-bold">{children}</h1>{right}</div>
)
