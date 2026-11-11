import { useEffect, useState } from 'react'
import { X, Send as SendI, Mail, HardDrive, Cloud, FileText, Check, AlertCircle } from 'lucide-react'
import { api, type Contact, type PresetTarget, type SendResp } from '../api'
import { useConfig } from '../store'
import Browse from './Browse'
import { Spinner, useToast, errMsg } from './ui'

const label = (t: PresetTarget, names: Record<string, string>) =>
  t.type === 'smb' ? `Share: ${names[t.share_id!] ?? t.share_id}/${t.path ?? ''}`
  : t.type === 'cloud' ? `Cloud: ${names[t.provider_id!] ?? t.provider_id}/${t.path ?? ''}`
  : t.type === 'email' ? `Email: ${t.to === 'me' ? 'me' : names[t.contact_id!] ?? t.contact_id}` : 'Paperless'
const key = (t: PresetTarget) => JSON.stringify(t)

function Toggle({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: string }) {
  return <button className={`btn flex-1 ${on ? 'btn-acc' : ''}`} onClick={() => set(!on)}>{on && <Check size={20} />}{children}</button>
}

export default function Send({ scanId, onClose, onDeleted }: { scanId: string; onClose: () => void; onDeleted?: () => void }) {
  const cfg = useConfig(), toast = useToast()
  const [view, setView] = useState<'main' | 'smb' | 'cloud' | 'email'>('main')
  const [targets, setTargets] = useState<PresetTarget[]>([])
  const [names] = useState<Record<string, string>>({})
  const [ocr, setOcr] = useState(false), [enh, setEnh] = useState(false), [del, setDel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<SendResp | null>(null)
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  useEffect(() => { if (view === 'email' && !contacts) api.contacts().then(setContacts).catch((e) => { if (e?.code !== 'locked') toast(errMsg(e)); setContacts([]) }) }, [view])
  const paperless = !!cfg?.destinations.paperless || !!cfg?.presets?.some((p) => p.targets.some((t) => t.type === 'paperless'))
  names.__ = ''
  contacts?.forEach((c) => (names[c.id] = c.name))
  cfg?.smb_shares?.forEach((s) => (names[s.id] = s.name))
  const has = (t: PresetTarget) => targets.some((x) => key(x) === key(t))
  const toggle = (t: PresetTarget) => setTargets((l) => (has(t) ? l.filter((x) => key(x) !== key(t)) : [...l, t]))

  const go = async () => {
    setBusy(true)
    try {
      const r = await api.send({ scan_id: scanId, targets, post: { ocr, enhance: enh }, delete_after: del })
      setRes(r)
      if (r.deleted) onDeleted?.()
    } catch (e: any) { if (e?.code !== 'locked') toast(errMsg(e)) } finally { setBusy(false) }
  }

  const head = (t: string) => <div className="flex items-center justify-between text-xl font-bold shrink-0">{t}<button className="btn" onClick={() => (view === 'main' || res ? onClose() : setView('main'))}>{view === 'main' || res ? <X /> : 'Done'}</button></div>

  let body
  if (res) {
    body = <div className="flex flex-col gap-2 overflow-hidden">
      {Object.entries(res.post).map(([k, v]) => <div key={k} className={`rounded-xl p-3 text-lg ${v.ok ? 'bg-ok/20' : 'bg-err/30'}`}>{k.toUpperCase()}: {v.ok ? 'done' : 'failed'}</div>)}
      {res.results.map((r, i) => <div key={i} className={`rounded-xl p-3 text-lg flex items-center gap-2 ${r.ok ? 'bg-ok/20' : 'bg-err/30'}`}>{r.ok ? <Check className="text-ok" /> : <AlertCircle className="text-err" />}{label(targets[i], names)}: {r.ok ? 'sent' : r.error ?? `failed (${r.status ?? '?'})`}</div>)}
      {res.deleted && <div className="text-slate-300 p-1">Scan deleted</div>}
      {!res.all_ok && !res.results.length && <div className="text-err p-1">Processing failed, nothing was sent</div>}
      <div className="flex gap-2"><button className="btn flex-1" onClick={onClose}>Close</button>{!res.all_ok && <button className="btn btn-acc flex-1" onClick={() => setRes(null)}>Back</button>}</div>
    </div>
  } else if (view === 'smb' || view === 'cloud') {
    body = <div className="min-h-0 flex-1"><Browse src={view} onPickFolder={(l) => { names[l.ref] = l.refName; toggle(l.src === 'smb' ? { type: 'smb', share_id: l.ref, path: l.path } : { type: 'cloud', provider_id: l.ref, path: l.path, ...(l.folder_id ? { folder_id: l.folder_id } : {}) }); setView('main') }} /></div>
  } else if (view === 'email') {
    body = <div data-scroll className="flex flex-col gap-2 overflow-y-auto min-h-0 flex-1">
      {!contacts && <div className="p-3"><Spinner /></div>}
      {contacts?.map((c) => { const t: PresetTarget = c.id === 'me' ? { type: 'email', to: 'me' } : { type: 'email', contact_id: c.id }; return <button key={c.id} className={`btn shrink-0 !justify-start ${has(t) ? 'btn-acc' : ''}`} onClick={() => toggle(t)}><span className="truncate">{c.name}</span></button> })}
      {contacts && contacts.length <= 1 && <div className="text-slate-400 p-3">Add contacts in Papyrus → Settings → Contacts</div>}
    </div>
  } else {
    body = <>
      <div className="grid grid-cols-4 gap-2 shrink-0">
        <button className="btn !flex-col !gap-0 !text-base !min-h-[56px]" onClick={() => setView('smb')}><HardDrive />Share</button>
        <button className="btn !flex-col !gap-0 !text-base" onClick={() => setView('cloud')}><Cloud />Cloud</button>
        {paperless ? <button className={`btn !flex-col !gap-0 !text-base ${has({ type: 'paperless' }) ? 'btn-acc' : ''}`} onClick={() => toggle({ type: 'paperless' })}><FileText />Paperless</button> : <span />}
        <button className="btn !flex-col !gap-0 !text-base" onClick={() => setView('email')}><Mail />Email</button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden grid grid-cols-2 gap-1 content-start">
        {!targets.length && <div className="text-slate-400 p-2 col-span-2">Pick one or more destinations</div>}
        {targets.slice(0, 6).map((t) => <button key={key(t)} className="btn !justify-between !min-h-[44px] !text-base min-w-0" onClick={() => toggle(t)}><span className="truncate">{label(t, names)}</span><X size={20} className="shrink-0" /></button>)}
        {targets.length > 6 && <div className="text-slate-400 p-1">+{targets.length - 6} more</div>}
      </div>
      <div className="flex gap-2 shrink-0"><Toggle on={ocr} set={setOcr}>OCR</Toggle><Toggle on={enh} set={setEnh}>Enhance</Toggle><Toggle on={del} set={setDel}>Delete after</Toggle></div>
      <button className="btn btn-ok shrink-0 text-xl" disabled={!targets.length || busy} onClick={go}>{busy ? <Spinner /> : <SendI />}Send to {targets.length || '…'}</button>
    </>
  }
  return (
    <div className="absolute inset-0 z-30 bg-bg p-2 flex flex-col gap-2">
      {head(res ? 'Results' : view === 'main' ? 'Send scan' : view === 'smb' ? 'Choose share folder' : view === 'cloud' ? 'Choose cloud folder' : 'Choose contacts')}
      {body}
    </div>
  )
}
