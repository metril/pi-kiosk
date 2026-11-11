import { useSyncExternalStore } from 'react'
import { api, setLockedHandler, type UnlockState } from './api'

type Fn = () => void
const ls = new Set<Fn>()
let state: UnlockState = { state: 'locked' }
let modal = false
let waiters: ((ok: boolean) => void)[] = []
const emit = () => ls.forEach((l) => l())
const sub = (l: Fn) => (ls.add(l), () => void ls.delete(l))
export const useSession = () => useSyncExternalStore(sub, () => state)
export const useUnlockOpen = () => useSyncExternalStore(sub, () => modal)

export function setSession(s: UnlockState) {
  state = s
  if (s.state === 'unlocked' && modal) closeUnlock(true)
  emit()
}
export function openUnlock(): Promise<boolean> {
  modal = true; emit()
  return new Promise((r) => waiters.push(r))
}
export function closeUnlock(ok: boolean) {
  modal = false
  const w = waiters; waiters = []
  w.forEach((r) => r(ok))
  emit()
}
/** Resolves true if already unlocked or after the user unlocks. */
export const ensureUnlocked = () => (state.state === 'unlocked' ? Promise.resolve(true) : openUnlock())
setLockedHandler(() => {
  if (state.state === 'unlocked') {  // stale local state: refresh, then let the retry decide
    return api.unlockState().then((s) => { setSession(s); return s.state === 'unlocked' || openUnlock() }).catch(() => false)
  }
  return openUnlock()
})
