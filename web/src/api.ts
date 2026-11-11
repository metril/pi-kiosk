export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

type Listener = () => void
const bus = { offline: false, ls: new Set<Listener>() }
export const offlineStore = {
  get: () => bus.offline,
  sub: (l: Listener) => (bus.ls.add(l), () => void bus.ls.delete(l)),
}
function setOffline(v: boolean) { if (bus.offline !== v) { bus.offline = v; bus.ls.forEach((l) => l()) } }

type ErrHandler = (e: ApiError) => void
let onError: ErrHandler = () => {}
export const setErrorHandler = (h: ErrHandler) => { onError = h }

function parseErr(status: number, body: any): ApiError {
  let code = 'error', msg = `HTTP ${status}`
  if (body?.error && typeof body.error === 'object') { code = body.error.code ?? code; msg = body.error.message ?? msg }
  else if (body?.detail !== undefined) {
    code = body.code ?? code
    msg = typeof body.detail === 'string' ? body.detail : Array.isArray(body.detail) ? body.detail.map((d: any) => d.msg).join('; ') : msg
  }
  return new ApiError(status, code, msg)
}

/** Opened on any 401 "locked"; resolves true once unlocked (request is then retried once). */
let onLocked: (() => Promise<boolean>) | null = null
export const setLockedHandler = (h: (() => Promise<boolean>) | null) => { onLocked = h }

/** quiet: caller handles errors itself (no global toast). */
async function req<T>(method: string, path: string, body?: unknown, quiet = false, signal?: AbortSignal, retried = false): Promise<T> {
  try {
    const r = await fetch(path, {
      method,
      signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await r.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { /* non-json */ }
    setOffline(r.status === 502 && data?.error?.code === 'upstream_unreachable')
    if (!r.ok) {
      const pe = parseErr(r.status, data)
      if (r.status === 401 && data?.detail === 'locked') {
        pe.code = 'locked'
        if (!retried && onLocked && (await onLocked())) return await req<T>(method, path, body, quiet, signal, true)
        throw pe
      }
      if (r.status === 504 && pe.code === 'upstream_timeout') pe.message = 'Still working upstream — check the printer before retrying'
      throw pe
    }
    return data as T
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e
    const err = e instanceof ApiError ? e : new ApiError(0, 'network', 'Kiosk service unreachable')
    if (err.status === 0) setOffline(true)
    if (!quiet && err.code !== 'locked' && !(err.status === 502 && err.code === 'upstream_unreachable') && err.status !== 0) onError(err)
    throw err
  }
}
const del = <T,>(p: string) => req<T>('DELETE', p, undefined, false)
const get = <T,>(p: string, quiet = true, signal?: AbortSignal) => req<T>('GET', p, undefined, quiet, signal)
const post = <T,>(p: string, b?: unknown, quiet = false) => req<T>('POST', p, b ?? {}, quiet)
const qs = (o: Record<string, string | number>) => '?' + new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]))

// ---- types
export interface Page<T> { items: T[]; total: number; limit: number; offset: number }
export interface PrinterStatus { state: number; state_message: string; accepting_jobs: boolean; state_reasons: string[]; markers: { name: string; level: number; color: string }[] }
export interface ScannerStatus { available: boolean; device: string | null; busy: boolean | null }
export interface ScanOptions { resolutions: number[]; modes: string[]; formats: string[]; feeder_formats: string[]; sources: string[] }
export interface ScanProfile { id: number; name: string; resolution: number; color_mode: string; format: string; source: string; ocr_enabled: boolean }
export interface ScanReq { resolution: number; mode: string; format: string; source: string }
export interface Scan { id: number; scan_id: string; status: string; resolution: number; mode: string; format: string; source: string; page_count: number; error_message: string | null; created_at: string }
export interface Job { id: number; title: string; status: string; copies: number; duplex: boolean; media: string; has_pin: boolean; source_type: string; created_at: string }
export interface CopyReq { copies: number; mode: string; duplex: boolean; resolution?: number; source?: string; media?: string }
export interface LabelStatus { connected: boolean; error: string | null; error_code: string | null; printer_mode: string }
export interface Preset { id: string; name: string; favorite: boolean; label_type: string; tape_family: string; tape_width_mm: number | null }
export interface HistoryItem { id: string; status: string; label_count: number; kind: string; created_at: string; error: string | null; thumbnail_url: string | null }
export interface LabelJob { id: string; status: string; error: string | null; label_count: number }
export interface PresetTarget { type: 'paperless' | 'smb' | 'cloud' | 'email'; share_id?: string; path?: string; provider_id?: string; folder_id?: string; contact_id?: string }
export interface KioskPreset {
  id: string; label?: string; icon?: string; needs_unlock: boolean
  scan?: Partial<ScanReq>; post?: { ocr?: boolean; enhance?: boolean }; targets: PresetTarget[]; delete_after?: boolean
}
export interface Contact { id: string; name: string }
export interface UnlockState {
  state: 'locked' | 'pending' | 'unlocked' | 'denied' | 'expired'
  user?: string | null; remaining_s?: number; idle_remaining_s?: number
  qr_uri?: string; user_code?: string; expires_in?: number
}
export interface SendResult { type: string; ok: boolean; status?: number; error?: string }
export interface SendResp { post: Record<string, { ok: boolean }>; results: SendResult[]; all_ok: boolean; deleted: boolean }
export interface SmbShare { id: string; name: string }
export interface Entry { name: string; path: string; is_dir: boolean; id?: string; mime?: string; size?: number }
export interface Provider { id: string; name: string }
export interface KioskConfig {
  idle_minutes: number
  name?: string; public_url?: string; config_rev?: number | string
  smb_shares?: { id: string; name: string }[]
  unlock?: { idle_s: number; max_s: number }
  presets?: KioskPreset[]; contacts?: Contact[]
  destinations: { paperless: boolean; smb: { share_id: string; path: string } | null; cloud: { provider_id: string } | null; email: { to: string } | null }
}
export interface ScreenState { config_rev?: number | string; on: boolean; brightness: number | null; max: number | null; reload_seq: number }
export type Sig = AbortSignal

export const api = {
  printerStatus: (sg?: Sig) => get<PrinterStatus>('/papyrus/printers/default/status', true, sg),
  scannerStatus: (sg?: Sig) => get<ScannerStatus>('/papyrus/scanners/default/status', true, sg),
  scanOptions: (sg?: Sig) => get<ScanOptions>('/papyrus/scanners/default/options', true, sg),
  profiles: (sg?: Sig) => get<ScanProfile[] | Page<ScanProfile>>('/papyrus/scan-profiles', false, sg),
  scans: (limit = 10, sg?: Sig) => get<Page<Scan>>('/papyrus/scans' + qs({ limit }), true, sg),
  startScan: (b: ScanReq) => post<Scan>('/papyrus/scans', b),
  sendScan: (id: string, kind: 'smb' | 'email' | 'cloud' | 'paperless', query: Record<string, string | number> = {}, body: unknown = {}) =>
    post<{ message: string }>(`/papyrus/scans/${id}/${kind}${Object.keys(query).length ? qs(query) : ''}`, body),
  copy: (b: CopyReq) => post<{ message: string }>('/papyrus/copy', b),
  heldJobs: (sg?: Sig) => get<Page<Job>>('/papyrus/jobs' + qs({ status: 'held', limit: 50 }), true, sg),
  // release errors (403 pin / 429) are handled by the caller
  release: (id: number, pin?: string) => post<unknown>(`/papyrus/jobs/${id}/release`, pin ? { pin } : {}, true),
  cancelJob: (id: number) => post<unknown>(`/papyrus/jobs/${id}/cancel`),
  labelStatus: (sg?: Sig) => get<LabelStatus>('/labels/printer/status', true, sg),
  presets: (sg?: Sig) => get<Preset[]>('/labels/presets', false, sg),
  printPreset: (id: string) => post<{ job_id: string }>(`/labels/presets/${id}/print`),
  history: (page_size = 10, sg?: Sig) => get<{ items: HistoryItem[] }>('/labels/history' + qs({ page: 1, page_size }), true, sg),
  reprint: (id: string) => post<{ job_id: string }>(`/labels/history/${id}/reprint`),
  labelJob: (id: string, sg?: Sig) => get<LabelJob>(`/labels/print/jobs/${id}`, true, sg),
  cancelLabel: (id: string) => post<unknown>(`/labels/print/jobs/${id}/cancel`),
  kioskConfig: (sg?: Sig) => get<KioskConfig>('/kiosk/config', true, sg),
  unlockStart: () => post<UnlockState>('/kiosk/unlock/start', undefined, true),
  unlockState: (sg?: Sig) => get<UnlockState>('/kiosk/unlock/state', true, sg),
  unlockTouch: () => post<UnlockState>('/kiosk/unlock/touch', undefined, true),
  lock: () => post<UnlockState>('/kiosk/lock', undefined, true),
  send: (b: { scan_id: string; targets: PresetTarget[]; post?: { ocr?: boolean; enhance?: boolean }; delete_after?: boolean }) => post<SendResp>('/kiosk/send', b, true),
  sendEmail: (scan_id: string, contact_id: string) => post<SendResult>('/kiosk/send/email', { scan_id, contact_id }, true),
  printRemote: (b: { source: 'smb' | 'cloud'; ref: string; path: string; file_id?: string; copies: number; duplex: boolean }) => post<unknown>('/kiosk/print/remote', b),
  printScan: (id: string, copies: number, duplex: boolean) => post<unknown>(`/kiosk/print/scan/${id}`, { copies, duplex }),
  deleteScan: (id: string) => del<unknown>(`/papyrus/scans/${id}`),
  smbShares: () => get<SmbShare[] | { items: SmbShare[] }>('/papyrus/smb/shares', false),
  smbBrowse: (share: string, path: string) => get<Entry[] | { items?: Entry[]; entries?: Entry[] }>(`/papyrus/smb/browse/${share}` + qs({ path }), false),
  providers: () => get<Provider[] | { items: Provider[] }>('/papyrus/cloud/providers', false),
  cloudFiles: (prov: string, folder_id: string, path: string) => get<Entry[] | { items?: Entry[]; entries?: Entry[]; files?: Entry[] }>(`/papyrus/cloud/files/${prov}` + qs({ ...(folder_id ? { folder_id } : {}), path }), false),
  screenState: (sg?: Sig) => get<ScreenState>('/kiosk/screen', true, sg),
  screen: (on: boolean) => post<unknown>(`/kiosk/screen/${on ? 'on' : 'off'}`, undefined, true),
}
export const list = <T,>(d: any): T[] => (Array.isArray(d) ? d : d?.items ?? d?.providers ?? d?.entries ?? d?.files ?? [])
export const dl = {
  smb: (share: string, path: string) => `/papyrus/smb/download/${share}` + qs({ path }),
  cloud: (prov: string, path: string, file_id = '') => `/papyrus/cloud/download/${prov}` + qs({ path, ...(file_id ? { file_id } : {}) }),
}
export const thumbs = {
  scan: (id: string) => `/papyrus/scans/${id}/thumbnail`,
  label: (id: string) => `/labels/history/${id}/thumbnail`,
}
