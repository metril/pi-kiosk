import { useEffect, useSyncExternalStore } from 'react'
import { api, type Devices, type LabelStatus } from './api'
import { makeStore } from './store'

/** Device status that survives screen remounts and sleep/wake (no "Checking…" flash). */
export interface StatusState {
  devices: Devices | null; labels: LabelStatus | null; held: number | null
  err: { devices: boolean; labels: boolean; held: boolean }
  devicesAt: number // Date.now() when devices last arrived
}
const st = makeStore<StatusState>({ devices: null, labels: null, held: null, err: { devices: false, labels: false, held: false }, devicesAt: 0 })
export const useStatus = () => useSyncExternalStore(st.sub, st.get)

let inflight: Promise<void> | null = null
/** One refresh of everything; failures keep the last good values. */
export function refreshStatus(): Promise<void> {
  if (inflight) return inflight
  inflight = Promise.allSettled([api.devices(), api.labelStatus(), api.heldJobs()]).then(([d, l, h]) => {
    const c = st.get()
    st.set({
      devices: d.status === 'fulfilled' ? d.value : c.devices,
      labels: l.status === 'fulfilled' ? l.value : c.labels,
      held: h.status === 'fulfilled' ? h.value.total : c.held,
      err: { devices: d.status === 'rejected', labels: l.status === 'rejected', held: h.status === 'rejected' },
      devicesAt: d.status === 'fulfilled' ? Date.now() : c.devicesAt,
    })
  }).finally(() => { inflight = null })
  return inflight
}

/** The single 15 s poller; runs only while active (unlocked and awake). */
export function useStatusPoller(active: boolean) {
  useEffect(() => {
    if (!active) return
    refreshStatus()
    const t = setInterval(refreshStatus, 15_000)
    return () => clearInterval(t)
  }, [active])
}

/** Age text when that device's data is stale, else undefined. */
export function staleText(s: StatusState, k: 'printer' | 'scanner'): string | undefined {
  const d = s.devices
  if (!d || !(d[`${k}_stale`] || s.err.devices)) return undefined
  const sec = (d[`${k}_age_s`] ?? 0) + Math.floor((Date.now() - s.devicesAt) / 1000)
  return sec < 60 ? 'Updated just now' : `Updated ${Math.floor(sec / 60)}m ago`
}
