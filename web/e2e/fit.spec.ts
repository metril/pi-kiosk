import { test, expect, type Page } from '@playwright/test'

const SHOTS = process.env.SHOTS_DIR ?? 'e2e/shots'

// ---- mock data
const ICONS = ['file-text', 'receipt', 'image', 'book', 'mail', 'folder', 'archive', 'scan']
const presets = ICONS.map((icon, i) => ({ id: `p${i}`, label: ['Paperless Documents', 'Receipts', 'Photos', 'Book scan', 'Mail to Alex', 'Family folder', 'Archive', 'Quick scan'][i], icon, needs_unlock: i % 2 === 0, targets: i === 7 ? [] : [{ type: 'paperless' }] }))
const contacts = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: ['Alexandra', 'Bob', 'Carol Smith', 'Dmitri', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Karl', 'Liam Johnson'][i] }))
const files = [
  ...Array.from({ length: 4 }, (_, i) => ({ name: `Folder ${i + 1}`, path: `Folder ${i + 1}`, is_dir: true })),
  ...Array.from({ length: 30 }, (_, i) => ({ name: `Document number ${i + 1} with a rather long file name.pdf`, path: `doc${i + 1}.pdf`, is_dir: false, id: `f${i}` })),
]
const scans = Array.from({ length: 10 }, (_, i) => ({ id: i, scan_id: `s${i}`, status: 'completed', resolution: 300, mode: 'Color', format: 'pdf', source: 'Flatbed', page_count: 1 + (i % 4), error_message: null, created_at: '2026-11-10T10:00:00Z' }))
const jobs = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, title: `Quarterly report ${i + 1}.pdf`, status: 'held', copies: 1 + (i % 3), duplex: i % 2 === 0, media: 'A4', has_pin: i % 2 === 1, source_type: 'upload', created_at: '2026-11-10T10:00:00Z' }))
const lpresets = Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, name: `Label preset ${i + 1}`, favorite: i < 2, label_type: 'text', tape_family: 'tze', tape_width_mm: 12 }))
const hist = Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, status: 'done', label_count: 1, kind: 'text', created_at: '2026-11-10T10:00:00Z', error: null, thumbnail_url: null }))

function pdf(pages: number) {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pages} >>`]
  for (let i = 0; i < pages; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>')
  let out = '%PDF-1.4\n'; const off: number[] = []
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`
  return Buffer.from(out, 'latin1')
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="120"><rect width="90" height="120" fill="#fff"/><rect x="10" y="10" width="70" height="8" fill="#333"/></svg>'

async function mock(page: Page, st: { unlocked: boolean }) {
  const json = (route: any, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/(papyrus|labels|kiosk)\//, (route) => {
    const u = new URL(route.request().url()); const p = u.pathname; const m = route.request().method()
    if (p === '/kiosk/contacts') return json(route, [{ id: 'me', name: 'Me (me@example.com)' }, ...contacts])
    if (p === '/kiosk/config') return json(route, { idle_minutes: 0, name: 'Kiosk', public_url: 'https://print.example.com/phone', unlock: { idle_s: 300, max_s: 900 }, presets, destinations: { paperless: true, smb: null, cloud: null } })
    if (p === '/kiosk/unlock/state' || p === '/kiosk/unlock/touch' || p === '/kiosk/lock')
      return json(route, st.unlocked ? { state: 'unlocked', user: 'alexandra.longname', remaining_s: 540, idle_remaining_s: 200 } : { state: 'pending', qr_uri: 'https://auth.example.com/device?c=ABCD1234', user_code: 'ABCD-1234', expires_in: 300 })
    if (p === '/kiosk/unlock/start') return json(route, { state: 'pending', qr_uri: 'https://auth.example.com/device?c=ABCD1234', user_code: 'ABCD-1234', expires_in: 300 })
    if (p === '/kiosk/send') return json(route, { post: {}, results: [{ type: 'cloud', ok: true }, { type: 'smb', ok: true }, { type: 'paperless', ok: false, error: 'Upstream error' }], all_ok: false, deleted: false })
    if (p === '/kiosk/status') return json(route, { printer_ready: true, scanner_ready: false })
    if (p === '/kiosk/screen') return json(route, { on: true, brightness: null, max: null, reload_seq: 0 })
    if (p === '/papyrus/printers/default/status') return json(route, { state: 3, state_message: 'Idle', accepting_jobs: true, state_reasons: [], markers: [{ name: 'Black', level: 8, color: '#000' }] })
    if (p === '/papyrus/scanners/default/status') return json(route, { available: true, device: 'x', busy: false })
    if (p === '/papyrus/scanners/default/options') return json(route, { resolutions: [150, 300, 600], modes: ['Color', 'Gray'], formats: ['pdf', 'jpeg'], feeder_formats: ['pdf'], sources: ['Flatbed', 'ADF'] })
    if (p === '/papyrus/scan-profiles') return json(route, Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: ['Document', 'Photo', 'Receipt', 'Book', 'Legal', 'Draft'][i], resolution: 300, color_mode: 'Color', format: 'pdf', source: 'Flatbed', ocr_enabled: false })))
    if (p === '/papyrus/scans') return json(route, { items: scans, total: 10, limit: 10, offset: 0 })
    if (p === '/papyrus/jobs') return json(route, { items: jobs, total: 8, limit: 50, offset: 0 })
    if (/\/papyrus\/jobs\/\d+\/release/.test(p)) return json(route, { detail: 'pin required' }, 403)
    if (p === '/papyrus/smb/shares') return json(route, [1, 2, 3, 4].map((i) => ({ id: String(i), name: `Share ${i}` })))
    if (p.startsWith('/papyrus/smb/browse/')) return json(route, files)
    if (p === '/papyrus/cloud/providers') return json(route, [{ id: 1, provider: 'gdrive' }, { id: 2, provider: 'dropbox' }])
    if (p.startsWith('/papyrus/cloud/files/')) return json(route, files)
    if (p.includes('/download')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf(5) })
    if (p.includes('thumbnail')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG })
    if (p === '/labels/printer/status') return json(route, { connected: true, error: null, error_code: null, printer_mode: 'x' })
    if (p === '/labels/presets') return json(route, lpresets)
    if (p === '/labels/history') return json(route, { items: hist })
    return json(route, {}, m === 'GET' ? 200 : 200)
  })
}

async function check(page: Page, name: string) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
  const r = await page.evaluate(() => {
    const issues: string[] = []
    const se = document.scrollingElement!
    if (se.scrollHeight > 480) issues.push(`page scrollHeight ${se.scrollHeight}`)
    if (se.scrollWidth > 800) issues.push(`page scrollWidth ${se.scrollWidth}`)
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      if (el.hasAttribute('data-scroll')) continue
      const o = getComputedStyle(el)
      if (/(auto|scroll)/.test(o.overflowY + o.overflowX) && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) issues.push(`scrollable ${el.tagName}.${String(el.className).slice(0, 50)}`)
    }
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('button'))) {
      const bb = b.getBoundingClientRect()
      if (bb.width && (bb.height < 43.5 || bb.width < 43.5)) issues.push(`small target ${Math.round(bb.width)}x${Math.round(bb.height)} "${(b.textContent || b.getAttribute('aria-label') || '').slice(0, 20)}"`)
      if (bb.width && !b.closest('[data-scroll]') && (bb.bottom > 480.5 || bb.right > 800.5)) issues.push(`button off-screen "${(b.textContent || '').slice(0, 20)}"`)
    }
    // header children must not overlap
    const hdr = document.querySelector('header')
    if (hdr) {
      const kids = Array.from(hdr.querySelectorAll<HTMLElement>('h1, button, header > div')).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0)
      const chip = document.querySelector('header > div:last-child')?.getBoundingClientRect()
      const btns = Array.from(hdr.querySelectorAll('button')).filter((b) => !b.closest('header > div:last-child')).map((b) => b.getBoundingClientRect())
      if (chip && chip.width) for (const b of btns) if (b.right > chip.left + 0.5 && b.left < chip.right) issues.push('chip overlaps header button')
      void kids
    }
    return issues
  })
  expect(r, name).toEqual([])
}

const tab = (page: Page, label: string) => page.locator('nav button', { hasText: label }).click()

test('every screen fits 800x480', async ({ page }) => {
  const st = { unlocked: true }
  await mock(page, st); page.setDefaultTimeout(6000)
  await page.goto('/')
  await page.waitForSelector('text=Paperless Documents')
  await check(page, '01-home-p1')
  await page.getByLabel('Next page').click(); await check(page, '02-home-p2')
  await page.getByLabel('Previous page').click()
  await page.getByText('Show QR').click().catch(async () => { await page.getByLabel('Next page').click(); await page.getByText('Show QR').click() })
  await check(page, '03-home-qr'); await page.mouse.click(400, 240)

  await tab(page, 'Scan'); await page.waitForSelector('text=Results'); await check(page, '04-scan')
  await page.getByLabel('Next page').first().click(); await check(page, '04b-scan-profiles-p2')
  await page.locator('button', { hasText: 'Actions' }).first().click(); await check(page, '05-scan-actions')
  await page.getByText('Send', { exact: true }).click(); await check(page, '06-send-main')
  await page.getByText('Email', { exact: true }).click(); await check(page, '07-send-contacts')
  await page.getByText('Done').click()
  await page.getByText('Cloud', { exact: true }).click(); await page.waitForSelector('text=Google Drive #1'); await check(page, '08-send-providers')
  await page.getByText('Google Drive #1').click(); await page.waitForSelector('text=Folder 1'); await check(page, '09-send-folder')
  await page.getByText('Use this folder').click()
  await page.getByText('Share', { exact: true }).click(); await page.getByText('Share 1').click(); await page.getByText('Use this folder').click()
  await page.getByText('Paperless', { exact: true }).click(); await check(page, '10-send-targets')
  await page.locator('.btn-ok', { hasText: 'Send to' }).click(); await check(page, '11-send-results')
  await page.getByText('Close', { exact: true }).first().click()

  await tab(page, 'Copy'); await check(page, '12-copy')
  await tab(page, 'Queue'); await page.waitForSelector('text=Quarterly report 1'); await check(page, '13-queue')
  await page.locator('button', { hasText: 'Release' }).first().click(); await page.waitForSelector('text=Enter release PIN'); await check(page, '14-queue-pin')
  await page.getByText('Cancel', { exact: true }).last().click()
  await tab(page, 'Labels'); await page.waitForSelector('text=Label preset 1'); await check(page, '15-labels')
  await page.getByLabel('Next page').click(); await check(page, '16-labels-p2')

  await tab(page, 'Files'); await page.waitForSelector('text=Share 1'); await check(page, '17-files-shares')
  await page.getByText('Share 1').click(); await page.waitForSelector('text=Document number 1 with'); await check(page, '18-files-folder')
  await page.getByText('Document number 1 with').first().click(); await check(page, '19-print-dialog')
  await page.getByText('Preview').click(); await page.waitForTimeout(1200); await check(page, '20-viewer')
  await page.getByLabel('Toggle view mode').click(); await page.waitForTimeout(600); await check(page, '21-viewer-scroll')
  await page.getByLabel('Close').click()

  // lock: the session ends server-side; the kiosk drops to the full-screen Lock screen
  st.unlocked = false
  await page.waitForSelector('text=ABCD-1234', { timeout: 15000 }); await check(page, '22-lock-screen')
  expect(await page.locator('nav').count()).toBe(0)
})
