import { useEffect, useState } from 'react'
import { Folder, File, ArrowLeft, HardDrive, Cloud, Check } from 'lucide-react'
import { api, list, type Entry, type Provider, type SmbShare } from '../api'
import { Spinner } from './ui'

export type Src = 'smb' | 'cloud'
export interface Loc { src: Src; ref: string; refName: string; path: string; folder_id: string }
export interface Picked extends Loc { entry: Entry }

const isDir = (e: any) => !!(e.is_dir ?? e.is_directory ?? e.isDir ?? ['dir', 'directory', 'folder'].includes(e.type))
// Papyrus: SMB shares have `name`; cloud providers have `provider` (gdrive|dropbox|onedrive|webdav) + numeric id.
const PROV: Record<string, string> = { gdrive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'OneDrive', webdav: 'WebDAV' }
export const rootName = (r: any): string => r.name ?? `${PROV[r.provider] ?? r.provider} #${r.id}`
const join =(a: string, b: string) => (a ? a.replace(/\/$/, '') + '/' : '') + b
export const ext = (n: string) => n.split('.').pop()?.toLowerCase() ?? ''
export const previewable = (n: string) => ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'].includes(ext(n))

/** Share/provider list, then folder browser. onFile: file tapped. onPickFolder: show "Select this folder" button. */
export default function Browse({ src, onFile, onPickFolder }: { src: Src; onFile?: (p: Picked) => void; onPickFolder?: (l: Loc) => void }) {
  const [roots, setRoots] = useState<(SmbShare | Provider)[] | null>(null)
  const [loc, setLoc] = useState<Loc | null>(null)
  const [stack, setStack] = useState<Loc[]>([])
  const [items, setItems] = useState<Entry[] | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    setRoots(null); setLoc(null); setStack([]); setErr('')
    ;(src === 'smb' ? api.smbShares() : api.providers()).then((d) => setRoots(list(d))).catch(() => setErr('Could not load'))
  }, [src])
  useEffect(() => {
    if (!loc) return
    let live = true
    setItems(null); setErr('')
    const p = loc.src === 'smb' ? api.smbBrowse(loc.ref, loc.path) : api.cloudFiles(loc.ref, loc.folder_id, loc.path)
    p.then((d) => { if (live) setItems(list<Entry>(d).sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name))) })
      .catch(() => live && setErr('Could not load folder'))
    return () => { live = false }
  }, [loc])

  const enter = (e: Entry) => { if (loc) { setStack((s) => [...s, loc]); setLoc({ ...loc, path: e.path || join(loc.path, e.name), folder_id: e.id ?? '' }) } }
  const back = () => { const s = stack.slice(); const p = s.pop(); setStack(s); setLoc(p ?? null) }
  const Ico = src === 'smb' ? HardDrive : Cloud

  if (err && !loc) return <div className="text-err p-3 text-lg">{err}</div>
  if (!roots) return <div className="p-4"><Spinner /></div>
  if (!loc) return (
    <div className="grid grid-cols-2 gap-2 overflow-y-auto">
      {!roots.length && <div className="text-slate-400 p-3">{src === 'smb' ? 'No shares' : 'No cloud providers'}</div>}
      {roots.map((r) => { const n = rootName(r); return <button key={r.id} className="btn !justify-start" onClick={() => setLoc({ src, ref: String(r.id), refName: n, path: '', folder_id: '' })}><Ico />{n}</button> })}
    </div>
  )
  return (
    <div className="flex flex-col gap-2 min-h-0 h-full">
      <div className="flex gap-2 items-center shrink-0">
        <button className="btn" onClick={back} aria-label="Back"><ArrowLeft /></button>
        <div className="flex-1 truncate text-slate-300">{loc.refName}/{loc.path}</div>
        {onPickFolder && <button className="btn btn-acc" onClick={() => onPickFolder(loc)}><Check />Use this folder</button>}
      </div>
      {err && <div className="text-err">{err}</div>}
      {!items && !err && <Spinner />}
      <div className="flex flex-col gap-1 overflow-y-auto min-h-0 flex-1">
        {items?.length === 0 && <div className="text-slate-400 p-3">Empty</div>}
        {items?.map((e) => isDir(e)
          ? <button key={e.path + e.name} className="btn !justify-start" onClick={() => enter(e)}><Folder className="text-acc" />{e.name}</button>
          : onFile && <button key={e.path + e.name} className="btn !justify-start" onClick={() => onFile({ ...loc, path: e.path || join(loc.path, e.name), entry: e })}><File />{e.name}</button>)}
      </div>
    </div>
  )
}
