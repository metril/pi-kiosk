import { useSyncExternalStore } from 'react'
import { api, setLockedHandler, type UnlockState } from './api'
import { reloadConfig } from './store'

type Fn = () => void
const ls = new Set<Fn>()
let state: UnlockState = { state: 'locked' }
let everUnlocked = false
const emit = () => ls.forEach((l) => l())
const sub = (l: Fn) => (ls.add(l), () => void ls.delete(l))
export const useSession = () => useSyncExternalStore(sub, () => state)
export const getSession = () => state
/** True once this page load has seen an unlocked session (so a Lock press restarts sign-in at once). */
export const wasUnlocked = () => everUnlocked

export function setSession(s: UnlockState) {
  const was = state.state === 'unlocked', now = s.state === 'unlocked'
  state = s
  if (now) everUnlocked = true
  if (was !== now) reloadConfig(!now)  // drop sensitive config on lock, fetch full config on unlock
  emit()
}
// Fallback: any "locked" response means the server session is gone; drop to the Lock screen.
setLockedHandler(() => { if (state.state === 'unlocked') setSession({ state: 'locked' }); api.unlockState().then(setSession).catch(() => {}) })
