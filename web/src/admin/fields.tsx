import { ReactNode, useState } from 'react'
import type { Secret } from './api'

export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="block"><span className="lbl">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}</label>
)

export const Text = ({ label, value, onChange, type = 'text', hint, ph }: { label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string; ph?: string }) => (
  <Field label={label} hint={hint}><input className="inp" type={type} value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)} /></Field>
)

export const Num = ({ label, value, onChange, hint }: { label: string; value: number; onChange: (v: number) => void; hint?: string }) => (
  <Field label={label} hint={hint}><input className="inp" type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} /></Field>
)

export const Check = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => (
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />{label}</label>
)

export const Card = ({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) => (
  <section className="card space-y-3"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{title}</h2>{actions}</div>{children}</section>
)

/** Secret input: {set} shows a mask with Change/Clear; an untouched secret is sent as-is (kept). */
export function SecretInput({ label, value, onChange, moved }: { label: string; value: Secret | undefined; onChange: (v: Secret) => void; moved?: boolean }) {
  const [edit, setEdit] = useState(false)
  const isSet = typeof value === 'object' && value !== null && value.set
  const hintMoved = moved ? 're-enter key for the new server' : undefined
  if (typeof value === 'string' || edit || !isSet)
    return <Text label={label} type="password" value={typeof value === 'string' ? value : ''} onChange={onChange} hint={isSet ? hintMoved : 'Not set'} />
  return (
    <Field label={label}>
      <div className="flex gap-2"><input className="inp" disabled value="••••••••" readOnly />
        <button type="button" className="btn" onClick={() => { setEdit(true); onChange('') }}>Change</button>
        <button type="button" className="btn btn-del" onClick={() => onChange('')}>Clear</button></div>
      {hintMoved && <p className="mt-1 text-xs text-amber-600">{hintMoved}</p>}
    </Field>
  )
}
