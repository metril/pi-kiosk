import { ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Archive, BookOpen, FileText, Folder, Image as Img, Loader2, Mail, Receipt, ScanLine, X } from 'lucide-react'
import type { Secret } from './api'

export const ICONS: Record<string, any> = { 'file-text': FileText, receipt: Receipt, image: Img, book: BookOpen, mail: Mail, folder: Folder, archive: Archive, scan: ScanLine }
export const PresetIcon = ({ name, size = 22 }: { name: string; size?: number }) => { const I = ICONS[name] ?? ScanLine; return <I size={size} aria-hidden /> }
export const Spinner = ({ size = 16 }: { size?: number }) => <Loader2 size={size} className="spin" aria-hidden />
export const initials = (s: string) => (s.match(/[A-Za-z0-9]+/g) ?? ['?']).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

export const Section = ({ title, desc, actions, children }: { title: string; desc?: string; actions?: ReactNode; children: ReactNode }) => (
  <section className="card">
    <div className="card-h" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div><h2 className="card-t">{title}</h2>{desc && <p className="card-d">{desc}</p>}</div>{actions}
    </div>
    <div className="card-b" style={{ display: 'grid', gap: 16 }}>{children}</div>
  </section>
)

export function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode }) {
  const id = useId()
  return <div><label className="lbl" htmlFor={id}>{label}</label>{children(id)}{hint && <span className="hint">{hint}</span>}</div>
}
export const Text = ({ label, value, onChange, type = 'text', hint, ph, mono }: { label: string; value: string; onChange: (v: string) => void; type?: string; hint?: ReactNode; ph?: string; mono?: boolean }) => (
  <Field label={label} hint={hint}>{(id) => <input id={id} className={'inp' + (mono ? ' mono' : '')} type={type} value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)} />}</Field>
)
export const Num = ({ label, value, onChange, hint, suffix }: { label: string; value: number; onChange: (v: number) => void; hint?: ReactNode; suffix?: string }) => (
  <Field label={label} hint={hint}>{(id) => <div style={{ position: 'relative' }}><input id={id} className="inp" type="number" min={0} value={value} onChange={(e) => onChange(Number(e.target.value))} />{suffix && <span className="muted" style={{ position: 'absolute', right: 12, top: 9, fontSize: 13, pointerEvents: 'none' }}>{suffix}</span>}</div>}</Field>
)

export const Toggle = ({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} className="sw" disabled={disabled} onClick={() => onChange(!checked)} />
)
export const ToggleRow = ({ title, desc, checked, onChange, disabled }: { title: string; desc?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <div className="row-t" style={disabled ? { opacity: 0.6 } : undefined}><div><b>{title}</b>{desc && <small>{desc}</small>}</div><Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} /></div>
)

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const move = (d: number) => { const i = Math.max(0, options.findIndex((o) => o.value === value)); const n = options[(i + d + options.length) % options.length]; onChange(n.value) }
  return (
    <div className="seg" role="radiogroup" aria-label={label} onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1) } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) } }}>
      {options.map((o) => <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value || (value === undefined && o === options[0]) ? 0 : -1} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  )
}

export function Chip({ children, onRemove, onClick, lead, label }: { children: ReactNode; onRemove?: () => void; onClick?: () => void; lead?: ReactNode; label?: string }) {
  return (
    <span className={'chip' + (onRemove ? '' : ' chip-ro')} style={lead ? { paddingLeft: 3 } : undefined}>
      {lead}{onClick ? <button type="button" onClick={onClick} style={{ color: 'inherit', padding: 0, fontSize: 13 }}><span>{children}</span></button> : <span>{children}</span>}
      {onRemove && <button type="button" aria-label={'Remove ' + (label ?? '')} onClick={onRemove}><X size={14} /></button>}
    </span>
  )
}

export function useClickAway(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const d = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('mousedown', d); document.addEventListener('keydown', k, true)
    return () => { document.removeEventListener('mousedown', d); document.removeEventListener('keydown', k, true) }
  }, [open, close])
  return ref
}

/** Modal-ish panel: drawer (right) or centered modal. */
export function Overlay({ title, onClose, drawer, children, footer }: { title: string; onClose: () => void; drawer?: boolean; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose() }
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('keydown', k); prev?.focus?.() }
  }, [onClose])
  return (
    <>
      <div className="scrim" style={drawer ? undefined : { zIndex: 50 }} onClick={onClose} />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={drawer ? 'drawer' : 'modal card'} style={{ outline: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 14px 20px', borderBottom: '1px solid var(--line)' }}>
          <h2 className="card-t">{title}</h2><button className="icon-btn" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ overflow: 'auto', padding: 20, flex: 1, minHeight: 0 }}>{children}</div>
        {footer && <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </>
  )
}

/** Masked secret: "set" shows Replace/Clear; clearing shows an explicit pending-clear state. */
export function SecretInput({ label, value, onChange, moved }: { label: string; value: Secret | undefined; onChange: (v: Secret) => void; moved?: boolean }) {
  const [edit, setEdit] = useState(false)
  const isSet = typeof value === 'object' && value !== null && value.set
  const hintMoved = moved ? <span style={{ color: 'var(--warn)' }}>Re-enter key for the new server.</span> : null
  if (isSet && !edit) return (
    <Field label={label} hint={hintMoved}>{(id) => (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span id={id} className="chip chip-ro mono" style={{ padding: '8px 12px', borderRadius: 9 }}>••••• set</span>
        <button type="button" className="btn btn-sm" onClick={() => { setEdit(true); onChange('') }}>Replace</button>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => onChange('')}>Clear</button>
      </div>)}</Field>
  )
  return (
    <Field label={label} hint={hintMoved ?? (typeof value === 'string' && value === '' && edit ? undefined : !isSet ? 'Not set' : undefined)}>{(id) => (
      <div style={{ display: 'flex', gap: 8 }}>
        <input id={id} className="inp" type="password" autoComplete="new-password" value={typeof value === 'string' ? value : ''} placeholder={edit ? 'Enter new value' : 'Not set'} onChange={(e) => onChange(e.target.value)} />
      </div>)}</Field>
  )
}
