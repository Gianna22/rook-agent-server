// Rook Agent Server v4 — Claude Agent SDK + Canva MCP
// Claude uses Canva MCP tools to generate professional designs

import Anthropic from '@anthropic-ai/sdk'
import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 3000
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const IDEOGRAM_KEY = process.env.IDEOGRAM_API_KEY

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'rook-agent-server', version: '4.0.0' })
})

// ── Generate design using Claude with Canva tools ──────────────
app.post('/generate-design', async (req, res) => {
  try {
    const { title, caption, format, brandName, industry, colors, tone, visualStyle, mood, avoid, targetAudience, description, logoUrl, canvaToken } = req.body
    if (!title) return res.status(400).json({ error: 'Missing title' })

    const isStory = ['story', 'reel'].includes(format)
    const designType = isStory ? 'your_story' : 'instagram_post'

    // If we have a Canva token, try to use Canva's design generation API
    if (canvaToken) {
      try {
        // Call Canva's design generation endpoint (used by MCP internally)
        const genRes = await fetch('https://api.canva.com/rest/v1/design-generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${canvaToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: `${title}. ${brandName} ${industry}. Brand colors: ${colors?.primary} and ${colors?.secondary}. ${visualStyle || mood || 'Professional'} style. ${tone || ''} tone.${caption ? ` Context: ${caption.slice(0, 100)}` : ''}`,
            design_type: designType,
          }),
        })

        if (genRes.ok) {
          const genData = await genRes.json()
          console.log('[agent] Canva generate response:', JSON.stringify(genData).slice(0, 300))

          // Handle async job — poll for completion
          if (genData.job?.id) {
            let result = genData
            for (let i = 0; i < 15; i++) {
              if (result.job?.status === 'success' || result.job?.result) break
              await new Promise(r => setTimeout(r, 2000))
              const pollRes = await fetch(`https://api.canva.com/rest/v1/design-generations/${genData.job.id}`, {
                headers: { 'Authorization': `Bearer ${canvaToken}` },
              })
              if (pollRes.ok) result = await pollRes.json()
            }

            const candidates = result.job?.result?.designs || result.job?.result?.generated_designs || []
            if (candidates.length > 0) {
              // Return the first candidate's thumbnail
              const best = candidates[0]
              return res.json({
                url: best.thumbnail?.url || best.urls?.view_url,
                editUrl: best.urls?.edit_url,
                designId: best.id,
                candidates: candidates.map(c => ({
                  id: c.id,
                  thumbnail: c.thumbnail?.url,
                  editUrl: c.urls?.edit_url,
                })),
                source: 'canva',
              })
            }
          }

          // Direct response (non-async)
          if (genData.designs?.length || genData.generated_designs?.length) {
            const designs = genData.designs || genData.generated_designs
            const best = designs[0]
            return res.json({
              url: best.thumbnail?.url || best.urls?.view_url,
              editUrl: best.urls?.edit_url,
              designId: best.id,
              source: 'canva',
            })
          }
        } else {
          const errData = await genRes.json().catch(() => ({}))
          console.log('[agent] Canva generate failed:', genRes.status, JSON.stringify(errData).slice(0, 200))
        }
      } catch (e) {
        console.warn('[agent] Canva generation error:', e.message)
      }
    }

    // ── Fallback: Claude optimizes prompt → Ideogram generates ──
    if (!IDEOGRAM_KEY) return res.status(500).json({ error: 'No image generation service available' })

    let prompt = `${title}. ${brandName} ${industry}. Professional design.`

    if (ANTHROPIC_KEY) {
      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 250,
          messages: [{
            role: 'user',
            content: `Write an Ideogram AI prompt for a professional Instagram ${isStory ? 'story' : 'post'} design.

BRAND: ${brandName} (${industry})
TITLE: "${title}"
${caption ? `CONTEXT: "${caption.slice(0, 100)}"` : ''}
COLORS: ${colors?.primary}, ${colors?.secondary}
STYLE: ${visualStyle || mood || 'professional'}
TONE: ${tone || 'professional'}
${avoid ? `AVOID: ${avoid}` : ''}

Include brand name "${brandName}" and title "${title}" as text in the design.
Use brand colors. Professional quality.
Output ONLY the prompt, max 150 words.`
          }],
        })
        const p = response.content[0]?.text?.trim()
        if (p && p.length > 20) prompt = p
      } catch (e) {
        console.warn('[agent] Claude failed:', e.message)
      }
    }

    const aspect = isStory ? 'ASPECT_9_16' : 'ASPECT_1_1'
    const r = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
      body: JSON.stringify({
        image_request: { prompt, aspect_ratio: aspect, model: 'V_2_TURBO', style_type: 'DESIGN', magic_prompt_option: 'AUTO' },
      }),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.message || `Ideogram HTTP ${r.status}`)
    const url = data?.data?.[0]?.url
    if (!url) throw new Error('No URL returned')

    return res.json({ url, prompt, source: 'ideogram' })

  } catch (e) {
    console.error('[agent] Error:', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// ── Generate 4 product photos ───────────────────────────────
app.post('/generate-photos', async (req, res) => {
  try {
    const { prompt, format } = req.body
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' })
    if (!IDEOGRAM_KEY) return res.status(500).json({ error: 'IDEOGRAM_API_KEY not configured' })

    const aspect = ['story', 'reel'].includes(format) ? 'ASPECT_9_16' : 'ASPECT_1_1'
    const r = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
      body: JSON.stringify({
        image_request: { prompt: prompt.slice(0, 400), aspect_ratio: aspect, model: 'V_2_TURBO', magic_prompt_option: 'AUTO', num_images: 4 },
      }),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.message || `HTTP ${r.status}`)
    const urls = (data?.data || []).map(d => d.url).filter(Boolean)
    return res.json({ urls, source: 'ideogram' })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`Rook Agent Server v4 running on port ${PORT}`)
})
