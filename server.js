// Rook Agent Server v6 — HTML Design Renderer
// Claude generates HTML posts → Puppeteer renders to image
// 3 background options: Pexels (free), Ideogram (AI), Client photo

import Anthropic from '@anthropic-ai/sdk'
import express from 'express'
import cors from 'cors'
import puppeteer from 'puppeteer'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 3000
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const IDEOGRAM_KEY = process.env.IDEOGRAM_API_KEY
const PEXELS_KEY = process.env.PEXELS_API_KEY || 'FJGVEFZHBaGcVGhdIvzSYJOGmHCqpPmrihHOStpiN7wcCWEP43FHcbuz'

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

// Reusable browser instance
let browser = null
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
    })
  }
  return browser
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'rook-agent-server', version: '6.0.0', features: ['html-render', 'pexels', 'ideogram', '3-options'] })
})

// ── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }))

// ── Search Pexels for a background photo ─────────────────────
async function searchPexels(query, orientation = 'square') {
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=${orientation}`
    const r = await fetch(url, { headers: { Authorization: PEXELS_KEY } })
    const data = await r.json()
    if (data.photos?.length) {
      // Return the "large" size which is good for 1080px
      return data.photos[0].src.large2x || data.photos[0].src.large || data.photos[0].src.original
    }
  } catch (e) { console.warn('Pexels error:', e.message) }
  return null
}

// ── Generate background with Ideogram ────────────────────────
async function generateIdeogramBg(query, aspectRatio = 'ASPECT_1_1') {
  if (!IDEOGRAM_KEY) return null
  try {
    const r = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
      body: JSON.stringify({
        image_request: {
          prompt: query + ', background image, no text, no words, no letters',
          aspect_ratio: aspectRatio,
          model: 'V_2_TURBO',
          magic_prompt_option: 'AUTO',
        },
      }),
    })
    const data = await r.json()
    return data?.data?.[0]?.url || null
  } catch (e) { console.warn('Ideogram error:', e.message) }
  return null
}

// ── Claude generates HTML design for a post ──────────────────
async function generatePostHTML(piece, client, bgImageUrl = null) {
  const brandName = client.brand_name || client.name || ''
  const industry = client.industry || ''
  const col1 = client.brand_color_primary || '#e8553e'
  const col2 = client.brand_color_secondary || '#1a1a2e'
  const mood = client.brand_dna?.mood || client.brand_dna?.estilo_visual || 'profesional'
  const propuesta = client.brand_dna?.propuesta_valor || ''
  const isStory = ['story', 'reel'].includes(piece.format)
  const W = 1080
  const H = isStory ? 1920 : 1080

  const bgStyle = bgImageUrl
    ? `background: linear-gradient(rgba(0,0,0,0.65), rgba(0,0,0,0.8)), url('${bgImageUrl}') center/cover no-repeat;`
    : `background: linear-gradient(135deg, ${col1} 0%, ${col2} 100%);`

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    system: `You generate Instagram post HTML designs. Output ONLY the HTML inside a <div> with fixed dimensions. Use Inter font. The design must be premium, clean, and on-brand. Include the brand name, title, a short subtitle from the copy, and a CTA. Use the exact brand colors. Output ONLY the inner HTML content (no DOCTYPE, no html/head/body tags). Spanish text.`,
    messages: [{ role: 'user', content: `Design a ${W}x${H}px Instagram ${piece.format || 'post'} for:

BRAND: ${brandName} (${industry})
COLORS: primary ${col1}, secondary ${col2}
MOOD: ${mood}
TITLE: ${piece.title}
COPY: ${piece.caption?.slice(0, 150) || ''}
PROPUESTA: ${propuesta}

Background style (already applied to container): ${bgImageUrl ? 'dark photo overlay' : 'gradient'}

Create the inner content with:
- Brand name/logo area (top)
- Industry tag badge
- Large headline (the title)
- Subtitle (1-2 lines from copy)
- Optional stats or features if relevant
- CTA button
- Website/brand at bottom

Use position:absolute elements inside the container. All text in white/light colors.
Use font-family: Inter. Use the brand colors for accents.
Output ONLY the HTML content divs, no wrapper.` }],
  })

  const innerHtml = msg.content[0]?.text || ''

  // Wrap in full HTML document
  const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
* { margin:0; padding:0; box-sizing:border-box; }
body { width:${W}px; height:${H}px; overflow:hidden; font-family:'Inter',sans-serif; }
.post-container { width:${W}px; height:${H}px; position:relative; overflow:hidden; ${bgStyle} }
</style></head>
<body><div class="post-container">${innerHtml}</div></body></html>`

  return fullHtml
}

// ── Render HTML to image with Puppeteer ──────────────────────
async function renderHtmlToImage(html, width = 1080, height = 1080) {
  const b = await getBrowser()
  const page = await b.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 })
  // Wait for fonts to load
  await page.evaluate(() => document.fonts.ready)
  await new Promise(r => setTimeout(r, 500))
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 92 })
  await page.close()
  return screenshot // Buffer
}

// ══════════════════════════════════════════════════════════════
// MAIN ENDPOINT: Generate 3 design options for a post
// ══════════════════════════════════════════════════════════════
app.post('/generate-design', async (req, res) => {
  const { piece, client, clientPhotoUrl } = req.body

  if (!piece?.title || !client?.name) {
    return res.status(400).json({ error: 'Missing piece or client data' })
  }

  console.log(`[generate-design] Generating 3 options for "${piece.title}" (${client.name})`)
  const startTime = Date.now()

  const isStory = ['story', 'reel'].includes(piece.format)
  const W = 1080, H = isStory ? 1920 : 1080

  // Search terms for backgrounds
  const bgQuery = `${client.industry || ''} ${client.brand_dna?.propuesta_valor?.slice(0, 30) || ''} professional`.trim()

  try {
    // Step 1: Get 3 background options in parallel
    const [pexelsUrl, ideogramUrl] = await Promise.all([
      searchPexels(bgQuery, isStory ? 'portrait' : 'square'),
      generateIdeogramBg(bgQuery, isStory ? 'ASPECT_9_16' : 'ASPECT_1_1'),
    ])

    console.log(`[generate-design] Backgrounds: pexels=${!!pexelsUrl}, ideogram=${!!ideogramUrl}, client=${!!clientPhotoUrl}`)

    // Step 2: Generate 3 HTML versions (same design, different backgrounds)
    const [htmlPexels, htmlIdeogram, htmlClient] = await Promise.all([
      pexelsUrl ? generatePostHTML(piece, client, pexelsUrl) : null,
      ideogramUrl ? generatePostHTML(piece, client, ideogramUrl) : null,
      clientPhotoUrl ? generatePostHTML(piece, client, clientPhotoUrl) : generatePostHTML(piece, client, null), // gradient fallback
    ])

    // Step 3: Render all to images with Puppeteer
    const results = []

    if (htmlPexels) {
      const img = await renderHtmlToImage(htmlPexels, W, H)
      results.push({ source: 'pexels', image: `data:image/jpeg;base64,${img.toString('base64')}`, label: '🖼️ Foto profesional' })
    }

    if (htmlIdeogram) {
      const img = await renderHtmlToImage(htmlIdeogram, W, H)
      results.push({ source: 'ideogram', image: `data:image/jpeg;base64,${img.toString('base64')}`, label: '✨ IA creativa' })
    }

    if (htmlClient) {
      const img = await renderHtmlToImage(htmlClient, W, H)
      const label = clientPhotoUrl ? '📷 Tu foto' : '🎨 Diseño puro'
      results.push({ source: clientPhotoUrl ? 'client' : 'gradient', image: `data:image/jpeg;base64,${img.toString('base64')}`, label })
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[generate-design] Done: ${results.length} options in ${elapsed}s`)

    return res.json({
      success: true,
      options: results,
      elapsed: parseFloat(elapsed),
    })
  } catch (e) {
    console.error('[generate-design] Error:', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// ══════════════════════════════════════════════════════════════
// BATCH: Generate designs for multiple pieces
// ══════════════════════════════════════════════════════════════
app.post('/generate-batch', async (req, res) => {
  const { pieces, client, clientPhotoUrl } = req.body
  if (!pieces?.length || !client) return res.status(400).json({ error: 'Missing pieces or client' })

  console.log(`[batch] Generating ${pieces.length} designs for ${client.name}`)
  const results = []

  for (const piece of pieces.slice(0, 10)) { // Max 10 at a time
    try {
      const bgQuery = `${client.industry || ''} professional`
      const pexelsUrl = await searchPexels(bgQuery, ['story', 'reel'].includes(piece.format) ? 'portrait' : 'square')
      const html = await generatePostHTML(piece, client, pexelsUrl)
      const isStory = ['story', 'reel'].includes(piece.format)
      const img = await renderHtmlToImage(html, 1080, isStory ? 1920 : 1080)
      results.push({
        pieceId: piece.id,
        title: piece.title,
        image: `data:image/jpeg;base64,${img.toString('base64')}`,
        source: pexelsUrl ? 'pexels' : 'gradient',
      })
    } catch (e) {
      results.push({ pieceId: piece.id, title: piece.title, error: e.message })
    }
  }

  return res.json({ success: true, results })
})

app.listen(PORT, () => console.log(`Rook Agent Server v6 running on port ${PORT}`))
