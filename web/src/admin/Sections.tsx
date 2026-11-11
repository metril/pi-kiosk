import { useEffect, useMemo, useState } from 'react'
import { api, ApiError, Config, Contact, Preset, Share, Status, Target, View } from './api'
import { Card, Check, Field, Num, SecretInput, Text } from './fields'

type P = { cfg: Config; set: (f: (c: Config) => void) => void }
type Test = { ok: boolean; error?: string; status?: number } | null

export function General({ cfg, set }: P) {
  return (
    <Card title="General">
      <div className="grid gap-3 sm:grid-cols-2">
        <Text label="Kiosk name" value={cfg.name} onChange={(v) => set((c) => { c.name = v })} />
        <Text label="Papyrus public URL" value={cfg.public_url} ph="https://papyrus.example.com" onChange={(v) => set((c) => { c.public_url = v })} hint="Used for the sign-in QR code and links." />
        <Num label="Unlock idle timeout (s)" value={cfg.unlock.idle_s} onChange={(v) => set((c) => { c.unlock.idle_s = v })} />
        <Num label="Unlock max session (s)" value={cfg.unlock.max_s} onChange={(v) => set((c) => { c.unlock.max_s = v })} />
        <Num label="Screen idle (minutes, 0 = never)" value={cfg.screen.idle_minutes} onChange={(v) => set((c) => { c.screen.idle_minutes = v })} />
      </div>
    </Card>
  )
}

export function Contacts({ cfg, set, view }: P & { view: View }) {
  const [list, setList] = useState<Contact[] | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => { api<Contact[]>('papyrus/contacts').then(setList).catch((e: ApiError) => { setErr(e.message); setList(view.cache.contacts) }) }, [view.cache.contacts])
  const shown = (list ?? []).filter((c) => (c.name + c.email).toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) => set((c) => { c.contacts = c.contacts.includes(id) ? c.contacts.filter((x) => x !== id) : [...c.contacts, id] })
  return (
    <Card title="Contacts" actions={<a className="text-sm text-sky-600 underline" href={view.links.contacts} target="_blank" rel="noreferrer">Manage address book in Papyrus</a>}>
      <p className="text-xs text-slate-500">Contacts available for "email" targets, chosen from the Papyrus address book.</p>
      {err && <p className="text-xs text-amber-600">Could not load the address book ({err}); showing the cached list.</p>}
      <input className="inp" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
      {list && !list.length && <p className="text-sm text-slate-500">The address book is empty. Add contacts in Papyrus, then reload this page.</p>}
      <div className="max-h-72 divide-y divide-slate-200 overflow-auto rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {shown.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
            <input type="checkbox" checked={cfg.contacts.includes(c.id)} onChange={() => toggle(c.id)} />
            <span className="font-medium">{c.name || c.email}</span><span className="text-slate-500">{c.email}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500">{cfg.contacts.length} selected</p>
    </Card>
  )
}

const ICONS = ['file-text', 'receipt', 'image', 'book', 'mail', 'folder', 'archive', 'scan']

function Browser({ shareId, start, onPick, onClose }: { shareId: string; start: string; onPick: (p: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(start || '/')
  const [items, setItems] = useState<{ name: string; path: string }[]>([])
  const [err, setErr] = useState('')
  useEffect(() => {
    setErr('')
    api<any>(`papyrus/smb/browse/${shareId}?path=${encodeURIComponent(path)}`).then((r) => {
      const rows: any[] = Array.isArray(r) ? r : r.items ?? r.entries ?? []
      setItems(rows.filter((x) => x.is_dir || x.is_directory || ['dir', 'directory', 'folder'].includes(x.type)).map((x) => ({ name: x.name, path: x.path ?? `${path.replace(/\/$/, '')}/${x.name}` })))
    }).catch((e: ApiError) => { setErr(e.message); setItems([]) })
  }, [shareId, path])
  const up = path.replace(/\/[^/]*\/?$/, '') || '/'
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="card flex max-h-[80vh] w-full max-w-md flex-col gap-2" onClick={(e) => e.stopPropagation()}>
        <div className="font-mono text-sm break-all">{path}</div>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <div className="min-h-0 flex-1 overflow-auto">
          {path !== '/' && <button className="block w-full px-2 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setPath(up)}>..</button>}
          {items.map((i) => <button key={i.path} className="block w-full px-2 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setPath(i.path)}>{i.name}</button>)}
          {!items.length && !err && <p className="px-2 py-2 text-sm text-slate-500">No subfolders</p>}
        </div>
        <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-pri" onClick={() => { onPick(path); onClose() }}>Use this folder</button></div>
      </div>
    </div>
  )
}

function TargetEditor({ t, onChange, onDelete, shares, contacts }: { t: Target; onChange: (t: Target) => void; onDelete: () => void; shares: Share[]; contacts: Contact[] }) {
  const [browse, setBrowse] = useState(false)
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex gap-2">
        <select className="inp" value={t.type} onChange={(e) => onChange({ type: e.target.value as Target['type'] })}>
          <option value="smb">SMB share</option><option value="paperless">Paperless</option><option value="email">Email</option>
        </select>
        <button className="btn btn-del" onClick={onDelete}>Remove</button>
      </div>
      {t.type === 'smb' && <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Share"><select className="inp" value={t.share_id ?? ''} onChange={(e) => onChange({ ...t, share_id: e.target.value, path: '' })}>
          <option value="">Select...</option>{shares.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}</select></Field>
        <Field label="Folder"><div className="flex gap-2"><input className="inp" value={t.path ?? ''} onChange={(e) => onChange({ ...t, path: e.target.value })} />
          <button className="btn" disabled={!t.share_id} onClick={() => setBrowse(true)}>Browse</button></div></Field>
        {browse && t.share_id && <Browser shareId={t.share_id} start={t.path ?? ''} onPick={(p) => onChange({ ...t, path: p })} onClose={() => setBrowse(false)} />}
      </div>}
      {t.type === 'email' && <Field label="Contact"><select className="inp" value={t.contact_id ?? ''} onChange={(e) => onChange({ ...t, contact_id: e.target.value })}>
        <option value="">Select...</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}</select></Field>}
    </div>
  )
}

function ScanOptions({ scan, onChange, opts }: { scan: Record<string, unknown>; onChange: (s: Record<string, unknown>) => void; opts: Record<string, unknown> | null }) {
  const [raw, setRaw] = useState(JSON.stringify(scan))
  const [bad, setBad] = useState(false)
  useEffect(() => { setRaw(JSON.stringify(scan)) }, [scan])
  const choices = Object.entries(opts ?? {}).filter(([, v]) => Array.isArray(v) && v.length && v.every((x) => ['string', 'number'].includes(typeof x) || (x && typeof x === 'object' && 'value' in x)))
  return (
    <div className="space-y-2">
      <span className="lbl">Scan options</span>
      <div className="grid gap-2 sm:grid-cols-2">
        {choices.map(([k, v]) => (
          <Field key={k} label={k}>
            <select className="inp" value={String(scan[k] ?? '')} onChange={(e) => { const n = { ...scan }; if (e.target.value === '') delete n[k]; else n[k] = isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value); onChange(n) }}>
              <option value="">Default</option>
              {(v as any[]).map((x) => { const val = typeof x === 'object' ? x.value : x; return <option key={String(val)} value={String(val)}>{typeof x === 'object' ? x.label ?? val : String(val)}</option> })}
            </select>
          </Field>
        ))}
      </div>
      <Field label="Advanced (JSON)"><textarea className={'inp font-mono ' + (bad ? 'border-red-500' : '')} rows={2} value={raw}
        onChange={(e) => { setRaw(e.target.value); try { const j = JSON.parse(e.target.value || '{}'); if (j && typeof j === 'object' && !Array.isArray(j)) { setBad(false); onChange(j) } else setBad(true) } catch { setBad(true) } }} /></Field>
    </div>
  )
}

export function Presets({ cfg, set, view }: P & { view: View }) {
  const [shares, setShares] = useState<Share[]>(view.cache.smb_shares)
  const [contacts, setContacts] = useState<Contact[]>(view.cache.contacts)
  const [opts, setOpts] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    api<Share[]>('papyrus/smb/shares').then(setShares).catch(() => {})
    api<Contact[]>('papyrus/contacts').then(setContacts).catch(() => {})
    api<Record<string, unknown>>('papyrus/scanners/default/options').then(setOpts).catch(() => {})
  }, [])
  const sel = useMemo(() => contacts.filter((c) => cfg.contacts.includes(c.id)), [contacts, cfg.contacts])
  const upd = (i: number, f: (p: Preset) => void) => set((c) => f(c.presets[i]))
  const add = () => set((c) => {
    let n = c.presets.length + 1
    while (c.presets.some((p) => p.id === 'preset-' + n)) n++
    c.presets.push({ id: 'preset-' + n, label: 'New preset', icon: 'scan', scan: {}, post: {}, delete_after: false, targets: [] })
  })
  const move = (i: number, d: number) => set((c) => { const j = i + d; if (j >= 0 && j < c.presets.length) [c.presets[i], c.presets[j]] = [c.presets[j], c.presets[i]] })
  return (
    <Card title="Presets" actions={<button className="btn" onClick={add}>Add preset</button>}>
      {!cfg.presets.length && <p className="text-sm text-slate-500">No presets.</p>}
      {cfg.presets.map((p, i) => (
        <details key={p.id} className="rounded-lg border border-slate-200 dark:border-slate-800" open={cfg.presets.length === 1}>
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{p.label || p.id} <span className="text-xs text-slate-500">({p.icon}, {p.targets.length} targets)</span></summary>
          <div className="space-y-3 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Text label="Label" value={p.label} onChange={(v) => upd(i, (x) => { x.label = v })} />
              <Field label="Icon"><select className="inp" value={p.icon} onChange={(e) => upd(i, (x) => { x.icon = e.target.value })}>{ICONS.map((n) => <option key={n}>{n}</option>)}</select></Field>
            </div>
            <ScanOptions scan={p.scan} opts={opts} onChange={(s) => upd(i, (x) => { x.scan = s })} />
            <div className="flex flex-wrap gap-4">
              <Check label="OCR" value={!!p.post.ocr} onChange={(v) => upd(i, (x) => { x.post = { ...x.post, ocr: v } })} />
              <Check label="Enhance" value={!!p.post.enhance} onChange={(v) => upd(i, (x) => { x.post = { ...x.post, enhance: v } })} />
              <Check label="Delete scan after sending" value={p.delete_after} onChange={(v) => upd(i, (x) => { x.delete_after = v })} />
            </div>
            <div className="space-y-2">
              <span className="lbl">Targets</span>
              {p.targets.map((t, j) => <TargetEditor key={j} t={t} shares={shares} contacts={sel}
                onChange={(n) => upd(i, (x) => { x.targets[j] = n })} onDelete={() => upd(i, (x) => { x.targets.splice(j, 1) })} />)}
              <button className="btn" onClick={() => upd(i, (x) => { x.targets.push({ type: 'paperless' }) })}>Add target</button>
            </div>
            <div className="flex justify-between">
              <div className="flex gap-2"><button className="btn" disabled={!i} onClick={() => move(i, -1)}>Up</button><button className="btn" disabled={i === cfg.presets.length - 1} onClick={() => move(i, 1)}>Down</button></div>
              <button className="btn btn-del" onClick={() => set((c) => { c.presets.splice(i, 1) })}>Delete preset</button>
            </div>
          </div>
        </details>
      ))}
    </Card>
  )
}

function TestResult({ r }: { r: Test }) {
  if (!r) return null
  return <span className={'text-sm ' + (r.ok ? 'text-green-600' : 'text-red-600')}>{r.ok ? 'Connected' : `Failed: ${r.error ?? r.status}`}</span>
}

export function Labelmaker({ cfg, set, saved }: P & { saved: Config }) {
  const [res, setRes] = useState<Test>(null)
  const lm = cfg.labelmaker
  return (
    <Card title="Label maker" actions={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!lm} onChange={(e) => set((c) => { c.labelmaker = e.target.checked ? { url: '', token: '' } : null })} />Enabled</label>}>
      {lm && <>
        <Text label="URL" value={lm.url} ph="http://labelmaker.lan:8000" onChange={(v) => set((c) => { c.labelmaker!.url = v })} />
        <SecretInput label="API key" moved={!!saved.labelmaker && lm.url.trim() !== saved.labelmaker.url} value={lm.token} onChange={(v) => set((c) => { c.labelmaker!.token = v })} />
        <div className="flex items-center gap-3"><button className="btn" onClick={async () => { setRes(null); try { setRes(await api<Test>('labelmaker/test', 'POST', { url: lm.url, token: lm.token })) } catch (e: any) { setRes({ ok: false, error: e.message }) } }}>Test</button><TestResult r={res} /></div>
      </>}
    </Card>
  )
}

export function Mqtt({ cfg, set, saved }: P & { saved: Config }) {
  const [res, setRes] = useState<Test>(null)
  const m = cfg.mqtt
  return (
    <Card title="Home Assistant / MQTT" actions={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!m} onChange={(e) => set((c) => { c.mqtt = e.target.checked ? { host: '', port: 1883, username: '', password: '', tls: false, ca_pem: '', tls_insecure: false, discovery_prefix: 'homeassistant', node_id: '' } : null })} />Enabled</label>}>
      {m && <>
        <div className="grid gap-3 sm:grid-cols-2">
          <Text label="Host" value={m.host} onChange={(v) => set((c) => { c.mqtt!.host = v })} />
          <Num label="Port" value={m.port} onChange={(v) => set((c) => { c.mqtt!.port = v })} />
          <Text label="Username" value={m.username} onChange={(v) => set((c) => { c.mqtt!.username = v })} />
          <SecretInput label="Password" moved={!!saved.mqtt && (m.host.trim() !== saved.mqtt.host || m.port !== saved.mqtt.port)} value={m.password} onChange={(v) => set((c) => { c.mqtt!.password = v })} />
          <Text label="Discovery prefix" value={m.discovery_prefix} onChange={(v) => set((c) => { c.mqtt!.discovery_prefix = v })} />
          <Text label="Node id" value={m.node_id} hint="Defaults to the kiosk id." onChange={(v) => set((c) => { c.mqtt!.node_id = v })} />
        </div>
        <div className="flex flex-wrap gap-4"><Check label="TLS" value={m.tls} onChange={(v) => set((c) => { c.mqtt!.tls = v })} />
          <Check label="Skip hostname check (insecure)" value={m.tls_insecure} onChange={(v) => set((c) => { c.mqtt!.tls_insecure = v })} /></div>
        {m.tls && <Field label="CA certificate (PEM)"><textarea className="inp font-mono" rows={4} value={m.ca_pem} onChange={(e) => set((c) => { c.mqtt!.ca_pem = e.target.value })} /></Field>}
        <div className="flex items-center gap-3"><button className="btn" disabled={!m.host} onClick={async () => { setRes(null); try { setRes(await api<Test>('mqtt/test', 'POST', m)) } catch (e: any) { setRes({ ok: false, error: e.message }) } }}>Test</button><TestResult r={res} /></div>
      </>}
    </Card>
  )
}

export function StatusPanel({ links, onLogout }: { links: View['links']; onLogout: () => void }) {
  const [s, setS] = useState<Status | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => { const f = () => api<Status>('status').then(setS).catch(() => {}); f(); const t = setInterval(f, 10000); return () => clearInterval(t) }, [])
  const ago = (t: number | null) => (t ? `${Math.max(0, Math.round(Date.now() / 1000 - t))} s ago` : 'never')
  const row = (k: string, v: string) => <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5 text-sm dark:border-slate-800"><span className="text-slate-500">{k}</span><span>{v}</span></div>
  return (
    <Card title="Status">
      {s && <div>
        {row('Version', s.version)}{row('Uptime', `${Math.floor(s.uptime_s / 3600)} h ${Math.floor(s.uptime_s / 60) % 60} m`)}
        {row('MQTT', s.mqtt.enabled ? (s.mqtt.connected ? 'connected' : 'disconnected') : 'disabled')}
        {row('Last Papyrus contact', ago(s.papyrus_last_contact))}{row('Config revision', String(s.config_rev))}
      </div>}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" onClick={async () => { await api('screen/reload', 'POST'); setNote('Screen reloading') }}>Reload kiosk screen</button>
        <a className="btn" href={links.kiosk_token} target="_blank" rel="noreferrer">Manage kiosk token in Papyrus</a>
        <button className="btn btn-del" onClick={onLogout}>Sign out</button>
        {note && <span className="text-sm text-slate-500">{note}</span>}
      </div>
    </Card>
  )
}
