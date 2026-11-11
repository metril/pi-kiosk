import { useEffect, useSyncExternalStore } from 'react'
import { api, type KioskConfig } from './api'

function makeStore<S>(init: S) {
  let state = init
  const ls = new Set<() => void>()
  return {
    get: () => state,
    set: (s: S) => { state = s; ls.forEach((l) => l()) },
    sub: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  }
}

/** In-flight long operations; survive tab switches. */
export type BusyKey = 'copy' | 'scan'
const busy = makeStore<Record<BusyKey, boolean>>({ copy: false, scan: false })
export const setBusy = (k: BusyKey, v: boolean) => busy.set({ ...busy.get(), [k]: v })
export const isBusy = (k: BusyKey) => busy.get()[k]
export const useBusy = () => useSyncExternalStore(busy.sub, busy.get)

/** Kiosk runtime config: fetched once at start, retried every 30s until it succeeds. */
const cfg = makeStore<KioskConfig | null>(null)
let started = false
export function startConfig() {
  if (started) return
  started = true
  const load = () => api.kioskConfig().then(cfg.set).catch(() => setTimeout(load, 30_000))
  load()
}
/** Refetch /kiosk/config when the polled config_rev differs from the loaded one (no reload). */
let fetching: number | string | undefined
export function syncConfigRev(rev: number | string | undefined) {
  const cur = cfg.get()
  if (rev === undefined || !cur || cur.config_rev === rev || fetching === rev) return
  fetching = rev
  api.kioskConfig().then(cfg.set).catch(() => {}).finally(() => { fetching = undefined })
}
export function useConfig() {
  useEffect(startConfig, [])
  return useSyncExternalStore(cfg.sub, cfg.get)
}
