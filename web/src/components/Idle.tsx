import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useConfig, syncConfigRev, setAsleepFlag } from '../store'
import { usePoll } from '../hooks'

/** Black overlay after idle; first touch wakes the screen and is swallowed. */
export default function Idle() {
  const [asleep, setAsleep] = useState(false)
  const last = useRef(Date.now())
  const mins = useRef(0)
  const cfg = useConfig()
  mins.current = cfg?.idle_minutes ?? 0
  const sleepRef = useRef(false)
  sleepRef.current = asleep
  useEffect(() => { setAsleepFlag(asleep) }, [asleep])

  // Sync with server-side screen state (Home Assistant can switch it / reload the page).
  const { data: scr } = usePoll((sg) => api.screenState(sg), 2000)
  const prevOn = useRef<boolean | null>(null)
  const seq0 = useRef<number | null>(null)
  useEffect(() => {
    if (!scr) return
    syncConfigRev(scr.config_rev)
    if (seq0.current === null) seq0.current = scr.reload_seq
    else if (scr.reload_seq !== seq0.current) { location.reload(); return }
    // Act on transitions only, so a stale poll or a backlight-less kiosk can't undo local sleep.
    if (prevOn.current !== scr.on) {
      if (scr.on && sleepRef.current) { setAsleep(false); last.current = Date.now() }
      else if (!scr.on && !sleepRef.current) setAsleep(true)
    }
    prevOn.current = scr.on
  }, [scr])

  useEffect(() => {
    const touch = () => { if (!sleepRef.current) last.current = Date.now() }
    document.addEventListener('pointerdown', touch, true)
    const t = setInterval(() => {
      if (mins.current > 0 && !sleepRef.current && Date.now() - last.current > mins.current * 60_000) {
        setAsleep(true); api.screen(false).catch(() => {})
      }
    }, 5000)
    return () => { document.removeEventListener('pointerdown', touch, true); clearInterval(t) }
  }, [])

  if (!asleep) return null
  const wake = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation() }
  const up = (e: React.SyntheticEvent) => { wake(e); last.current = Date.now(); setTimeout(() => setAsleep(false), 350) }
  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => { wake(e); api.screen(true).catch(() => {}) }}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={wake}
    />
  )
}
