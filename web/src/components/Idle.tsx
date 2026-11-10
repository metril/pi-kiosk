import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useConfig } from '../store'

/** Black overlay after idle; first touch wakes the screen and is swallowed. */
export default function Idle() {
  const [asleep, setAsleep] = useState(false)
  const last = useRef(Date.now())
  const mins = useRef(0)
  const cfg = useConfig()
  mins.current = cfg?.idle_minutes ?? 0
  const sleepRef = useRef(false)
  sleepRef.current = asleep

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
