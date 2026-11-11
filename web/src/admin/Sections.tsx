import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink, FileText, Folder, GripVertical, Mail, Plus, Server, Trash2, CheckCircle2, XCircle, RefreshCw, LogOut } from 'lucide-react'
import { api, ApiError, Config, Preset, Share, Status, Target, View } from './api'
import { Chip, Field, ICONS, Num, Overlay, PresetIcon, SecretInput, Section, Segmented, Spinner, Text, Toggle, ToggleRow, useClickAway } from './ui'

type P = { cfg: Config; set: (f: (c: Config) => void) => void }
type Test = { ok: boolean; error?: string; status?: number } | null
const norm = <T extends { id: any }>(r: T[]) => r.map((x) => ({ ...x, id: String(x.id) }))

export function General({ cfg, set }: P) {
  return (
    <Section title="General" desc="How this kiosk identifies itself, and when it locks or sleeps.">
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
        <Text label="Kiosk name" value={cfg.name} onChange={(v) => set((c) => { c.name = v })} />
        <Text label="Papyrus public URL" value={cfg.public_url} ph="https://papyrus.example.com" onChange={(v) => set((c) => { c.public_url = v })} hint="Used for the sign-in QR code and links." />
        <Num label="Unlock idle timeout" suffix="seconds" value={cfg.unlock.idle_s} onChange={(v) => set((c) => { c.unlock.idle_s = v })} hint="Locks after this long without touch." />
        <Num label="Unlock max session" suffix="seconds" value={cfg.unlock.max_s} onChange={(v) => set((c) => { c.unlock.max_s = v })} hint="Locks after this long regardless of activity." />
        <Num label="Screen sleep" suffix="minutes" value={cfg.screen.idle_minutes} onChange={(v) => set((c) => { c.screen.idle_minutes = v })} hint="0 keeps the screen on." />
      </div>
    </Section>
  )
}

/* ---------- presets ---------- */
function ShareDialog({ shares, init, onPick, onClose }: { shares: Share[]; init?: Target; onPick: (t: Target) => void; onClose: () => void }) {
  const [share, setShare] = useState<Share | null>(shares.find((s) => s.id === init?.share_id) ?? null)
  const [path, setPath] = useState(init?.path || '/')
  const [items, setItems] = useState<{ name: string; path: string }[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!share) return
    setErr(''); setBusy(true)
    api<any>(`papyrus/smb/browse/${share.id}?path=${encodeURIComponent(path)}`).then((r) => {
      const rows: any[] = Array.isArray(r) ? r : r.items ?? r.entries ?? []
      setItems(rows.filter((x) => x.is_dir || x.is_directory || ['dir', 'directory', 'folder'].includes(x.type)).map((x) => ({ name: x.name, path: x.path ?? `${path.replace(/\/$/, '')}/${x.name}` })))
    }).catch((e: ApiError) => { setErr(e.message); setItems([]) }).finally(() => setBusy(false))
  }, [share, path])
  const parts = path.split('/').filter(Boolean)
  const to = (n: number) => setPath('/' + parts.slice(0, n).join('/'))
  return (
    <Overlay title={share ? 'Choose a folder' : 'Choose a share'} onClose={onClose}
      footer={share && <><button className="btn" onClick={() => { setShare(null); setPath('/') }}>Change share</button><button className="btn btn-pri" onClick={() => onPick({ type: 'smb', share_id: share.id, path })}>Use this folder</button></>}>
      {!share ? (
        <div style={{ margin: -8 }}>
          {shares.map((s) => <button key={s.id} className="opt" onClick={() => setShare(s)}><Server size={18} className="muted" />{s.name || s.id}</button>)}
          {!shares.length && <p className="muted" style={{ padding: 8 }}>No shares found. Add one in Papyrus first.</p>}
        </div>
      ) : (
        <div>
          <nav aria-label="Folder path" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, padding: '8px 10px', background: 'var(--sunk)', borderRadius: 9, fontSize: 13.5, marginBottom: 10 }}>
            <button className="btn btn-sm btn-ghost" style={{ minHeight: 26, padding: '2px 6px' }} onClick={() => to(0)}><Server size={14} />{share.name || share.id}</button>
            {parts.map((p, i) => <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}><ChevronRight size={14} className="muted" /><button className="btn btn-sm btn-ghost" style={{ minHeight: 26, padding: '2px 6px' }} aria-current={i === parts.length - 1 ? 'location' : undefined} onClick={() => to(i + 1)}>{p}</button></span>)}
          </nav>
          {err && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</p>}
          <div style={{ minHeight: 120 }}>
            {busy && <p className="muted" style={{ display: 'flex', gap: 8, padding: 8 }}><Spinner />Loading</p>}
            {!busy && items.map((i) => <button key={i.path} className="opt" onClick={() => setPath(i.path)}><Folder size={17} className="muted" />{i.name}</button>)}
            {!busy && !items.length && !err && <p className="muted" style={{ padding: 8, margin: 0, fontSize: 13.5 }}>No subfolders here.</p>}
          </div>
        </div>
      )}
    </Overlay>
  )
}

function useTargetLabel(shares: Share[]) {
  return (t: Target) => {
    if (t.type === 'paperless') return 'Paperless'
    if (t.type === 'email') return 'Email: me'
    const s = shares.find((x) => x.id === t.share_id)
    return `${s?.name || t.share_id || 'Share'}${t.path && t.path !== '/' ? ' / ' + t.path.replace(/^\/|\/$/g, '').split('/').join(' / ') : ''}`
  }
}
const tIcon = (t: Target) => t.type === 'email' ? <Mail size={13} /> : t.type === 'paperless' ? <FileText size={13} /> : <Server size={13} />

function ScanOptions({ scan, onChange, opts }: { scan: Record<string, unknown>; onChange: (s: Record<string, unknown>) => void; opts: Record<string, unknown> | null }) {
  const fallback: Record<string, unknown[]> = { mode: ['Color', 'Gray', 'Lineart'], source: ['Flatbed', 'ADF'], resolution: [150, 300, 600], format: ['pdf', 'jpeg', 'png'] }
  // Papyrus GET scanners/default/options lists choices under plural keys; POST /scans takes singular ones.
  const KEY: Record<string, string> = { modes: 'mode', sources: 'source', resolutions: 'resolution', formats: 'format' }
  const norm = Object.fromEntries(Object.entries(opts ?? {}).filter(([k]) => k in KEY).map(([k, v]) => [KEY[k], v]))
  const entries = Object.entries(norm).filter(([, v]) => Array.isArray(v) && v.length && v.every((x) => ['string', 'number'].includes(typeof x) || (x && typeof x === 'object' && 'value' in x))) as [string, any[]][]
  const choices = entries.length ? entries : (Object.entries(fallback) as [string, any[]][])
  const pretty = (k: string) => k.replace(/[_-]/g, ' ').replace(/^./, (s) => s.toUpperCase())
  const put = (k: string, v: unknown) => { const n = { ...scan }; if (v === '' || v === undefined) delete n[k]; else n[k] = v; onChange(n) }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {choices.map(([k, v]) => {
        const o = v.map((x) => typeof x === 'object' ? { value: x.value as string | number, label: String(x.label ?? x.value) } : { value: x as string | number, label: typeof x === 'number' && /res|dpi/i.test(k) ? String(x) : String(x) })
        const cur = scan[k] as string | number | undefined
        const lab = pretty(k) + (/res|dpi/i.test(k) ? ' (dpi)' : '')
        return (
          <div key={k}><span className="lbl">{lab}</span>
            {o.length > 8 && typeof o[0].value === 'number' ? (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <input type="range" aria-label={lab} min={0} max={o.length - 1} step={1} style={{ flex: 1, accentColor: 'var(--acc)' }}
                  value={Math.max(0, o.findIndex((x) => x.value === cur))} onChange={(e) => put(k, o[Number(e.target.value)].value)} />
                <b className="mono" style={{ minWidth: 48 }}>{cur ?? 'Auto'}</b>
              </div>
            ) : <Segmented label={lab} value={(cur ?? '') as any} onChange={(x) => put(k, x)} options={[{ value: '' as any, label: 'Default' }, ...o as any]} />}
          </div>
        )
      })}
    </div>
  )
}

function PresetEditor({ p, upd, onClose, onDelete, shares, opts }: { p: Preset; upd: (f: (p: Preset) => void) => void; onClose: () => void; onDelete: () => void; shares: Share[]; opts: Record<string, unknown> | null }) {
  const [menu, setMenu] = useState(false)
  const [share, setShare] = useState<{ idx: number | null; init?: Target } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const label = useTargetLabel(shares)
  const closeMenu = useCallback(() => setMenu(false), [])
  const menuRef = useClickAway(menu, closeMenu)
  const add = (t: Target) => upd((x) => { x.targets.push(t) })
  return (
    <Overlay drawer title={p.label || 'Preset'} onClose={onClose}
      footer={<><button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => confirm ? onDelete() : setConfirm(true)}><Trash2 size={15} />{confirm ? 'Confirm delete' : 'Delete preset'}</button><button className="btn btn-pri" onClick={onClose}>Done</button></>}>
      <div style={{ display: 'grid', gap: 22 }}>
        <Text label="Label" value={p.label} onChange={(v) => upd((x) => { x.label = v })} hint="Shown on the kiosk button." />
        <div><span className="lbl" id="icon-l">Icon</span>
          <div className="igrid" role="radiogroup" aria-labelledby="icon-l">{Object.keys(ICONS).map((n) => <button key={n} type="button" role="radio" aria-checked={p.icon === n} onClick={() => upd((x) => { x.icon = n })}><PresetIcon name={n} />{n}</button>)}</div>
        </div>
        <div><span className="lbl">Scan settings</span><ScanOptions scan={p.scan} opts={opts} onChange={(s) => upd((x) => { x.scan = s })} /></div>
        <div>
          <span className="lbl">After scanning</span>
          <ToggleRow title="OCR" desc="Make the text searchable." checked={!!p.post.ocr} onChange={(v) => upd((x) => { x.post = { ...x.post, ocr: v } })} />
          <ToggleRow title="Enhance" desc="Straighten and clean up pages." checked={!!p.post.enhance} onChange={(v) => upd((x) => { x.post = { ...x.post, enhance: v } })} />
          <ToggleRow title="Delete after sending" desc="Remove the scan once every destination has it." checked={p.delete_after} onChange={(v) => upd((x) => { x.delete_after = v })} />
        </div>
        <div>
          <span className="lbl">Destinations</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {p.targets.map((t, j) => <Chip key={j} lead={<span style={{ paddingLeft: 6, display: 'inline-flex' }}>{tIcon(t)}</span>} label={label(t)} onClick={t.type === 'smb' ? () => setShare({ idx: j, init: t }) : undefined} onRemove={() => upd((x) => { x.targets.splice(j, 1) })}>{label(t)}</Chip>)}
            <div style={{ position: 'relative' }} ref={menuRef}>
              <button type="button" className="btn btn-sm" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Plus size={14} />Add destination</button>
              {menu && <div className="pop" role="menu" style={{ top: 'calc(100% + 6px)', left: 0, width: 270 }}>
                <button className="opt" role="menuitem" onClick={() => { setMenu(false); setShare({ idx: null }) }}><Server size={16} className="muted" />Share</button>
                <button className="opt" role="menuitem" onClick={() => { setMenu(false); add({ type: 'paperless' }) }}><FileText size={16} className="muted" />Paperless</button>
                <button className="opt" role="menuitem" disabled={p.targets.some((t) => t.type === 'email')} onClick={() => { setMenu(false); add({ type: 'email', to: 'me' }) }}><Mail size={16} className="muted" />Email to the signed-in user</button>
              </div>}
            </div>
          </div>
          {!p.targets.length && <span className="hint">No destinations. Scans from this preset go nowhere.</span>}
        </div>
      </div>
      {share && <ShareDialog shares={shares} init={share.init} onClose={() => setShare(null)} onPick={(t) => { upd((x) => { if (share.idx === null) x.targets.push(t); else x.targets[share.idx] = t }); setShare(null) }} />}
    </Overlay>
  )
}

export function Presets({ cfg, set, view }: P & { view: View }) {
  const [shares, setShares] = useState<Share[]>(view.cache.smb_shares)
  const [opts, setOpts] = useState<Record<string, unknown> | null>(null)
  const [edit, setEdit] = useState<string | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  useEffect(() => {
    api<Share[]>('papyrus/smb/shares').then((r) => setShares(norm(r))).catch(() => {})
    api<Record<string, unknown>>('papyrus/scanners/default/options').then(setOpts).catch(() => {})
  }, [])
  const label = useTargetLabel(shares)
  const add = () => {
    let n = cfg.presets.length + 1
    while (cfg.presets.some((p) => p.id === 'preset-' + n)) n++
    const id = 'preset-' + n
    set((c) => { c.presets.push({ id, label: 'New preset', icon: 'scan', scan: {}, post: {}, delete_after: false, targets: [] }) }); setEdit(id)
  }
  const move = (i: number, j: number) => set((c) => { if (j >= 0 && j < c.presets.length && i !== j) { const [x] = c.presets.splice(i, 1); c.presets.splice(j, 0, x) } })
  const ei = cfg.presets.findIndex((p) => p.id === edit)
  const close = useCallback(() => setEdit(null), [])
  return (
    <Section title="Presets" desc="One-touch scan buttons shown on the kiosk, in this order. Drag or use the arrows to reorder." actions={<button className="btn btn-pri btn-sm" onClick={add}><Plus size={15} />Add preset</button>}>
      {!cfg.presets.length && <p className="muted" style={{ margin: 0 }}>No presets yet. Add one to give the kiosk a scan button.</p>}
      <div style={{ display: 'grid', gap: 10 }}>
        {cfg.presets.map((p, i) => (
          <div key={p.id} className={'pcard' + (over === i && drag !== i ? ' over' : '')} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => { e.preventDefault(); setOver(i) }} onDragEnd={() => { setDrag(null); setOver(null) }}
            onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); setOver(null) }}>
            <span className="muted" style={{ cursor: 'grab', alignSelf: 'center', display: 'none' }} aria-hidden><GripVertical size={16} /></span>
            <button type="button" onClick={() => setEdit(p.id)} aria-label={'Edit ' + p.label} style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 14, flex: 1, minWidth: 0, borderRadius: 8 }}>
              <span className="ico"><PresetIcon name={p.icon} /></span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <b style={{ display: 'block', fontWeight: 600 }}>{p.label || p.id}</b>
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {p.targets.map((t, j) => <Chip key={j} lead={<span style={{ paddingLeft: 6, display: 'inline-flex' }}>{tIcon(t)}</span>}>{label(t)}</Chip>)}
                  {!p.targets.length && <span className="muted" style={{ fontSize: 13 }}>No destinations</span>}
                </span>
              </span>
            </button>
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <button className="icon-btn" aria-label={`Move ${p.label} up`} disabled={!i} onClick={() => move(i, i - 1)}><ArrowUp size={16} /></button>
              <button className="icon-btn" aria-label={`Move ${p.label} down`} disabled={i === cfg.presets.length - 1} onClick={() => move(i, i + 1)}><ArrowDown size={16} /></button>
            </span>
          </div>
        ))}
      </div>
      {ei >= 0 && <PresetEditor p={cfg.presets[ei]} opts={opts} shares={shares} onClose={close}
        upd={(f) => set((c) => f(c.presets[ei]))} onDelete={() => { set((c) => { c.presets.splice(ei, 1) }); setEdit(null) }} />}
    </Section>
  )
}

/* ---------- tests ---------- */
function TestButton({ run, disabled }: { run: () => Promise<Test>; disabled?: boolean }) {
  const [res, setRes] = useState<Test>(null)
  const [busy, setBusy] = useState(false)
  const go = async () => { setRes(null); setBusy(true); try { setRes(await run()) } catch (e: any) { setRes({ ok: false, error: e.message }) } setBusy(false) }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <button type="button" className="btn" disabled={disabled || busy} onClick={go}>{busy && <Spinner />}Test connection</button>
      <span role="status" aria-live="polite" className="st">
        {busy && <span className="muted">Testing...</span>}
        {res?.ok && <span style={{ color: 'var(--ok)', display: 'inline-flex', gap: 6, alignItems: 'center' }}><CheckCircle2 size={16} />Connected</span>}
        {res && !res.ok && <span style={{ color: 'var(--danger)', display: 'inline-flex', gap: 6, alignItems: 'center' }}><XCircle size={16} />Failed: {res.error ?? res.status}</span>}
      </span>
    </div>
  )
}

export function Labelmaker({ cfg, set, saved }: P & { saved: Config }) {
  const lm = cfg.labelmaker
  return (
    <Section title="Label maker" desc="Print labels from the kiosk through a label maker service on your network." actions={<Toggle label="Enable label maker" checked={!!lm} onChange={(v) => set((c) => { c.labelmaker = v ? { url: '', token: '' } : null })} />}>
      {!lm && <p className="muted" style={{ margin: 0 }}>Label printing is off.</p>}
      {lm && <>
        <Text label="Service URL" mono value={lm.url} ph="http://labelmaker.lan:8000" onChange={(v) => set((c) => { c.labelmaker!.url = v })} />
        <SecretInput label="API key" moved={!!saved.labelmaker && lm.url.trim() !== saved.labelmaker.url} value={lm.token} onChange={(v) => set((c) => { c.labelmaker!.token = v })} />
        <TestButton disabled={!lm.url} run={() => api<Test>('labelmaker/test', 'POST', { url: lm.url, token: lm.token })} />
      </>}
    </Section>
  )
}

export function Mqtt({ cfg, set, saved }: P & { saved: Config }) {
  const m = cfg.mqtt
  return (
    <Section title="Home Assistant" desc="Publish kiosk state to an MQTT broker so Home Assistant discovers it automatically." actions={<Toggle label="Enable Home Assistant" checked={!!m} onChange={(v) => set((c) => { c.mqtt = v ? { host: '', port: 1883, username: '', password: '', tls: false, ca_pem: '', tls_insecure: false, discovery_prefix: 'homeassistant', node_id: '' } : null })} />}>
      {!m && <p className="muted" style={{ margin: 0 }}>MQTT is off.</p>}
      {m && <>
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          <Text label="Broker host" value={m.host} ph="mqtt.lan" onChange={(v) => set((c) => { c.mqtt!.host = v })} />
          <Num label="Port" value={m.port} onChange={(v) => set((c) => { c.mqtt!.port = v })} />
          <Text label="Username" value={m.username} onChange={(v) => set((c) => { c.mqtt!.username = v })} />
          <SecretInput label="Password" moved={!!saved.mqtt && (m.host.trim() !== saved.mqtt.host || m.port !== saved.mqtt.port)} value={m.password} onChange={(v) => set((c) => { c.mqtt!.password = v })} />
          <Text label="Discovery prefix" value={m.discovery_prefix} onChange={(v) => set((c) => { c.mqtt!.discovery_prefix = v })} />
          <Text label="Node id" value={m.node_id} hint="Defaults to the kiosk id." onChange={(v) => set((c) => { c.mqtt!.node_id = v })} />
        </div>
        <div>
          <ToggleRow title="Use TLS" desc="Encrypt the connection to the broker." checked={m.tls} onChange={(v) => set((c) => { c.mqtt!.tls = v })} />
          {m.tls && <ToggleRow title="Skip hostname check" desc="Insecure. Only for brokers with a mismatched certificate." checked={m.tls_insecure} onChange={(v) => set((c) => { c.mqtt!.tls_insecure = v })} />}
        </div>
        {m.tls && <Field label="CA certificate (PEM)">{(id) => <textarea id={id} className="inp mono" rows={4} value={m.ca_pem} onChange={(e) => set((c) => { c.mqtt!.ca_pem = e.target.value })} />}</Field>}
        <TestButton disabled={!m.host} run={() => api<Test>('mqtt/test', 'POST', m)} />
      </>}
    </Section>
  )
}

/* ---------- status ---------- */
const dur = (s: number) => { const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60; return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m` }
const ago = (t: number | null) => { if (!t) return 'Never'; const s = Math.max(0, Math.round(Date.now() / 1000 - t)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago` }

export function StatusPanel({ links, user, onLogout, toast }: { links: View['links']; user: string; onLogout: () => void; toast: (k: 'ok' | 'err', m: string) => void }) {
  const [s, setS] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { const f = () => api<Status>('status').then(setS).catch(() => {}); f(); const t = setInterval(f, 10000); return () => clearInterval(t) }, [])
  const mq = s ? (s.mqtt.enabled ? (s.mqtt.connected ? ['Connected', 'var(--ok)'] : ['Disconnected', 'var(--danger)']) : ['Disabled', 'var(--muted)']) : ['', '']
  const tile = (k: string, v: React.ReactNode) => <div className="tile"><small>{k}</small><b>{v}</b></div>
  return (
    <Section title="Status" desc="Live details about this kiosk. Refreshes every 10 seconds.">
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
        {tile('Version', s?.version ?? '...')}
        {tile('Uptime', s ? dur(s.uptime_s) : '...')}
        {tile('MQTT', s ? <span style={{ display: 'inline-flex', alignItems: 'center' }}><span className="dot" style={{ background: mq[1] }} />{mq[0]}</span> : '...')}
        {tile('Last Papyrus contact', s ? ago(s.papyrus_last_contact) : '...')}
        {tile('Signed in as', user)}
        {tile('Config revision', s ? '#' + s.config_rev : '...')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await api('screen/reload', 'POST'); toast('ok', 'Kiosk screen reloading') } catch { toast('err', 'Could not reload the screen') } setBusy(false) }}>{busy ? <Spinner /> : <RefreshCw size={15} />}Reload kiosk screen</button>
        <a className="btn" href={links.kiosk_token} target="_blank" rel="noreferrer"><ExternalLink size={15} />Kiosk token in Papyrus</a>
        <a className="btn" href={links.contacts} target="_blank" rel="noreferrer"><ExternalLink size={15} />Personal address books are managed in Papyrus</a>
        <button className="btn btn-danger" style={{ marginLeft: 'auto' }} onClick={onLogout}><LogOut size={15} />Sign out</button>
      </div>
    </Section>
  )
}

