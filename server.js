// Rook Agent Server v3 — Claude optimizes prompts, Ideogram generates
// Claude ensures every prompt is on-brand with full client identity

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
  res.json({ status: 'ok', service: 'rook-agent-server', version: '3.0.0' })
})

// ── Generate design: Claude crafts prompt → Ideogram generates ──
app.post('/generate-design', async (req, res) => {
  try {
    const { title, caption, format, brandName, industry, colors, tone, visualStyle, mood, avoid, targetAudience, description, logoUrl } = req.body
    if (!title) return res.status(400).json({ error: 'Missing title' })
    if (!IDEOGRAM_KEY) return res.status(500).json({ error: 'IDEOGRAM_API_KEY not configured' })

    const isStory = ['story', 'reel'].includes(format)
    const aspect = isStory ? 'ASPECT_9_16' : 'ASPECT_1_1'

    // Claude crafts the perfect Ideogram prompt with full brand context
    let prompt = `${title}. ${brandName} ${industry}. Professional design.`

    if (ANTHROPIC_KEY) {
      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 250,
          messages: [{
            role: 'user',
            content: `Write an Ideogram AI image generation prompt for a social media post.

BRAND: ${brandName}
INDUSTRY: ${industry}
POST TITLE: "${title}"
${caption ? `CAPTION CONTEXT: "${caption.slice(0, 100)}"` : ''}
BRAND COLORS: ${colors?.primary || '#000'} and ${colors?.secondary || '#333'}
VISUAL STYLE: ${visualStyle || mood || 'professional'}
TONE: ${tone || 'professional'}
${avoid ? `DO NOT include: ${avoid}` : ''}
FORMAT: ${isStory ? '9:16 vertical story' : '1:1 square post'}

Write a prompt that will generate a professional Instagram ${isStory ? 'story' : 'post'} design.
The design must include the brand name "${brandName}" and the title "${title}" as text in the image.
Use the brand colors ${colors?.primary} and ${colors?.secondary}.
The style should match: ${visualStyle || mood || industry || 'professional modern'}.

Output ONLY the Ideogram prompt in English, max 200 words. No explanations.`
          }],
        })
        const claudePrompt = response.content[0]?.text?.trim()
        if (claudePrompt && claudePrompt.length > 20) {
          prompt = claudePrompt
        }
      } catch (e) {
        console.warn('[agent] Claude prompt optimization failed:', e.message)
      }
    }

    console.log('[agent] Prompt:', prompt.slice(0, 150))

    // Generate with Ideogram
    const r = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
      body: JSON.stringify({
        image_request: {
          prompt,
          aspect_ratio: aspect,
          model: 'V_2_TURBO',
          style_type: 'DESIGN',
          magic_prompt_option: 'AUTO',
        },
      }),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.message || `Ideogram HTTP ${r.status}`)
    const url = data?.data?.[0]?.url
    if (!url) throw new Error('No image URL returned')

    console.log('[agent] Image generated:', url.slice(0, 60))
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
        image_request: {
          prompt: prompt.slice(0, 400),
          aspect_ratio: aspect,
          model: 'V_2_TURBO',
          magic_prompt_option: 'AUTO',
          num_images: 4,
        },
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
  console.log(`Rook Agent Server v3 running on port ${PORT}`)
})
