// Rook Agent Server v5 — Claude + Canva via Composio MCP Connector
// Claude calls Canva tools directly through Anthropic's MCP connector

import Anthropic from '@anthropic-ai/sdk'
import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 3000
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const IDEOGRAM_KEY = process.env.IDEOGRAM_API_KEY
const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'rook-agent-server', version: '5.0.0' })
})

// ── Composio MCP URL for Canva (pre-configured) ─────────────
const COMPOSIO_MCP_SERVER_ID = 'ee58124a-c702-4495-91cc-59db9526ba54'

function getCanvaMcpUrl() {
  if (!COMPOSIO_KEY) return null
  return `https://backend.composio.dev/v3/mcp/${COMPOSIO_MCP_SERVER_ID}/sse?connected_account_id=ca_hPaT29c_enOE`
}

// ── Generate design with Claude + Canva MCP ─────────────────
app.post('/generate-design', async (req, res) => {
  try {
    const { title, caption, format, brandName, industry, colors, tone, visualStyle, mood, avoid, targetAudience, description, logoUrl } = req.body
    if (!title) return res.status(400).json({ error: 'Missing title' })

    const isStory = ['story', 'reel'].includes(format)
    const designType = isStory ? 'your_story' : 'instagram_post'

    // Try Canva via Composio MCP
    const mcpUrl = await getCanvaMcpUrl()

    if (mcpUrl && ANTHROPIC_KEY) {
      try {
        console.log('[agent] Using Canva via MCP connector:', mcpUrl.slice(0, 80))

        const query = `Create a professional Instagram ${isStory ? 'story' : 'post'} design for "${brandName}" (${industry}).
Title: "${title}"
${caption ? `Caption: "${caption.slice(0, 100)}"` : ''}
Brand colors: ${colors?.primary || '#000'} and ${colors?.secondary || '#333'}.
Style: ${visualStyle || mood || 'professional modern'}.
Tone: ${tone || 'professional'}.
${avoid ? `Avoid: ${avoid}` : ''}
The design should be professional, on-brand, and ready for Instagram.`

        // Call Claude with MCP connector to Canva
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'mcp-client-2025-11-20',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            messages: [{
              role: 'user',
              content: `Generate a ${designType} design using Canva for this brand:
${query}
Use the generate-design tool to create this design.`
            }],
            mcp_servers: [{
              type: 'url',
              url: mcpUrl,
              name: 'canva-mcp',
              authorization_token: COMPOSIO_KEY,
            }],
            tools: [{
              type: 'mcp_toolset',
              mcp_server_name: 'canva-mcp',
            }],
          }),
        })

        const data = await response.json()
        console.log('[agent] Claude+MCP response:', JSON.stringify(data).slice(0, 500))

        if (response.ok) {
          // Check if Claude used MCP tools and got results
          const toolResults = data.content?.filter(c => c.type === 'mcp_tool_result') || []
          const textBlocks = data.content?.filter(c => c.type === 'text') || []

          // Look for design URLs in tool results
          for (const result of toolResults) {
            const resultText = result.content?.map(c => c.text).join('') || ''
            const urlMatch = resultText.match(/https:\/\/[^\s"]+canva[^\s"]+/) || resultText.match(/https:\/\/[^\s"]+/)
            if (urlMatch) {
              return res.json({
                url: urlMatch[0],
                source: 'canva-mcp',
                rawResponse: resultText.slice(0, 500),
              })
            }
            // Try parsing as JSON
            try {
              const parsed = JSON.parse(resultText)
              if (parsed.url || parsed.thumbnail || parsed.editUrl) {
                return res.json({
                  url: parsed.thumbnail || parsed.url,
                  editUrl: parsed.editUrl || parsed.edit_url,
                  designId: parsed.designId || parsed.design_id,
                  source: 'canva-mcp',
                })
              }
            } catch {}
          }

          // Check if there are tool_use blocks (needs agentic loop)
          const toolUseBlocks = data.content?.filter(c => c.type === 'mcp_tool_use') || []
          if (toolUseBlocks.length > 0 && data.stop_reason === 'tool_use') {
            // Need to continue the conversation with tool results
            // The MCP connector handles this automatically on Anthropic's side
            // but we may need multiple turns
            console.log('[agent] Tool use detected, MCP connector handling...')

            // Make a follow-up call to let Claude process the tool results
            const followUp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'mcp-client-2025-11-20',
              },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 2000,
                messages: [
                  { role: 'user', content: `Generate a ${designType} design using Canva for "${brandName}": "${title}". Use the generate-design tool.` },
                  { role: 'assistant', content: data.content },
                ],
                mcp_servers: [{
                  type: 'url',
                  url: mcpUrl,
                  name: 'canva-mcp',
                  authorization_token: COMPOSIO_KEY,
                }],
                tools: [{
                  type: 'mcp_toolset',
                  mcp_server_name: 'canva-mcp',
                }],
              }),
            })
            const followUpData = await followUp.json()
            console.log('[agent] Follow-up response:', JSON.stringify(followUpData).slice(0, 500))

            // Extract any URLs from the follow-up
            const allContent = JSON.stringify(followUpData.content || [])
            const canvaUrl = allContent.match(/https:\/\/[^\s"\\]+canva[^\s"\\]+/)
              || allContent.match(/"url"\s*:\s*"(https:\/\/[^"]+)"/)
            if (canvaUrl) {
              return res.json({
                url: canvaUrl[1] || canvaUrl[0],
                source: 'canva-mcp',
              })
            }
          }

          // Extract any text response
          const textResponse = textBlocks.map(b => b.text).join('\n')
          if (textResponse) {
            console.log('[agent] Claude text response:', textResponse.slice(0, 200))
          }
        }

        console.log('[agent] Canva MCP did not produce a design, falling back to Ideogram')
      } catch (e) {
        console.warn('[agent] Canva MCP error:', e.message)
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
COLORS: ${colors?.primary}, ${colors?.secondary}
STYLE: ${visualStyle || mood || 'professional'}
Include brand name "${brandName}" and title "${title}" as text.
Output ONLY the prompt, max 150 words.`
          }],
        })
        const p = response.content[0]?.text?.trim()
        if (p && p.length > 20) prompt = p
      } catch (e) {
        console.warn('[agent] Claude prompt failed:', e.message)
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
  console.log(`Rook Agent Server v5 running on port ${PORT}`)
})
