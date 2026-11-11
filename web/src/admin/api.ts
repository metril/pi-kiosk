export type Secret = { set: boolean } | string | null
export interface Target { type: 'smb' | 'paperless' | 'email'; share_id?: string; path?: string; contact_id?: string }
export interface Preset {
  id: string; label: string; icon: string; scan: Record<string, unknown>
  post: { ocr?: boolean; enhance?: boolean }; delete_after: boolean; targets: Target[]
}
export interface Config {
  name: string; public_url: string
  unlock: { idle_s: number; max_s: number }; screen: { idle_minutes: number }
  contacts: string[]; presets: Preset[]
  labelmaker: { url: string; token?: Secret } | null
  mqtt: { host: string; port: number; username: string; password?: Secret; tls: boolean; ca_pem: string
    tls_insecure: boolean; discovery_prefix: string; node_id: string } | null
}
export interface Contact { id: string; name: string; email: string }
export interface Share { id: string; name: string }
export interface View {
  config: Config; persisted: boolean; cache: { contacts: Contact[]; smb_shares: Share[] }
  links: { contacts: string; kiosk_token: string }
}
export interface Status {
  version: string; uptime_s: number; mqtt: { enabled: boolean; connected: boolean }
  papyrus_last_contact: number | null; config_rev: number; links: View['links']
}

export class ApiError extends Error { constructor(public status: number, public body: any) { super(body?.error?.code || `HTTP ${status}`) } }
let onUnauth: () => void = () => {}
export const setUnauth = (f: () => void) => { onUnauth = f }

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const h: Record<string, string> = {}
  if (method !== 'GET') h['X-Kiosk-Admin'] = '1'
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const r = await fetch('/admin/api/' + path, { method, headers: h, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) })
  let j: any = null
  try { j = await r.json() } catch { /* empty */ }
  if (r.status === 401 && !path.startsWith('login')) onUnauth()
  if (!r.ok) throw new ApiError(r.status, j)
  return j as T
}
