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
  res.json({ status: 'ok', service: 'rook-agent-server', version: '1.0.0' })
})

// ── Generate design with Claude + tool use ──────────────────
app.post('/generate-design', async (req, res) => {
  try {
    const {
      title,
      caption,
      format, // 'post', 'story', 'reel'
      brandName,
      industry,
      colors, // { primary, secondary, accent }
      tone,
      visualStyle,
      mood,
      avoid,
      targetAudience,
      description,
      logoUrl,
      canvaToken, // user's Canva OAuth token
    } = req.body

    if (!title) return res.status(400).json({ error: 'Missing title' })

    const designType = ['story', 'reel'].includes(format) ? 'your_story' : 'instagram_post'

    // Build the prompt for Claude with full brand context
    const brandContext = `
BRAND: ${brandName || 'Unknown'}
INDUSTRY: ${industry || 'General'}
DESCRIPTION: ${description || ''}
TARGET AUDIENCE: ${targetAudience || ''}
TONE: ${tone || 'professional'}
VISUAL STYLE: ${visualStyle || 'modern'}
MOOD: ${mood || 'professional'}
${avoid ? `AVOID: ${avoid}` : ''}
COLORS: primary ${colors?.primary || '#000'}, secondary ${colors?.secondary || '#333'}, accent ${colors?.accent || '#666'}
${logoUrl ? `LOGO: ${logoUrl}` : ''}
`.trim()

    // Define Canva-like tools for Claude to use
    const tools = [
      {
        name: 'generate_canva_design',
        description: 'Generate a professional design using Canva AI. Returns design candidates with thumbnails.',
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Descriptive query for the design. Include brand name, industry, title, and style.'
            },
            design_type: {
              type: 'string',
              enum: ['instagram_post', 'your_story', 'facebook_post', 'poster', 'flyer'],
              description: 'The type/format of the design'
            }
          },
          required: ['query', 'design_type']
        }
      },
      {
        name: 'create_design_from_candidate',
        description: 'Create an editable design from a selected candidate.',
        input_schema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'The generation job ID' },
            candidate_id: { type: 'string', description: 'The selected candidate ID' }
          },
          required: ['job_id', 'candidate_id']
        }
      }
    ]

    // Step 1: Ask Claude to generate the best design query
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: `You are a professional social media designer. Your job is to generate designs for brands using Canva.

Given the brand context, create a compelling design query that will produce a professional, on-brand result.

Rules:
- Include the brand name in the query
- Reference the brand colors
- Specify the visual style and mood
- Keep the query under 300 characters
- The design should feel premium and professional
- Always call the generate_canva_design tool`,
      messages: [{
        role: 'user',
        content: `Generate a ${designType} design for this brand:

${brandContext}

POST CONTENT:
Title: "${title}"
${caption ? `Caption: "${caption.slice(0, 150)}"` : ''}

Call the generate_canva_design tool with an optimized query.`
      }],
      tools,
    })

    // Extract the tool call
    const toolUse = response.content.find(c => c.type === 'tool_use')

    if (!toolUse) {
      // Claude didn't use a tool — extract text response
      const textContent = response.content.find(c => c.type === 'text')
      return res.json({
        error: 'Claude did not generate a design query',
        suggestion: textContent?.text || '',
        source: 'none'
      })
    }

    const { query, design_type } = toolUse.input
    console.log('[agent] Design query:', query)
    console.log('[agent] Design type:', design_type)

    // Step 2: Call Canva API with the optimized query
    if (canvaToken) {
      try {
        const canvaRes = await fetch('https://api.canva.com/rest/v1/designs', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${canvaToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            design_type: design_type || designType,
            title: title.slice(0, 100),
          }),
        })
        const canvaData = await canvaRes.json()
        console.log('[agent] Canva response:', JSON.stringify(canvaData).slice(0, 300))

        if (canvaRes.ok && canvaData?.design) {
          return res.json({
            designId: canvaData.design.id,
            editUrl: canvaData.design.urls?.edit_url,
            viewUrl: canvaData.design.urls?.view_url,
            thumbnail: canvaData.design.thumbnail?.url,
            query,
            source: 'canva',
          })
        }
      } catch (e) {
        console.warn('[agent] Canva API failed:', e.message)
      }
    }

    // Step 3: Fallback to Ideogram with the optimized query
    const IDEOGRAM_KEY = process.env.IDEOGRAM_API_KEY
    if (IDEOGRAM_KEY) {
      try {
        const aspect = ['story', 'reel'].includes(format) ? 'ASPECT_9_16' : 'ASPECT_1_1'
        const ideoRes = await fetch('https://api.ideogram.ai/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
          body: JSON.stringify({
            image_request: {
              prompt: query,
              aspect_ratio: aspect,
              model: 'V_2_TURBO',
              style_type: 'DESIGN',
              magic_prompt_option: 'AUTO',
            },
          }),
        })
        const ideoData = await ideoRes.json()
        const url = ideoData?.data?.[0]?.url
        if (url) {
          return res.json({ url, query, source: 'ideogram' })
        }
      } catch (e) {
        console.warn('[agent] Ideogram failed:', e.message)
      }
    }

    return res.json({ query, source: 'query-only', message: 'Design query generated but no image service available' })

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
      // Call our own generate-design endpoint internally
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
  const { title, caption, format, brandName, industry, colors, tone, visualStyle, mood, avoid, canvaToken } = params
  const designType = ['story', 'reel'].includes(format) ? 'your_story' : 'instagram_post'

  // Build optimized query with Claude
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Create a short Canva/Ideogram design prompt (max 200 chars) for:
Brand: ${brandName} (${industry})
Title: "${title}"
Colors: ${colors?.primary}, ${colors?.secondary}
Style: ${visualStyle || mood || 'professional'}
Format: ${designType}
${avoid ? `Avoid: ${avoid}` : ''}
Output ONLY the prompt, nothing else.`
    }],
  })

  const query = response.content[0]?.text?.trim() || `${title} ${brandName} ${industry} professional design`

  // Try Ideogram
  const IDEOGRAM_KEY = process.env.IDEOGRAM_API_KEY
  if (IDEOGRAM_KEY) {
    const aspect = ['story', 'reel'].includes(format) ? 'ASPECT_9_16' : 'ASPECT_1_1'
    const r = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
      body: JSON.stringify({
        image_request: {
          prompt: query,
          aspect_ratio: aspect,
          model: 'V_2_TURBO',
          style_type: 'DESIGN',
          magic_prompt_option: 'AUTO',
        },
      }),
    })
    const data = await r.json()
    const url = data?.data?.[0]?.url
    if (url) return { url, query, source: 'ideogram' }
  }

  return { query, source: 'query-only' }
}

app.listen(PORT, () => {
  console.log(`🚀 Rook Agent Server running on port ${PORT}`)
})
