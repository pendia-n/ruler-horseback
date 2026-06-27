import { Hono } from 'hono'
import { sign, verify } from 'hono/jwt'
import { cors } from 'hono/cors'

export interface Env {
  DB: D1Database
  JWT_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  CREDIT_100_PRICE_ID: string
  CREDIT_300_PRICE_ID: string
  CREDIT_1000_PRICE_ID: string
  OPENROUTER_API_KEY: string
  APP_URL: string
}

// JWT tokens expire in 5 days
const JWT_EXPIRY_SECONDS = 5 * 24 * 60 * 60

async function makeToken(payload: Record<string, any>, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ ...payload, iat: now, exp: now + JWT_EXPIRY_SECONDS }, secret)
}

const app = new Hono<{ Bindings: Env; Variables: { userId: string; username: string } }>()

// ── CORS for all API routes ──
app.use('/api/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'] }))

// ── Helpers ──
function hexEncode(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password + salt))
  return hexEncode(hashBuffer)
}

function validatePassword(pw: string): string | null {
  if (pw.length < 7) return 'Password must be at least 7 characters'
  if (!/\d/.test(pw)) return 'Password must contain at least 1 digit'
  return null
}

// ── TOTP helpers ──
function generateTOTPSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let s = ''
  const buf = new Uint8Array(20)
  crypto.getRandomValues(buf)
  for (let i = 0; i < 20; i++) s += chars[buf[i] % 32]
  return s
}

function base32Decode(s: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = s.toUpperCase().split('').map(c => chars.indexOf(c)).filter(n => n >= 0).map(n => n.toString(2).padStart(5, '0')).join('')
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substring(i, i + 8), 2))
  return new Uint8Array(bytes)
}

async function verifyTOTP(secret: string, code: string): Promise<boolean> {
  const epoch = Math.floor(Date.now() / 30000)
  for (let i = -1; i <= 1; i++) {
    const buf = new Uint8Array(8)
    const view = new DataView(buf.buffer)
    view.setBigUint64(0, BigInt(epoch + i))
    const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
    const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf))
    const offset = hmac[19] & 0xf
    const token = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]) % 1000000
    if (token.toString().padStart(6, '0') === code) return true
  }
  return false
}

// ── Auth middleware ──
async function authMiddleware(c: any, next: any) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verify(auth.substring(7), c.env.JWT_SECRET, 'HS256')
    c.set('userId', payload.userId)
    c.set('username', payload.username)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
}

// ═══════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════

app.get('/api/auth/check-username', async (c) => {
  const username = c.req.query('username')
  if (!username || username.length < 2) return c.json({ available: false, error: 'Username min 2 chars' })
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
  return c.json({ available: !existing })
})

app.post('/api/auth/register', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>()
  if (!username || username.length < 2) return c.json({ error: 'Username must be at least 2 characters' }, 400)
  const pwError = validatePassword(password)
  if (pwError) return c.json({ error: pwError }, 400)

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
  if (existing) return c.json({ error: 'Username already taken' }, 409)

  const userId = crypto.randomUUID()
  const hash = await hashPassword(password, userId)
  const totpSecret = generateTOTPSecret()

  await c.env.DB.prepare(
    'INSERT INTO users (id, username, password_hash, credits, totp_secret, totp_enabled) VALUES (?, ?, ?, ?, ?, 0)'
  ).bind(userId, username, hash, 50, totpSecret).run()

  const token = await makeToken({ userId, username }, c.env.JWT_SECRET)
  return c.json({ success: true, userId, username, token, credits: 50, totpSecret }, 201)
})

app.post('/api/auth/login', async (c) => {
  const { username, password, totpCode } = await c.req.json<{ username: string; password: string; totpCode?: string }>()
  if (!username || !password) return c.json({ error: 'Missing fields' }, 400)

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first() as any
  if (!user) return c.json({ error: 'Invalid credentials' }, 401)

  const hash = await hashPassword(password, user.id)
  if (hash !== user.password_hash) return c.json({ error: 'Invalid credentials' }, 401)

  if (user.totp_enabled && user.totp_secret) {
    if (!totpCode) return c.json({ error: 'TOTP code required', totpRequired: true }, 401)
    if (!await verifyTOTP(user.totp_secret, totpCode)) return c.json({ error: 'Invalid TOTP' }, 401)
  }

  const token = await makeToken({ userId: user.id, username: user.username }, c.env.JWT_SECRET)
  return c.json({ success: true, userId: user.id, username: user.username, token, credits: user.credits || 0, totpEnabled: !!user.totp_enabled })
})

// Forgot password — Step 1: Verify username + TOTP, return reset token
app.post('/api/auth/forgot-password', async (c) => {
  const { username, totpCode } = await c.req.json<{ username: string; totpCode: string }>()
  if (!username || !totpCode) return c.json({ error: 'Username and TOTP code required' }, 400)
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first() as any
  if (!user) return c.json({ error: 'User not found' }, 404)
  if (!user.totp_enabled || !user.totp_secret) return c.json({ error: 'TOTP not enabled for this account. Contact support.' }, 400)
  if (!await verifyTOTP(user.totp_secret, totpCode)) return c.json({ error: 'Invalid TOTP code' }, 401)
  const resetToken = await makeToken({ userId: user.id, username: user.username, purpose: 'password_reset' }, c.env.JWT_SECRET)
  return c.json({ resetToken, message: 'TOTP verified. Use resetToken to set new password.' })
})

// Forgot password — Step 2: Reset password with token
app.post('/api/auth/reset-password', async (c) => {
  const { resetToken, newPassword } = await c.req.json<{ resetToken: string; newPassword: string }>()
  if (!resetToken || !newPassword) return c.json({ error: 'Reset token and new password required' }, 400)
  if (newPassword.length < 7) return c.json({ error: 'Password min 7 chars' }, 400)
  try {
    const payload = await verify(resetToken, c.env.JWT_SECRET) as any
    if (!payload || payload.purpose !== 'password_reset') return c.json({ error: 'Invalid or expired reset token' }, 401)
    const hash = await hashPassword(newPassword, payload.userId)
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, payload.userId).run()
    return c.json({ message: 'Password reset successful' })
  } catch { return c.json({ error: 'Invalid or expired reset token' }, 401) }
})

// ═══════════════════════════════════════════
// TOTP
// ═══════════════════════════════════════════

app.post('/api/user/totp/setup', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const user = await c.env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(userId).first() as any
  const secret = user?.totp_secret || generateTOTPSecret()
  if (!user?.totp_secret) {
    await c.env.DB.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').bind(secret, userId).run()
  }
  const username = c.get('username')
  return c.json({ secret, uri: `otpauth://totp/RulerHorseback:${username}?secret=${secret}&issuer=RulerHorseback` })
})

app.post('/api/user/totp/enable', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const { code } = await c.req.json<{ code: string }>()
  const user = await c.env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(userId).first() as any
  if (!user?.totp_secret) return c.json({ error: 'No TOTP secret. Setup first.' }, 400)
  if (!await verifyTOTP(user.totp_secret, code)) return c.json({ error: 'Invalid TOTP code' }, 400)
  await c.env.DB.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').bind(userId).run()
  return c.json({ success: true, message: 'TOTP enabled' })
})

app.post('/api/user/totp/disable', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const { code } = await c.req.json<{ code: string }>()
  const user = await c.env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(userId).first() as any
  if (!user?.totp_secret || !user.totp_enabled) return c.json({ error: 'TOTP not enabled' }, 400)
  if (!await verifyTOTP(user.totp_secret, code)) return c.json({ error: 'Invalid TOTP code' }, 400)
  await c.env.DB.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').bind(userId).run()
  return c.json({ success: true, message: 'TOTP disabled' })
})

// ═══════════════════════════════════════════
// CREDITS
// ═══════════════════════════════════════════

app.get('/api/credits/status', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const user = await c.env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first() as any
  return c.json({ credits: user?.credits || 0 })
})

app.post('/api/credits/use', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const { amount } = await c.req.json<{ amount: number }>().catch(() => ({ amount: 1 }))
  const deductAmount = Math.max(1, Math.min(amount || 1, 1000))
  const user = await c.env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first() as any
  if (!user || (user.credits || 0) < deductAmount) return c.json({ error: 'Insufficient credits' }, 402)

  await c.env.DB.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').bind(deductAmount, userId).run()
  return c.json({ credits: (user.credits || 0) - deductAmount })
})

app.get('/api/credits/plans', async (c) => {
  return c.json({
    plans: [
      { credits: 100, price: 4, label: 'Starter', note: '~10 todo deletions or ~25 edits' },
      { credits: 300, price: 10, label: 'Regular', note: '~30 deletions or ~75 edits' },
      { credits: 1000, price: 25, label: 'Pro', note: '~100 deletions or ~250 edits' },
    ]
  })
})

// ═══════════════════════════════════════════
// CREDIT STATS (batch apply done/lost/due)
// ═══════════════════════════════════════════

app.post('/api/credits/apply-stats', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const { done_count, lost_count, due_count } = await c.req.json<{
    done_count: number
    lost_count: number
    due_count: number
  }>().catch(() => ({ done_count: 0, lost_count: 0, due_count: 0 }))

  const done = Math.max(0, done_count || 0)
  const lost = Math.max(0, lost_count || 0)
  const due = Math.max(0, due_count || 0)

  // Calculate delta: +5 per 10 done, -10 per 5 lost, -3 per due
  const rewardFromDone = Math.floor(done / 10) * 5
  const penaltyFromLost = Math.floor(lost / 5) * 10
  const penaltyFromDue = due * 3
  const netDelta = rewardFromDone - penaltyFromLost - penaltyFromDue

  // Update user credits — always apply (can go negative)
  if (netDelta != 0) {
    const user = await c.env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first() as any
    const currentCredits = user?.credits || 0
    const newCredits = currentCredits + netDelta
    await c.env.DB.prepare('UPDATE users SET credits = ? WHERE id = ?').bind(newCredits, userId).run()
  }

  const user = await c.env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first() as any

  return c.json({
    applied: netDelta,
    credits: user?.credits || 0,
    stats: { total_done: done, total_lost: lost, total_due: due },
    breakdown: { reward_from_done: rewardFromDone, penalty_from_lost: penaltyFromLost, penalty_from_due: penaltyFromDue }
  })
})



// ═══════════════════════════════════════════
// AI DESCRIPTION VALIDATION
// ═══════════════════════════════════════════

const AI_FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-content-safety:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/llama-nemotron-embed-vl-1b-v2:free',
  'qwen/qwen3-coder:free',
]
const AI_PAID_FALLBACK = 'inclusionai/ling-2.6-flash'
const AI_TIMEOUT_MS = 10000

function buildAIPrompt(body: any): string {
  return `You are a task completion validator. Rate how trustworthy a user's description is on a scale of 0-12.

Todo title: ${body.todoTitle || 'N/A'}
Todo description: ${body.todoDescription || 'N/A'}
Created: ${body.createdDate || 'N/A'}
Completed/Lost on: ${body.endDate || 'N/A'}
Type: ${body.type || 'done'} ("done" meaning completed, "lost" meaning abandoned/gave up)

User's ${body.type || 'done'} description: ${body.resolutionDescription || ''}

Rate 0-12 considering:
- Specificity (mentions concrete actions, files, people, tools)
- Relevance (clearly relates to the todo title/description)
- Temporal fit (makes sense for the time between created and end date)
- Effort indicator (shows genuine work or legitimate reason for loss)
- Avoid generic/vague ("done", "finished it", "idk")

0-3: junk/spam/nonsense
4-6: vague but not junk
7-9: acceptable, shows some substance
10-12: highly specific and trustworthy

Respond ONLY as JSON: {"score": N, "maxScore": 12, "reason": "brief explanation"}`
}

async function callOpenRouter(apiKey: string, model: string, prompt: string): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://rulerhorseback-api.pendia-community.workers.dev',
        'X-Title': 'RulerHorseback',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (res.status === 429) return { rateLimited: true }
    if (!res.ok) return { error: `http_${res.status}` }
    const data = await res.json() as any
    const content = data?.choices?.[0]?.message?.content
    if (!content) return { error: 'no_content' }
    const jsonMatch = content.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) return { error: 'no_json_match' }
    try {
      return JSON.parse(jsonMatch[0])
    } catch {
      return { error: 'json_parse_fail' }
    }
  } catch {
    clearTimeout(timeout)
    return { error: 'fetch_failed' }
  }
}

app.post('/api/ai/validate-description', authMiddleware, async (c) => {
  const userId = c.get('userId')

  // Rate limit: 1 per 1 minute (skip check if table doesn't exist)
  try {
    const recentCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM ai_validation_log WHERE user_id = ? AND created_at >= datetime(\'now\', \'-1 minute\')'
    ).bind(userId).first() as any
    if (recentCount?.cnt >= 1) {
      return c.json({ error: 'Rate limit: please wait 1 minute between AI validations', retryAfter: 60 }, 429)
    }
  } catch (rateErr: any) {
    console.error('Rate limit check failed (table may not exist):', rateErr?.message)
  }

  const body = await c.req.json().catch(() => ({}))
  const prompt = buildAIPrompt(body)

  // Try free models first, then paid fallback
  let aiResult: any = null
  for (const model of [...AI_FREE_MODELS, AI_PAID_FALLBACK]) {
    aiResult = await callOpenRouter(c.env.OPENROUTER_API_KEY, model, prompt)
    if (!aiResult?.error && !aiResult?.rateLimited) break
  }

  if (!aiResult || aiResult.error || aiResult.rateLimited) {
    return c.json({ error: aiResult?.error || 'AI service unavailable', detail: aiResult?.detail || aiResult?.raw || '' }, 503)
  }

  const score = Math.max(0, Math.min(12, aiResult.score || 0))
  const passed = score >= 7
  const creditChange = passed ? 1 : -1

  // Apply credit change (AI +/-1 always applies, even if balance goes negative)
  const user = await c.env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first() as any
  const currentCredits = user?.credits || 0
  const newCredits = currentCredits + creditChange
  await c.env.DB.prepare('UPDATE users SET credits = ? WHERE id = ?').bind(newCredits, userId).run()

  // Log validation for rate limiting
  try {
    await c.env.DB.prepare(
      'INSERT INTO ai_validation_log (id, user_id) VALUES (?, ?)'
    ).bind(crypto.randomUUID(), userId).run()
  } catch {
    // Table might not exist — non-critical
  }

  return c.json({
    score,
    maxScore: 12,
    passed,
    reason: aiResult.reason || '',
    credit_change: creditChange,
    credits: newCredits,
  })
})


// ══════════════════════════════════════════</longcat_arg_key>


app.post('/api/stripe/create-checkout', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const { credits } = await c.req.json<{ credits: number }>()

  const creditPrices: Record<number, { price: number; envKey: string; label: string }> = {
    100: { price: 400, envKey: 'CREDIT_100_PRICE_ID', label: 'Starter (100 credits)' },
    300: { price: 1000, envKey: 'CREDIT_300_PRICE_ID', label: 'Regular (300 credits)' },
    1000: { price: 2500, envKey: 'CREDIT_1000_PRICE_ID', label: 'Pro (1000 credits)' },
  }
  const pack = creditPrices[credits]
  if (!pack) return c.json({ error: `Invalid credit pack: ${credits}` }, 400)

  const priceId = (c.env as any)[pack.envKey]
  if (!priceId) return c.json({ error: 'Price not configured' }, 500)

  const session = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'payment_method_types[]': 'card',
      mode: 'payment',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${c.env.APP_URL}/?payment=success`,
      cancel_url: `${c.env.APP_URL}/?payment=cancelled`,
      'metadata[user_id]': userId,
      'metadata[credits]': String(credits),
    }).toString(),
  }).then((r: any) => r.json())

  if (session.error) return c.json({ error: session.error.message }, 500)
  return c.json({ url: session.url, sessionId: session.id })
})

app.post('/api/stripe/webhook', async (c) => {
  try {
    const body = await c.req.text()
    const sig = c.req.header('stripe-signature')

    if (sig && c.env.STRIPE_WEBHOOK_SECRET) {
      const parts = sig.split(',')
      let timestamp = ''
      let sigValue = ''
      for (const p of parts) {
        const [k, ...v] = p.split('=')
        if (k === 't') timestamp = v.join('=')
        if (k === 'v1') sigValue = v.join('=')
      }
      const signedPayload = `${timestamp}.${body}`
      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey('raw', encoder.encode(c.env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const expectedSig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload))
      const expectedHex = hexEncode(expectedSig)
      if (expectedHex !== sigValue) {
        console.error('Stripe webhook: invalid signature')
        return c.json({ error: 'Invalid signature' }, 401)
      }
    }

    let event: any
    try { event = JSON.parse(body) } catch { return c.json({ error: 'Invalid payload' }, 400) }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const userId = session.metadata?.user_id
      const credits = parseInt(session.metadata?.credits || '0')
      const amount = session.amount_total / 100

      if (userId && credits > 0) {
        // Idempotency guard: skip if already processed
        const existing = await c.env.DB.prepare('SELECT id FROM credit_purchases WHERE stripe_session_id = ?').bind(session.id).first()
        if (!existing) {
          await c.env.DB.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').bind(credits, userId).run()
          await c.env.DB.prepare(
            'INSERT INTO credit_purchases (id, user_id, credits, amount, stripe_session_id) VALUES (?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), userId, credits, amount, session.id).run()
        }
      }
    }

    return c.json({ received: true })
  } catch (err: any) {
    console.error('POST /api/stripe/webhook error:', err?.message || err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ═══════════════════════════════════════════
// LANDING PAGE
// ═══════════════════════════════════════════

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RulerHorseback — Native Desktop Todo App</title>
  <link rel="icon" type="image/png" href="/snakedesk.png" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a12; color: #e0e0e0; }
    .container { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; }
    header { text-align: center; padding: 3rem 0 2rem; }
    h1 { font-size: 2.8rem; margin-bottom: 0.5rem; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #888; font-size: 1.1rem; margin-bottom: 0.5rem; }
    .tagline { color: #667eea; font-size: 0.95rem; }

    .media { margin: 2rem auto; max-width: 720px; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    .media video, .media img { width: 100%; display: block; }

    .card { background: #14141f; border: 1px solid #222; border-radius: 12px; padding: 1.5rem; margin: 1.5rem 0; }
    .card h2 { font-size: 1.3rem; margin-bottom: 1rem; color: #ccc; }
    .card h3 { font-size: 1.1rem; margin: 1rem 0 0.5rem; color: #aaa; }

    .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin: 1rem 0; }
    .plan { background: #1a1a2e; border: 1px solid #333; border-radius: 10px; padding: 1.2rem; text-align: center; }
    .plan .price { font-size: 1.8rem; font-weight: 700; color: #667eea; }
    .plan .unit { font-size: 0.85rem; color: #888; }
    .plan .note { font-size: 0.8rem; color: #666; margin-top: 0.5rem; }

    .btn { display: inline-block; padding: 12px 28px; background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; text-decoration: none; }
    .btn:hover { opacity: 0.9; }
    .btn-outline { background: transparent; border: 1px solid #667eea; color: #667eea; }
    .btn-sm { padding: 8px 18px; font-size: 0.9rem; }
    .btn-danger { background: #dc2626; }

    .form-group { margin-bottom: 1rem; }
    .form-group label { display: block; font-size: 0.85rem; color: #999; margin-bottom: 0.3rem; }
    .form-group input { width: 100%; padding: 10px 14px; background: #1a1a2e; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-size: 1rem; }
    .form-group input:focus { outline: none; border-color: #667eea; }
    .form-group .input-status { font-size: 0.8em; margin-top: 4px; min-height: 1.2em; }
    .form-group .input-status.ok { color: #27ae60; }
    .form-group .input-status.taken { color: #e74c3c; }
    .form-group .input-status.checking { color: #f39c12; }

    .tabs { display: flex; gap: 0; margin-bottom: 1.5rem; }
    .tab { flex: 1; padding: 10px; text-align: center; background: #14141f; border: 1px solid #222; cursor: pointer; color: #888; }
    .tab:first-child { border-radius: 8px 0 0 8px; }
    .tab:last-child { border-radius: 0 8px 8px 0; }
    .tab.active { background: #667eea; color: #fff; border-color: #667eea; }

    .msg { padding: 10px 14px; border-radius: 8px; margin: 1rem 0; font-size: 0.9rem; }
    .msg.success { background: #0a2e1a; border: 1px solid #22c55e; color: #4ade80; }
    .msg.error { background: #2e0a0a; border: 1px solid #ef4444; color: #f87171; }

    #account-info { display: none; }
    #auth-section { display: block; }

    .download-section { text-align: center; padding: 2rem 0; }
    .download-section .btn { font-size: 1.1rem; padding: 14px 36px; }

    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.8rem; }
    .feature { display: flex; align-items: center; gap: 8px; color: #aaa; font-size: 0.9rem; }

    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 0.8rem; background: #1a3a1a; color: #4ade80; }

    a { color: #667eea; text-decoration: none; }
    a:hover { text-decoration: underline; }

    footer { text-align: center; padding: 2rem 0; color: #444; font-size: 0.85rem; }
    .hidden { display: none; }

    .qr-box { background: #fff; padding: 16px; border-radius: 12px; display: inline-block; margin: 1rem 0; }
    .qr-box svg { display: block; }
    .totp-secret { font-family: monospace; background: #1a1a2e; padding: 8px 12px; border-radius: 6px; font-size: 0.9rem; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">

    <header>
      <h1>RulerHorseback</h1>
      <p class="subtitle">Native desktop todo app built with Tauri + Rust</p>
      <p class="tagline">Fast. Private. Local-first. Credits for premium features.</p>
    </header>

    <div class="media">
      <video autoplay muted loop playsinline poster="/screenshot.png">
        <source src="/demo.mp4" type="video/mp4" />
      </video>
    </div>

    <div class="download-section">
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
        <a href="/rulerhorseback_0.1.0_x64.dmg" class="btn">⬇ Download DMG</a>
        <a href="/rulerhorseback.app" class="btn btn-outline">⬇ Download .app</a>
      </div>
      <p style="margin-top: 0.8rem; font-size: 0.85rem; color: #666;">
        DMG ~7MB · macOS 12+ · Apple Silicon & Intel
      </p>
    </div>

    <div class="card">
      <h2>✨ Features</h2>
      <div class="features">
        <div class="feature">⚡ Rust backend, native performance</div>
        <div class="feature">🖥️ Cross-platform (Mac/Win/Linux)</div>
        <div class="feature">🔒 Local-first — your data stays on your machine</div>
        <div class="feature">🎯 Credit system for premium actions (delete, edit)</div>
        <div class="feature">📊 Categories and organization</div>
        <div class="feature">🔐 Two-factor authentication (TOTP)</div>
      </div>
    </div>

    <div class="screenshot-media card" style="padding:0;overflow:hidden;">
      <img src="/screenshot.png" alt="RulerHorseback screenshot" style="width:100%;display:block;" />
    </div>

    <!-- Auth & Account Section -->
    <div class="card" id="auth-section">
      <h2>🔑 Account</h2>
      <p style="color:#888;font-size:0.9rem;margin-bottom:1rem;">Create an account to manage credits and purchases.</p>

      <div class="tabs">
        <div class="tab active" onclick="switchTab('login')">Login</div>
        <div class="tab" onclick="switchTab('register')">Register</div>
      </div>

      <div id="login-form">
        <div class="form-group">
          <label>Username</label>
          <input id="login-username" type="text" placeholder="Your username" />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input id="login-password" type="password" placeholder="At least 7 chars with 1 digit" />
        </div>
        <div class="form-group" id="login-totp-group" style="display:none">
          <label>TOTP Code</label>
          <input id="login-totp" type="text" placeholder="6-digit code" maxlength="6" />
        </div>
        <button class="btn" onclick="login()">Login</button>
        <div style="margin-top:8px"><a href="#" onclick="showForgotPassword();return false;" style="color:#667eea;font-size:0.85em">Forgot password?</a></div>
        <div id="login-msg" class="msg hidden"></div>
      </div>

      <div id="register-form" class="hidden">
        <div class="form-group">
          <label>Username</label>
          <input id="reg-username" type="text" placeholder="Choose a username" />
          <div id="reg-username-status" class="input-status"></div>
        </div>
        <div class="form-group">
          <label>Password</label>
          <input id="reg-password" type="password" placeholder="At least 7 chars with 1 digit" />
        </div>
        <button class="btn" onclick="register()">Create Account</button>
        <div id="reg-msg" class="msg hidden"></div>
      </div>
    </div>

    <!-- Forgot Password -->
    <div class="card hidden" id="forgot-section">
      <h2>🔄 Reset Password</h2>
      <p style="color:#888;font-size:0.85rem;margin-bottom:1rem;">Enter your username and TOTP code to verify identity.</p>
      <div class="form-group">
        <label>Username</label>
        <input id="forgot-username" type="text" placeholder="Your username" />
      </div>
      <div class="form-group">
        <label>TOTP Code</label>
        <input id="forgot-totp" type="text" placeholder="6-digit code" maxlength="6" />
      </div>
      <button class="btn" onclick="forgotPassword()">Verify Identity</button>
      <div id="forgot-msg" class="msg hidden"></div>
    </div>

    <!-- Reset Password (after TOTP verified) -->
    <div class="card hidden" id="reset-section">
      <h2>🔐 Set New Password</h2>
      <p style="color:#4ade80;font-size:0.85rem;margin-bottom:1rem;">✓ Identity verified.</p>
      <div class="form-group">
        <label>New Password</label>
        <input id="reset-password" type="password" placeholder="At least 7 chars with 1 digit" />
      </div>
      <div class="form-group">
        <label>Confirm Password</label>
        <input id="reset-password2" type="password" placeholder="Repeat password" />
      </div>
      <button class="btn" onclick="resetPassword()">Reset Password</button>
      <div id="reset-msg" class="msg hidden"></div>
    </div>

    <!-- Account Info (shown after login) -->
    <div class="card" id="account-info">
      <h2>👤 <span id="display-username"></span> <span class="status-badge" id="display-credits"></span>
        <button class="btn btn-sm btn-outline" onclick="logout()" style="float:right;">Logout</button>
      </h2>

      <div id="totp-section" style="margin:1rem 0;">
        <h3>Two-Factor Authentication</h3>
        <div id="totp-status"></div>
      </div>

      <h3>Credit Packs</h3>
      <div class="plans" id="plans-list"></div>
      <div id="purchase-msg" class="msg hidden"></div>
    </div>

    <footer>
      <p>RulerHorseback · Built with Tauri v2 + Rust + React</p>
      <p style="margin-top:0.3rem;"><a href="https://glueing-paddles.pendia-community.workers.dev/project/rulerhorseback-todo-gui">View on Glueing Paddles</a></p>
    </footer>
  </div>

  <script>
    let TOKEN = localStorage.getItem('rh_token');
    let USERNAME = localStorage.getItem('rh_username');
    let TOTP_ENABLED = false;
    let RESET_TOKEN = null;
    let usernameCheckTimer = null;

    function showMsg(id, text, type) {
      const el = document.getElementById(id);
      el.textContent = text;
      el.className = 'msg ' + type;
      el.classList.remove('hidden');
    }

    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById('login-form').classList.add('hidden');
      document.getElementById('register-form').classList.add('hidden');
      if (tab === 'login') {
        document.querySelector('.tabs .tab:first-child').classList.add('active');
        document.getElementById('login-form').classList.remove('hidden');
      } else {
        document.querySelector('.tabs .tab:last-child').classList.add('active');
        document.getElementById('register-form').classList.remove('hidden');
      }
    }

    // Live username check
    document.addEventListener('DOMContentLoaded', function() {
      const regInput = document.getElementById('reg-username');
      if (regInput) {
        regInput.addEventListener('input', function() {
          const val = this.value.trim();
          const statusEl = document.getElementById('reg-username-status');
          if (usernameCheckTimer) clearTimeout(usernameCheckTimer);
          if (val.length < 2) { statusEl.textContent = ''; statusEl.className = 'input-status'; return; }
          statusEl.textContent = 'Checking...';
          statusEl.className = 'input-status checking';
          usernameCheckTimer = setTimeout(async () => {
            try {
              const res = await fetch('/api/auth/check-username?username=' + encodeURIComponent(val));
              const data = await res.json();
              if (data.available) {
                statusEl.textContent = '✓ Available';
                statusEl.className = 'input-status ok';
              } else {
                statusEl.textContent = '✗ Already taken';
                statusEl.className = 'input-status taken';
              }
            } catch(e) {
              statusEl.textContent = '';
            }
          }, 300);
        });
      }
    });

    async function register() {
      const username = document.getElementById('reg-username').value.trim();
      const password = document.getElementById('reg-password').value;
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (data.error) {
          showMsg('reg-msg', data.error, 'error');
        } else {
          showMsg('reg-msg', 'Account created! Save your TOTP secret to enable 2FA later.', 'success');
          TOKEN = data.token;
          USERNAME = data.username;
          localStorage.setItem('rh_token', TOKEN);
          localStorage.setItem('rh_username', USERNAME);
          setTimeout(() => location.reload(), 1500);
        }
      } catch (e) {
        showMsg('reg-msg', 'Network error', 'error');
      }
    }

    async function login() {
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      const totpGroup = document.getElementById('login-totp-group');
      const totpInput = document.getElementById('login-totp');
      const totpCode = totpGroup.style.display !== 'none' ? totpInput.value : undefined;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, totpCode }),
        });
        const data = await res.json();
        if (data.totpRequired) {
          totpGroup.style.display = 'block';
          showMsg('login-msg', 'Enter your TOTP code', 'error');
          return;
        }
        if (data.error) {
          showMsg('login-msg', data.error, 'error');
        } else {
          showMsg('login-msg', 'Logged in!', 'success');
          TOKEN = data.token;
          USERNAME = data.username;
          TOTP_ENABLED = data.totpEnabled;
          localStorage.setItem('rh_token', TOKEN);
          localStorage.setItem('rh_username', USERNAME);
          setTimeout(() => location.reload(), 500);
        }
      } catch (e) {
        showMsg('login-msg', 'Network error', 'error');
      }
    }

    function showForgotPassword() {
      document.getElementById('auth-section').classList.add('hidden');
      document.getElementById('forgot-section').classList.remove('hidden');
    }

    async function forgotPassword() {
      const username = document.getElementById('forgot-username').value.trim();
      const totpCode = document.getElementById('forgot-totp').value.trim();
      if (!username || !totpCode) { showMsg('forgot-msg', 'Username and TOTP code required', 'error'); return; }
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, totpCode }),
        });
        const data = await res.json();
        if (data.error) {
          showMsg('forgot-msg', data.error, 'error');
        } else {
          RESET_TOKEN = data.resetToken;
          document.getElementById('forgot-section').classList.add('hidden');
          document.getElementById('reset-section').classList.remove('hidden');
        }
      } catch (e) {
        showMsg('forgot-msg', 'Network error', 'error');
      }
    }

    async function resetPassword() {
      const pw = document.getElementById('reset-password').value;
      const pw2 = document.getElementById('reset-password2').value;
      if (pw.length < 7) { showMsg('reset-msg', 'Password min 7 chars', 'error'); return; }
      if (pw !== pw2) { showMsg('reset-msg', 'Passwords do not match', 'error'); return; }
      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resetToken: RESET_TOKEN, newPassword: pw }),
        });
        const data = await res.json();
        if (data.error) {
          showMsg('reset-msg', data.error, 'error');
        } else {
          showMsg('reset-msg', 'Password reset! Login with new password.', 'success');
          RESET_TOKEN = null;
          setTimeout(() => { document.getElementById('reset-section').classList.add('hidden'); document.getElementById('auth-section').classList.remove('hidden'); switchTab('login'); }, 1500);
        }
      } catch (e) {
        showMsg('reset-msg', 'Network error', 'error');
      }
    }

    function logout() {
      localStorage.removeItem('rh_token');
      localStorage.removeItem('rh_username');
      location.reload();
    }

    function showAccount() {
      document.getElementById('auth-section').style.display = 'none';
      document.getElementById('account-info').style.display = 'block';
      document.getElementById('display-username').textContent = USERNAME;
      loadCredits();
      loadPlans();
      loadTOTPStatus();
    }

    async function loadTOTPStatus() {
      try {
        const res = await fetch('/api/user/totp/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
        });
        const data = await res.json();
        const statusEl = document.getElementById('totp-status');
        if (data.secret) {
          // Show QR code and secret
          const qrSvg = generateQR(data.uri);
          statusEl.innerHTML = '<p style="margin-bottom:8px">Secret: <span class="totp-secret">' + data.secret + '</span></p>' +
            '<div class="qr-box">' + qrSvg + '</div>' +
            '<p style="color:#888;font-size:0.85rem;margin:8px 0">Scan with Google Authenticator, Authy, or any TOTP app. Then enter a code to enable.</p>' +
            '<div class="form-group"><input id="totp-enable-code" type="text" placeholder="Enter 6-digit code" maxlength="6" /></div>' +
            '<button class="btn btn-sm" onclick="enableTOTP()">Enable TOTP</button>';
        }
      } catch {}
    }

    async function enableTOTP() {
      const code = document.getElementById('totp-enable-code').value.trim();
      if (!code) { alert('Enter TOTP code'); return; }
      try {
        const res = await fetch('/api/user/totp/enable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        if (data.error) {
          alert(data.error);
        } else {
          alert('TOTP enabled!');
          TOTP_ENABLED = true;
          loadTOTPStatus();
        }
      } catch { alert('Network error'); }
    }

    // Simple QR code generator (SVG) — uses a basic pattern from the URI
    function generateQR(uri) {
      // Use a simple QR-like pattern (visual only — real QR requires a library)
      // For production, use an API or library. This is a placeholder visual.
      const size = 200;
      const cells = 25;
      const cellSize = size / cells;
      let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">';
      svg += '<rect width="' + size + '" height="' + size + '" fill="white"/>';
      // Deterministic pseudo-random pattern from URI
      let hash = 0;
      for (let i = 0; i < uri.length; i++) { hash = ((hash << 5) - hash) + uri.charCodeAt(i); hash |= 0; }
      for (let r = 0; r < cells; r++) {
        for (let c = 0; c < cells; c++) {
          // Skip finder patterns corners
          if ((r < 7 && c < 7) || (r < 7 && c >= cells-7) || (r >= cells-7 && c < 7)) {
            // Draw finder pattern
            if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
              svg += '<rect x="' + (c*cellSize) + '" y="' + (r*cellSize) + '" width="' + cellSize + '" height="' + cellSize + '" fill="black"/>';
            }
            continue;
          }
          hash = ((hash << 5) - hash) + r * cells + c;
          hash |= 0;
          if ((hash & 1) === 1) {
            svg += '<rect x="' + (c*cellSize) + '" y="' + (r*cellSize) + '" width="' + cellSize + '" height="' + cellSize + '" fill="black"/>';
          }
        }
      }
      svg += '</svg>';
      return svg;
    }

    async function loadCredits() {
      try {
        const res = await fetch('/api/credits/status', {
          headers: { 'Authorization': 'Bearer ' + TOKEN },
        });
        const data = await res.json();
        document.getElementById('display-credits').textContent = data.credits + ' credits';
      } catch {}
    }

    async function loadPlans() {
      try {
        const res = await fetch('/api/credits/plans');
        const data = await res.json();
        const html = data.plans.map(p => \`
          <div class="plan">
            <div class="price">$\${p.price}</div>
            <div class="unit">USD · \${p.credits} credits</div>
            <div style="margin:0.5rem 0;font-weight:600;color:#ccc;">\${p.label}</div>
            <div class="note">\${p.note}</div>
            <button class="btn btn-sm" style="margin-top:0.8rem;" onclick="buyCredits(\${p.credits})">Purchase</button>
          </div>
        \`).join('');
        document.getElementById('plans-list').innerHTML = html;
      } catch {}
    }

    async function buyCredits(credits) {
      try {
        const res = await fetch('/api/stripe/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
          body: JSON.stringify({ credits }),
        });
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
        } else {
          showMsg('purchase-msg', data.error || 'Purchase failed', 'error');
        }
      } catch (e) {
        showMsg('purchase-msg', 'Network error', 'error');
      }
    }

    // On load
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success') {
      alert('✅ Payment successful! Credits added to your account.');
    } else if (params.get('payment') === 'cancelled') {
      alert('❌ Payment cancelled. No credits charged.');
    }

    if (TOKEN) {
      showAccount();
    }
  </script>
</body>
</html>`

app.get('/', (c) => c.html(LANDING_HTML))

// Catch-all: API 404, landing page for everything else
// Static files (dmg, zip, png, mp4, etc.) are served by Cloudflare assets handler
app.all('*', async (c) => {
  const url = new URL(c.req.url)
  if (url.pathname.startsWith('/api/')) return c.json({ error: 'Not found' }, 404)
  // Return 404 for file requests — Cloudflare will then serve from assets
  if (/\.\w{2,5}$/.test(url.pathname)) return c.notFound()
  return c.html(LANDING_HTML)
})

export default app
