import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { X, ChevronLeft, ChevronRight, Rows3, Square, Maximize } from 'lucide-react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Spinner } from './ui'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const MAX_ZOOM = 5, GAP = 12, MAX_PX = 6_000_000 // canvas pixel cap (~24MB RGBA) for the Pi
type Size = { w: number; h: number }
type Doc = { kind: 'pdf'; pdf: PDFDocumentProxy; sizes: Size[] } | { kind: 'img'; url: string; sizes: Size[] }
type T = { z: number; x: number; y: number }

export interface ViewerProps {
  src: string
  mime?: string
  title?: string
  onClose: () => void
  actions?: ReactNode
}

async function load(src: string, mime: string | undefined, signal: AbortSignal): Promise<Doc> {
  const r = await fetch(src, { signal })
  if (!r.ok) throw new Error(`Failed to load (HTTP ${r.status})`)
  const buf = await r.arrayBuffer()
  let type = (mime || r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(5, buf.byteLength)))
  if (head === '%PDF-') type = 'application/pdf'
  if (type.includes('pdf')) {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
    const sizes = await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => {
      const v = (await pdf.getPage(i + 1)).getViewport({ scale: 1 })
      return { w: v.width, h: v.height }
    }))
    return { kind: 'pdf', pdf, sizes }
  }
  if (!type.startsWith('image/')) throw new Error(`Unsupported file type${type ? `: ${type}` : ''}`)
  const url = URL.createObjectURL(new Blob([buf], { type }))
  const sizes = await new Promise<Size[]>((res, rej) => {
    const im = new Image()
    im.onload = () => res([{ w: im.naturalWidth || 1, h: im.naturalHeight || 1 }])
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not decode image')) }
    im.src = url
  })
  return { kind: 'img', url, sizes }
}

function PageView({ doc, n, w, h, q, on }: { doc: Doc; n: number; w: number; h: number; q: number; on: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const cur = useRef<{ c: HTMLCanvasElement; page: PDFPageProxy } | null>(null)
  const free = (r: { c: HTMLCanvasElement; page: PDFPageProxy } | null) => {
    if (!r) return
    r.c.width = 0; r.c.height = 0; r.page.cleanup()
  }
  useEffect(() => {
    const el = box.current
    if (!el) return
    if (!on || doc.kind !== 'pdf') {
      if (doc.kind === 'pdf') { el.replaceChildren(); free(cur.current); cur.current = null }
      return
    }
    let dead = false, task: { cancel(): void } | null = null
    ;(async () => {
      const page = await doc.pdf.getPage(n + 1)
      const base = page.getViewport({ scale: 1 })
      let s = (w / base.width) * q * Math.min(window.devicePixelRatio || 1, 2)
      const px = base.width * s * base.height * s
      if (px > MAX_PX) s *= Math.sqrt(MAX_PX / px)
      const vp = page.getViewport({ scale: s })
      const c = document.createElement('canvas')
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height)
      c.style.cssText = 'width:100%;height:100%;display:block'
      let ok = false
      try {
        const t = page.render({ canvasContext: c.getContext('2d')!, viewport: vp })
        task = t
        await t.promise
        if (!dead) { const old = cur.current; el.replaceChildren(c); cur.current = { c, page }; free(old); ok = true }
      } finally {
        if (!ok) free({ c, page })
      }
    })().catch(() => {})
    return () => { dead = true; task?.cancel() }
  }, [doc, n, w, on, q])
  useEffect(() => () => { box.current?.replaceChildren(); free(cur.current); cur.current = null }, [])
  return (
    <div ref={box} className="absolute bg-white shadow-lg" style={{ width: w, height: h }}>
      {doc.kind === 'img' && <img src={doc.url} alt="" draggable={false} className="w-full h-full block select-none" />}
    </div>
  )
}

export default function Viewer({ src, mime, title, onClose, actions }: ViewerProps) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<'paged' | 'scroll'>('paged')
  const [page, setPage] = useState(0)
  const [vp, setVp] = useState<Size>({ w: 0, h: 0 })
  const [q, setQ] = useState(1)
  const [vis, setVis] = useState<[number, number]>([0, 0])
  const view = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const tf = useRef<T>({ z: 1, x: 0, y: 0 })
  const settle = useRef<number>()

  useEffect(() => {
    const ac = new AbortController()
    let d: Doc | null = null
    setErr(''); setDoc(null)
    load(src, mime, ac.signal).then((x) => {
      if (ac.signal.aborted) { if (x.kind === 'pdf') x.pdf.destroy(); else URL.revokeObjectURL(x.url); return }
      d = x; setDoc(x)
    }, (e) => { if (!ac.signal.aborted) setErr(e?.message || 'Failed to load') })
    return () => { ac.abort(); if (d?.kind === 'pdf') d.pdf.destroy(); if (d?.kind === 'img') URL.revokeObjectURL(d.url) }
  }, [src, mime])

  useLayoutEffect(() => {
    const el = view.current
    if (!el) return
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setVp({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [doc])

  const sizes = doc?.sizes ?? []
  const count = sizes.length
  const scroll = mode === 'scroll' && count > 1
  // layout: page rects in content space
  const layout = (() => {
    if (!doc || !vp.w) return { rects: [] as { y: number; w: number; h: number; x: number }[], cw: vp.w, ch: vp.h }
    if (!scroll) {
      const s = sizes[page]
      const f = Math.min(vp.w / s.w, vp.h / s.h)
      const w = s.w * f, h = s.h * f
      return { rects: [{ x: (vp.w - w) / 2, y: (vp.h - h) / 2, w, h }], cw: vp.w, ch: vp.h }
    }
    let y = GAP
    const rects = sizes.map((s) => {
      const w = vp.w, h = (s.h * w) / s.w
      const r = { x: 0, y, w, h }
      y += h + GAP
      return r
    })
    return { rects, cw: vp.w, ch: y }
  })()
  const L = useRef(layout)
  L.current = layout

  const clamp = (t: T): T => {
    const z = Math.min(MAX_ZOOM, Math.max(1, t.z))
    const cx = (a: number, c: number, v: number) => (c * z <= v ? (v - c * z) / 2 : Math.min(0, Math.max(v - c * z, a)))
    return { z, x: cx(t.x, L.current.cw, vp.w), y: cx(t.y, L.current.ch, vp.h) }
  }
  const updateVis = useCallback(() => {
    const { z, y } = tf.current
    const rs = L.current.rects
    if (!rs.length) return
    const top = -y / z, bot = top + vp.h / z, m = vp.h / z
    let a = rs.findIndex((r) => r.y + r.h > top - m), b = rs.length - 1
    while (b > 0 && rs[b].y > bot + m) b--
    if (a < 0) a = 0
    setVis((p) => (p[0] === a && p[1] === b ? p : [a, b]))
    // current page = one covering viewport middle
    const mid = top + vp.h / z / 2
    const cur = Math.max(0, rs.findIndex((r) => r.y + r.h + GAP / 2 > mid))
    if (L.current.rects.length > 1) setPage((p) => (p === cur ? p : cur))
  }, [vp.h])
  const apply = (t: T, quick = false) => {
    tf.current = clamp(t)
    const { z, x, y } = tf.current
    if (content.current) content.current.style.transform = `translate(${x}px,${y}px) scale(${z})`
    if (scroll) updateVis()
    clearTimeout(settle.current)
    settle.current = window.setTimeout(() => setQ(z > 3 ? 4 : z > 1.5 ? 2 : 1), quick ? 0 : 250)
  }

  // reset transform on layout change (mode / page / size)
  useLayoutEffect(() => {
    tf.current = clamp({ z: 1, x: 0, y: scroll ? tf.current.y : 0 })
    const { z, x, y } = tf.current
    if (content.current) content.current.style.transform = `translate(${x}px,${y}px) scale(${z})`
    setQ(1)
    if (scroll) updateVis(); else setVis([page, page])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, mode, page === undefined ? 0 : scroll ? -1 : page, vp.w, vp.h, scroll])

  const goto = (n: number) => setPage(Math.min(count - 1, Math.max(0, n)))
  const toMode = (m: 'paged' | 'scroll') => {
    if (m === 'scroll') { setMode(m); requestAnimationFrame(() => { const r = L.current.rects[page]; if (r) apply({ ...tf.current, y: -r.y + GAP }) }) }
    else setMode(m)
  }

  // gestures
  useEffect(() => {
    const el = view.current
    if (!el || !doc) return
    const ptrs = new Map<number, { x: number; y: number }>()
    let start = { x: 0, y: 0, t: 0 }, moved = 0, lastTap = { t: 0, x: 0, y: 0 }, pinch: { d: number; z: number } | null = null, swipeDx = 0
    const rel = (e: PointerEvent) => { const b = el.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top } }
    const zoomAt = (p: { x: number; y: number }, nz: number) => {
      const t = tf.current, z = Math.min(MAX_ZOOM, Math.max(1, nz))
      apply({ z, x: p.x - ((p.x - t.x) / t.z) * z, y: p.y - ((p.y - t.y) / t.z) * z })
    }
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('[data-ui]')) return
      el.setPointerCapture(e.pointerId)
      ptrs.set(e.pointerId, rel(e))
      if (ptrs.size === 1) { start = { ...rel(e), t: Date.now() }; moved = 0; swipeDx = 0 }
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: tf.current.z } }
    }
    const move = (e: PointerEvent) => {
      const prev = ptrs.get(e.pointerId)
      if (!prev) return
      const p = rel(e)
      ptrs.set(e.pointerId, p)
      if (ptrs.size >= 2 && pinch) {
        const [a, b] = [...ptrs.values()]
        zoomAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d))
        moved = 99
      } else if (ptrs.size === 1) {
        const dx = p.x - prev.x, dy = p.y - prev.y
        moved += Math.abs(dx) + Math.abs(dy)
        const t = tf.current
        if (!scroll && t.z <= 1.01) swipeDx += dx
        else apply({ ...t, x: t.x + dx, y: t.y + dy })
      }
    }
    const up = (e: PointerEvent) => {
      if (!ptrs.delete(e.pointerId)) return
      if (ptrs.size < 2) pinch = null
      if (ptrs.size) return
      const p = rel(e), now = Date.now()
      if (moved < 12 && now - start.t < 300) {
        if (now - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
          zoomAt(p, tf.current.z > 1.2 ? 1 : 2.5); lastTap = { t: 0, x: 0, y: 0 }
        } else lastTap = { t: now, x: p.x, y: p.y }
      } else if (!scroll && tf.current.z <= 1.01 && Math.abs(swipeDx) > 60) {
        setPage((n) => Math.min(count - 1, Math.max(0, n + (swipeDx < 0 ? 1 : -1))))
      }
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const b = el.getBoundingClientRect(), p = { x: e.clientX - b.left, y: e.clientY - b.top }
      if (e.ctrlKey) zoomAt(p, tf.current.z * Math.exp(-e.deltaY / 200))
      else apply({ ...tf.current, x: tf.current.x - e.deltaX, y: tf.current.y - e.deltaY })
    }
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, scroll, count, vp.w, vp.h])

  const multi = count > 1
  const rects = layout.rects
  return (
    <div className="fixed inset-0 z-50 bg-neutral-950 text-slate-100 flex flex-col select-none">
      <div data-ui className="flex items-center gap-2 p-2 bg-panel border-b border-line shrink-0">
        <button className="btn" onClick={onClose} aria-label="Close"><X /></button>
        <div className="flex-1 min-w-0 truncate text-lg font-semibold">{title}</div>
        {multi && <div className="text-lg tabular-nums px-2">{page + 1} / {count}</div>}
        {multi && <button className="btn" onClick={() => toMode(scroll ? 'paged' : 'scroll')} aria-label="Toggle view mode">{scroll ? <Square /> : <Rows3 />}</button>}
        <button className="btn" onClick={() => apply({ z: 1, x: 0, y: tf.current.y }, true)} aria-label="Fit"><Maximize /></button>
        {actions}
      </div>
      <div ref={view} className="flex-1 min-h-0 relative overflow-hidden" style={{ touchAction: 'none' }}>
        {!doc && !err && <div className="absolute inset-0 flex items-center justify-center gap-3 text-xl"><Spinner />Loading…</div>}
        {err && (
          <div data-ui className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="text-xl text-err">{err}</div>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        )}
        {doc && vp.w > 0 && (
          <div ref={content} className="absolute top-0 left-0 origin-top-left" style={{ width: layout.cw, height: layout.ch, willChange: 'transform' }}>
            {scroll
              ? rects.map((r, i) => (
                <div key={i} className="absolute" style={{ left: r.x, top: r.y }}>
                  <PageView doc={doc} n={i} w={r.w} h={r.h} q={q} on={i >= vis[0] && i <= vis[1]} />
                </div>))
              : rects[0] && (
                <div className="absolute" style={{ left: rects[0].x, top: rects[0].y }}>
                  <PageView doc={doc} n={page} w={rects[0].w} h={rects[0].h} q={q} on />
                </div>)}
          </div>
        )}
        {doc && multi && !scroll && (
          <>
            <button data-ui className="btn absolute left-2 top-1/2 -translate-y-1/2 !min-h-[96px] !min-w-[64px] opacity-80" disabled={page === 0} onClick={() => goto(page - 1)} aria-label="Previous page"><ChevronLeft size={36} /></button>
            <button data-ui className="btn absolute right-2 top-1/2 -translate-y-1/2 !min-h-[96px] !min-w-[64px] opacity-80" disabled={page === count - 1} onClick={() => goto(page + 1)} aria-label="Next page"><ChevronRight size={36} /></button>
          </>
        )}
      </div>
    </div>
  )
}
