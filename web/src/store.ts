import { useEffect, useSyncExternalStore } from 'react'
import { api, type KioskConfig } from './api'

export function makeStore<S>(init: S) {
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
/** Details of the running job (overlay title, settings, timer, copy id, cancel state). */
export interface BusyInfo { title: string; line?: string; startedAt: number; copyId?: string; scanId?: string; noCancel?: boolean; sending?: boolean; cancelling?: boolean }
const infos = makeStore<Partial<Record<BusyKey, BusyInfo>>>({})
export const useBusyInfo = () => useSyncExternalStore(infos.sub, infos.get)
export const getBusyInfo = (k: BusyKey) => infos.get()[k]
export const patchBusyInfo = (k: BusyKey, p: Partial<BusyInfo>) => { const c = infos.get()[k]; if (c) infos.set({ ...infos.get(), [k]: { ...c, ...p } }) }
export const startBusy = (k: BusyKey, i: Omit<BusyInfo, 'startedAt'>) => { infos.set({ ...infos.get(), [k]: { ...i, startedAt: Date.now() } }); busy.set({ ...busy.get(), [k]: true }) }
export const setBusy = (k: BusyKey, v: boolean) => { busy.set({ ...busy.get(), [k]: v }); if (!v) infos.set({ ...infos.get(), [k]: undefined }) }
export const isBusy = (k: BusyKey) => busy.get()[k]
export const useBusy = () => useSyncExternalStore(busy.sub, busy.get)

/** Kiosk runtime config: fetched once at start, retried every 30s until it succeeds. */
const cfg = makeStore<KioskConfig | null>(null)
let started = false
let gen = 0
const load = (g: number) => api.kioskConfig().then((c) => { if (g === gen) cfg.set(c) }).catch(() => { if (g === gen) setTimeout(() => load(g), g ? 5_000 : 30_000) })
export function startConfig() {
  if (started) return
  started = true
  load(gen)
}
/** Refetch config (after unlock/lock); clear=true drops the old (sensitive) copy first. */
export function reloadConfig(clear: boolean) {
  gen++
  if (clear) cfg.set(null)
  started = true
  load(gen)
}

/** True while the black idle overlay is up. */
const asleep = makeStore(false)
export const setAsleepFlag = asleep.set
export const useAsleep = () => useSyncExternalStore(asleep.sub, asleep.get)
/** Refetch /kiosk/config when the polled config_rev differs from the loaded one (no reload). */
let fetching: number | string | undefined
export function syncConfigRev(rev: number | string | undefined) {
  const cur = cfg.get()
  if (rev === undefined || !cur || cur.config_rev === rev || fetching === rev) return
  fetching = rev
  const g = gen
  api.kioskConfig().then(c => { if (g === gen) cfg.set(c) }).catch(() => {}).finally(() => { fetching = undefined })
}
export function useConfig() {
  useEffect(startConfig, [])
  return useSyncExternalStore(cfg.sub, cfg.get)
}
