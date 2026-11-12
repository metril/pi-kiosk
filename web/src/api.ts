export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number, public data?: any) { super(message) }
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
  return new ApiError(status, code, msg, undefined, body?.error)
}

/** Fallback on any 401 "locked" (server says locked): drop to the Lock screen. */
let onLocked: (() => void) | null = null
export const setLockedHandler = (h: (() => void) | null) => { onLocked = h }

/** quiet: caller handles errors itself (no global toast). */
async function req<T>(method: string, path: string, body?: unknown, quiet = false, signal?: AbortSignal): Promise<T> {
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
      const ra = Number(r.headers.get('Retry-After'))
      if (ra > 0) pe.retryAfter = ra
      if (r.status === 401 && data?.detail === 'locked') {
        pe.code = 'locked'
        onLocked?.()
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
export interface ScanReq { scan_id?: string; resolution: number; mode: string; format: string; source: string }
export interface Scan { id: number; scan_id: string; status: string; resolution: number; mode: string; format: string; source: string; page_count: number; progress_pct?: number | null; error_message: string | null; created_at: string }
export interface Job { id: number; title: string; status: string; copies: number; duplex: boolean; media: string; has_pin: boolean; source_type: string; created_at: string }
export interface CopyStatus { copy_id?: string; phase: 'scanning' | 'printing' | 'done' | 'failed' | 'cancelled'; progress_pct: number | null; scan_id: string | null; job_id: number | null }
export interface Devices {
  printer: PrinterStatus | null; scanner: ScannerStatus | null
  printer_stale: boolean; scanner_stale: boolean; printer_age_s: number | null; scanner_age_s: number | null
}
export interface CopyReq { copy_id?: string; copies: number; mode: string; duplex: boolean; resolution?: number; source?: string; media?: string }
export interface LabelStatus { connected: boolean; error: string | null; error_code: string | null; printer_mode: string }
export interface Preset { id: string; name: string; favorite: boolean; label_type: string; tape_family: string; tape_width_mm: number | null }
export interface HistoryItem { id: string; status: string; label_count: number; kind: string; created_at: string; error: string | null; thumbnail_url: string | null }
export interface LabelJob { id: string; status: string; error: string | null; label_count: number }
export interface PresetTarget { type: 'paperless' | 'smb' | 'cloud' | 'email'; share_id?: string; path?: string; provider_id?: string; folder_id?: string; contact_id?: string; to?: string }
export interface KioskPreset {
  id: string; label?: string; icon?: string; needs_unlock: boolean
  scan?: Partial<ScanReq>; post?: { ocr?: boolean; enhance?: boolean }; targets: PresetTarget[]; delete_after?: boolean
}
export interface Contact { id: string; name: string }
export interface UnlockState {
  state: 'locked' | 'pending' | 'unlocked' | 'denied' | 'expired'
  user?: string | null; remaining_s?: number; idle_remaining_s?: number
  qr_uri?: string; user_code?: string; expires_in?: number; match_code?: string
}
export interface LoginMethods { qr: boolean; approve: boolean; pin: boolean; pin_length: number }
export interface LoginUser { id: string; display_name: string; has_pin: boolean }
export interface SendResult { type: string; ok: boolean; status?: number; error?: string }
export interface SendResp { post: Record<string, { ok: boolean }>; results: SendResult[]; all_ok: boolean; deleted: boolean }
export interface SmbShare { id: string; name: string }
export interface Entry { name: string; path: string; is_dir: boolean; id?: string; mime?: string; size?: number }
export interface Provider { id: string; name: string }
export interface KioskStatus { printer_ready: boolean; scanner_ready: boolean }
export interface KioskConfig {
  idle_minutes: number
  name?: string; public_url?: string; config_rev?: number | string
  smb_shares?: { id: string; name: string }[]
  unlock?: { idle_s: number; max_s: number }
  presets?: KioskPreset[]
  destinations: { paperless: boolean; smb: { share_id: string; path: string } | null; cloud: { provider_id: string } | null }
}
export interface ScreenState { config_rev?: number | string; on: boolean; brightness: number | null; max: number | null; reload_seq: number }
export type Sig = AbortSignal

export const api = {
  printerStatus: (sg?: Sig) => get<PrinterStatus>('/papyrus/printers/default/status', true, sg),
  scannerStatus: (sg?: Sig) => get<ScannerStatus>('/papyrus/scanners/default/status', true, sg),
  scanOptions: (sg?: Sig) => get<ScanOptions>('/papyrus/scanners/default/options', true, sg),
  profiles: (sg?: Sig) => get<ScanProfile[] | Page<ScanProfile>>('/papyrus/scan-profiles', false, sg),
  scans: (limit = 10, sg?: Sig) => get<Page<Scan>>('/papyrus/scans' + qs({ limit }), true, sg),
  scan: (id: string, sg?: Sig) => get<Scan>(`/papyrus/scans/${id}`, true, sg),
  // quiet: callers map the 409 scan_cancelled outcome themselves
  startScan: (b: ScanReq) => post<Scan>('/papyrus/scans', b, true),
  cancelScan: (id: string) => post<unknown>(`/papyrus/scans/${id}/cancel`, undefined, true),
  copyStatus: (id: string, sg?: Sig) => get<CopyStatus>(`/papyrus/copy/${id}`, true, sg),
  cancelCopy: (id: string) => post<unknown>(`/papyrus/copy/${id}/cancel`, undefined, true),
  devices: (sg?: Sig) => get<Devices>('/kiosk/devices', true, sg),
  sendScan: (id: string, kind: 'smb' | 'email' | 'cloud' | 'paperless', query: Record<string, string | number> = {}, body: unknown = {}) =>
    post<{ message: string }>(`/papyrus/scans/${id}/${kind}${Object.keys(query).length ? qs(query) : ''}`, body),
  copy: (b: CopyReq) => post<{ message: string }>('/papyrus/copy', b, true),
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
  kioskStatus: (sg?: Sig) => get<KioskStatus>('/kiosk/status', true, sg),
  kioskConfig: (sg?: Sig) => get<KioskConfig>('/kiosk/config', true, sg),
  unlockStart: () => post<UnlockState>('/kiosk/unlock/start', undefined, true),
  unlockState: (sg?: Sig) => get<UnlockState>('/kiosk/unlock/state', true, sg),
  unlockMethods: (sg?: Sig) => get<LoginMethods>('/kiosk/unlock/methods', true, sg),
  /** No `q`: recent users. `q` (2+ chars): up to 8 prefix matches. `mode: 'pin'` keeps only users with a PIN. */
  unlockUsers: (o: { q?: string; mode?: 'pin' } = {}, sg?: Sig) => {
    const p = new URLSearchParams()
    if (o.q) p.set('q', o.q)
    if (o.mode) p.set('mode', o.mode)
    const s = p.toString()
    return get<LoginUser[]>('/kiosk/unlock/users' + (s ? `?${s}` : ''), true, sg)
  },
  unlockApprove: (user_id: string) => post<UnlockState>('/kiosk/unlock/approve', { user_id }, true),
  unlockPin: (user_id: string, pin: string) => post<UnlockState>('/kiosk/unlock/pin', { user_id, pin }, true),
  unlockTouch: () => post<UnlockState>('/kiosk/unlock/touch', undefined, true),
  lock: () => post<UnlockState>('/kiosk/lock', undefined, true),
  send: (b: { scan_id: string; targets: PresetTarget[]; post?: { ocr?: boolean; enhance?: boolean }; delete_after?: boolean }) => post<SendResp>('/kiosk/send', b, true),
  contacts: (sg?: Sig) => get<Contact[]>('/kiosk/contacts', true, sg),
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
