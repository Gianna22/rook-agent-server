// Rook Agent Server — Claude AI agent with Canva design generation
// Runs on Railway, accepts requests from the Vercel app

import Anthropic from '@anthropic-ai/sdk'
import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 3000
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'rook-agent-server', version: '2.0.0' })
})

// ── Helper: poll an async Canva job until done ───────────────
async function pollCanvaJob(url, token, maxAttempts = 15, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const data = await r.json()
    if (data.job?.status === 'success') return data
    if (data.job?.status === 'failed') throw new Error('Canva job failed')
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error('Canva job timed out')
}

// ── Ideogram fallback function ───────────────────────────────
async function generateWithIdeogram(req, res) {
  const { title, brandName, industry, colors, format, mood, visualStyle } = req.body
  const IDEOGRAM_KEY = process.env.IDEOGRAM_API_KEY
  if (!IDEOGRAM_KEY) return res.status(500).json({ error: 'No image generation service available' })

  const query = `${title}. ${brandName} ${industry}. Professional social media design. Brand colors ${colors?.primary} ${colors?.secondary}. ${visualStyle || mood || 'professional'} style.`
  const aspect = ['story', 'reel'].includes(format) ? 'ASPECT_9_16' : 'ASPECT_1_1'

  try {
    const r = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
      body: JSON.stringify({
        image_request: { prompt: query, aspect_ratio: aspect, model: 'V_2_TURBO', style_type: 'DESIGN', magic_prompt_option: 'AUTO' },
      }),
    })
    const data = await r.json()
    const url = data?.data?.[0]?.url
    if (url) return res.json({ url, source: 'ideogram' })
    throw new Error('No URL returned from Ideogram')
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}

// ── Generate design with Canva template editing ──────────────
app.post('/generate-design', async (req, res) => {
  try {
    const {
      title,
      caption,
      format,
      brandName,
      industry,
      colors,
      tone,
      visualStyle,
      mood,
      avoid,
      targetAudience,
      description,
      logoUrl,
      canvaToken,
    } = req.body

    if (!title) return res.status(400).json({ error: 'Missing title' })

    // If no Canva token, go straight to Ideogram
    if (!canvaToken) {
      return await generateWithIdeogram(req, res)
    }

    const isStory = ['story', 'reel'].includes(format)
    const designType = isStory ? 'story' : 'post'

    // ── Step 1: Search for a matching template ───────────────
    const searchQuery = `${industry || 'business'} instagram ${designType}`
    console.log('[agent] Searching Canva for:', searchQuery)

    const searchRes = await fetch(
      `https://api.canva.com/rest/v1/designs?query=${encodeURIComponent(searchQuery)}&ownership=any&sort_by=relevance`,
      { headers: { 'Authorization': `Bearer ${canvaToken}` } }
    )
    const searchData = await searchRes.json()

    if (!searchRes.ok || !searchData.items?.length) {
      console.log('[agent] No Canva templates found, falling back to Ideogram')
      return await generateWithIdeogram(req, res)
    }

    // Pick the first suitable template
    const template = searchData.items[0]
    const designId = template.id
    console.log('[agent] Found template:', template.title, designId)

    // ── Step 2: Get design content (text elements) ───────────
    const contentRes = await fetch(
      `https://api.canva.com/rest/v1/designs/${designId}/content?content_types=richtexts`,
      { headers: { 'Authorization': `Bearer ${canvaToken}` } }
    )
    const contentData = await contentRes.json()

    if (!contentRes.ok) {
      console.warn('[agent] Failed to get design content:', contentData)
      // Try returning the template as-is with edit URL
      return res.json({
        url: template.thumbnail?.url,
        editUrl: template.urls?.edit_url || `https://www.canva.com/design/${designId}`,
        designId,
        source: 'canva-template-unedited',
        templateTitle: template.title,
      })
    }

    const richtexts = contentData.richtexts || []
    console.log('[agent] Text elements found:', richtexts.length)

    // ── Step 3: Start editing transaction ────────────────────
    const editRes = await fetch(
      `https://api.canva.com/rest/v1/designs/${designId}/editing/transactions`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    )
    const editData = await editRes.json()

    if (!editRes.ok) {
      console.warn('[agent] Failed to start editing transaction:', editData)
      return await generateWithIdeogram(req, res)
    }

    const transactionId = editData.transaction?.transaction_id
    // Use richtexts from edit response if available, otherwise use content response
    const editRichtexts = editData.richtexts || richtexts
    console.log('[agent] Editing transaction started:', transactionId, 'Text elements:', editRichtexts.length)

    // ── Step 4: Build text replacements with Claude ──────────
    const textElements = editRichtexts
      .filter(rt => rt.regions?.length > 0)
      .map(rt => ({
        elementId: rt.element_id,
        text: rt.regions.map(r => r.text).join(''),
      }))

    if (textElements.length > 0) {
      const mappingResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Map these template text elements to brand content. For each element, provide the replacement text.

TEMPLATE TEXTS:
${textElements.map((t, i) => `${i}. "${t.text}" (element: ${t.elementId})`).join('\n')}

BRAND CONTENT TO USE:
- Brand name: ${brandName}
- Title: ${title}
- Description: ${description || caption || ''}
- CTA: "Pedi tu demo" or "Contactanos" or "Mas info"
- Website: ${brandName?.toLowerCase().replace(/\s/g, '')}.com.ar
- Tone: ${tone}

Rules:
- Replace company names with "${brandName}"
- Replace main headlines with "${title}"
- Replace descriptions with relevant brand content
- Replace CTAs with Spanish CTAs
- Replace URLs with brand URL
- Keep it SHORT -- match the original text length approximately

Respond ONLY with JSON array:
[{"elementId": "...", "findText": "original text", "replaceText": "new text"}, ...]`
        }],
      })

      const mappingText = mappingResponse.content[0]?.text || ''
      const jsonMatch = mappingText.match(/\[[\s\S]*\]/)

      if (jsonMatch) {
        try {
          const mappings = JSON.parse(jsonMatch[0])

          // ── Step 5: Perform editing operations ─────────────
          const operations = mappings.map(m => ({
            type: 'find_and_replace_text',
            element_id: m.elementId,
            find_text: m.findText,
            replace_text: m.replaceText,
          }))

          if (operations.length > 0) {
            const opsRes = await fetch(
              `https://api.canva.com/rest/v1/designs/${designId}/editing/transactions/${transactionId}/operations`,
              {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ operations, page_index: 1 }),
              }
            )
            const opsData = await opsRes.json()
            console.log('[agent] Edit operations result:', opsRes.status)

            // Get thumbnail from edit response if available
            const thumbnail = opsData.thumbnails?.[0]?.url

            // ── Step 6: Commit the editing transaction ───────
            const commitRes = await fetch(
              `https://api.canva.com/rest/v1/designs/${designId}/editing/transactions/${transactionId}/commit`,
              {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              }
            )
            console.log('[agent] Commit result:', commitRes.status)

            // ── Step 7: Export design as image ───────────────
            let exportUrl = thumbnail
            try {
              const expRes = await fetch('https://api.canva.com/rest/v1/exports', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  design_id: designId,
                  format: { type: 'jpg' },
                }),
              })
              const expData = await expRes.json()

              if (expRes.ok && expData.job?.id) {
                // Poll for export completion
                const result = await pollCanvaJob(
                  `https://api.canva.com/rest/v1/exports/${expData.job.id}`,
                  canvaToken
                )
                const downloadUrl = result.job?.urls?.[0]?.url
                if (downloadUrl) exportUrl = downloadUrl
              }
            } catch (e) {
              console.warn('[agent] Export failed, using thumbnail:', e.message)
            }

            const editUrl = template.urls?.edit_url || `https://www.canva.com/design/${designId}`

            return res.json({
              url: exportUrl || thumbnail,
              editUrl,
              designId,
              source: 'canva-template',
              templateTitle: template.title,
            })
          }
        } catch (e) {
          console.warn('[agent] Mapping parse failed:', e.message)
        }
      }
    }

    // If text editing failed or no text elements, cancel transaction and fall back
    try {
      await fetch(
        `https://api.canva.com/rest/v1/designs/${designId}/editing/transactions/${transactionId}/cancel`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
        }
      )
    } catch { /* ignore cancel errors */ }

    return await generateWithIdeogram(req, res)

  } catch (e) {
    console.error('[agent] Error:', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// ── Generate multiple designs (batch) ───────────────────────
app.post('/generate-batch', async (req, res) => {
  const { pieces, brandContext, canvaToken } = req.body
  if (!pieces?.length) return res.status(400).json({ error: 'No pieces' })

  const results = []
  for (const piece of pieces.slice(0, 20)) {
    try {
      const result = await generateSingleDesign({
        ...piece,
        ...brandContext,
        canvaToken,
      })
      results.push({ pieceId: piece.id, ...result })
    } catch (e) {
      results.push({ pieceId: piece.id, error: e.message })
    }
  }

  return res.json({ results, total: results.length })
})

// Internal function for batch processing
async function generateSingleDesign(params) {
  const { title, caption, format, brandName, industry, colors, tone, visualStyle, mood, avoid, description, canvaToken } = params

  // If we have a Canva token, try template-based generation
  if (canvaToken) {
    try {
      const isStory = ['story', 'reel'].includes(format)
      const designType = isStory ? 'story' : 'post'
      const searchQuery = `${industry || 'business'} instagram ${designType}`

      const searchRes = await fetch(
        `https://api.canva.com/rest/v1/designs?query=${encodeURIComponent(searchQuery)}&ownership=any&sort_by=relevance`,
        { headers: { 'Authorization': `Bearer ${canvaToken}` } }
      )
      const searchData = await searchRes.json()

      if (searchRes.ok && searchData.items?.length) {
        const template = searchData.items[0]
        const designId = template.id

        // Start editing transaction
        const editRes = await fetch(
          `https://api.canva.com/rest/v1/designs/${designId}/editing/transactions`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }
        )
        const editData = await editRes.json()

        if (editRes.ok && editData.transaction?.transaction_id) {
          const transactionId = editData.transaction.transaction_id
          const richtexts = editData.richtexts || []

          const textElements = richtexts
            .filter(rt => rt.regions?.length > 0)
            .map(rt => ({
              elementId: rt.element_id,
              text: rt.regions.map(r => r.text).join(''),
            }))

          if (textElements.length > 0) {
            // Use Claude to map text
            const mappingResponse = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 800,
              messages: [{
                role: 'user',
                content: `Map template texts to brand content. Respond ONLY with JSON array.

TEMPLATE TEXTS:
${textElements.map((t, i) => `${i}. "${t.text}" (element: ${t.elementId})`).join('\n')}

BRAND: ${brandName} | TITLE: ${title} | DESC: ${description || caption || ''} | TONE: ${tone}

[{"elementId": "...", "findText": "original", "replaceText": "new"}, ...]`
              }],
            })

            const mappingText = mappingResponse.content[0]?.text || ''
            const jsonMatch = mappingText.match(/\[[\s\S]*\]/)

            if (jsonMatch) {
              const mappings = JSON.parse(jsonMatch[0])
              const operations = mappings.map(m => ({
                type: 'find_and_replace_text',
                element_id: m.elementId,
                find_text: m.findText,
                replace_text: m.replaceText,
              }))

              if (operations.length > 0) {
                await fetch(
                  `https://api.canva.com/rest/v1/designs/${designId}/editing/transactions/${transactionId}/operations`,
                  {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ operations, page_index: 1 }),
                  }
                )

                await fetch(
                  `https://api.canva.com/rest/v1/designs/${designId}/editing/transactions/${transactionId}/commit`,
                  {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                  }
                )

                // Export
                let exportUrl = template.thumbnail?.url
                try {
                  const expRes = await fetch('https://api.canva.com/rest/v1/exports', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ design_id: designId, format: { type: 'jpg' } }),
                  })
                  const expData = await expRes.json()
                  if (expRes.ok && expData.job?.id) {
                    const result = await pollCanvaJob(
                      `https://api.canva.com/rest/v1/exports/${expData.job.id}`,
                      canvaToken
                    )
                    const downloadUrl = result.job?.urls?.[0]?.url
                    if (downloadUrl) exportUrl = downloadUrl
                  }
                } catch (e) {
                  console.warn('[agent] Batch export failed:', e.message)
                }

                return {
                  url: exportUrl,
                  editUrl: template.urls?.edit_url || `https://www.canva.com/design/${designId}`,
                  designId,
                  source: 'canva-template',
                  templateTitle: template.title,
                }
              }
            }
          }

          // Cancel if editing didn't work
          try {
            await fetch(
              `https://api.canva.com/rest/v1/designs/${designId}/editing/transactions/${transactionId}/cancel`,
              {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${canvaToken}`, 'Content-Type': 'application/json' },
              }
            )
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      console.warn('[agent] Canva template editing failed in batch:', e.message)
    }
  }

  // Fallback to Ideogram
  const IDEOGRAM_KEY = process.env.IDEOGRAM_API_KEY
  if (IDEOGRAM_KEY) {
    const aspect = ['story', 'reel'].includes(format) ? 'ASPECT_9_16' : 'ASPECT_1_1'
    const query = `${title}. ${brandName} ${industry}. Professional social media design. ${visualStyle || mood || 'professional'} style.`
    const r = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
      body: JSON.stringify({
        image_request: { prompt: query, aspect_ratio: aspect, model: 'V_2_TURBO', style_type: 'DESIGN', magic_prompt_option: 'AUTO' },
      }),
    })
    const data = await r.json()
    const url = data?.data?.[0]?.url
    if (url) return { url, query, source: 'ideogram' }
  }

  return { query: `${title} ${brandName}`, source: 'query-only' }
}

app.listen(PORT, () => {
  console.log(`Rook Agent Server v2 running on port ${PORT}`)
})
