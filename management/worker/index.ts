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
  if (!username || username.length < 2) return c.json({ available: false })
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

  await c.env.DB.prepare(
    'INSERT INTO users (id, username, password_hash, credits) VALUES (?, ?, ?, ?)'
  ).bind(userId, username, hash, 50).run()

  const token = await sign({ userId, username }, c.env.JWT_SECRET)
  return c.json({ success: true, userId, username, token, credits: 50 }, 201)
})

app.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>()
  if (!username || !password) return c.json({ error: 'Missing fields' }, 400)

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first() as any
  if (!user) return c.json({ error: 'Invalid credentials' }, 401)

  const hash = await hashPassword(password, user.id)
  if (hash !== user.password_hash) return c.json({ error: 'Invalid credentials' }, 401)

  const token = await sign({ userId: user.id, username: user.username }, c.env.JWT_SECRET)
  return c.json({ success: true, userId: user.id, username: user.username, token, credits: user.credits || 0 })
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
// STRIPE
// ═══════════════════════════════════════════

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
    const key = await crypto.subtle.importKey('raw', encoder.encode(c.env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const expectedSig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload))
    const expectedHex = hexEncode(expectedSig)
    if (expectedHex !== sigValue) return c.json({ error: 'Invalid signature' }, 401)
  }

  let event: any
  try { event = JSON.parse(body) } catch { return c.json({ error: 'Invalid payload' }, 400) }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const userId = session.metadata?.user_id
    const credits = parseInt(session.metadata?.credits || '0')
    const amount = session.amount_total / 100

    if (userId && credits > 0) {
      await c.env.DB.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').bind(credits, userId).run()
      await c.env.DB.prepare(
        'INSERT INTO credit_purchases (id, user_id, credits, amount, stripe_session_id) VALUES (?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), userId, credits, amount, session.id).run()
    }
  }

  return c.json({ received: true })
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

    .form-group { margin-bottom: 1rem; }
    .form-group label { display: block; font-size: 0.85rem; color: #999; margin-bottom: 0.3rem; }
    .form-group input { width: 100%; padding: 10px 14px; background: #1a1a2e; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-size: 1rem; }
    .form-group input:focus { outline: none; border-color: #667eea; }

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
        <a href="/rulerhorseback.dmg" class="btn">⬇ Download DMG</a>
        <a href="/rulerhorseback.app.zip" class="btn btn-outline">⬇ Download .app</a>
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
        <button class="btn" onclick="login()">Login</button>
        <div id="login-msg" class="msg hidden"></div>
      </div>

      <div id="register-form" class="hidden">
        <div class="form-group">
          <label>Username</label>
          <input id="reg-username" type="text" placeholder="Choose a username" />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input id="reg-password" type="password" placeholder="At least 7 chars with 1 digit" />
        </div>
        <button class="btn" onclick="register()">Create Account</button>
        <div id="reg-msg" class="msg hidden"></div>
      </div>
    </div>

    <!-- Account Info (shown after login) -->
    <div class="card" id="account-info">
      <h2>👤 <span id="display-username"></span> <span class="status-badge" id="display-credits"></span>
        <button class="btn btn-sm btn-outline" onclick="logout()" style="float:right;">Logout</button>
      </h2>

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
          showMsg('reg-msg', 'Account created! Logging in...', 'success');
          TOKEN = data.token;
          USERNAME = data.username;
          localStorage.setItem('rh_token', TOKEN);
          localStorage.setItem('rh_username', USERNAME);
          setTimeout(() => location.reload(), 1000);
        }
      } catch (e) {
        showMsg('reg-msg', 'Network error', 'error');
      }
    }

    async function login() {
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (data.error) {
          showMsg('login-msg', data.error, 'error');
        } else {
          showMsg('login-msg', 'Logged in!', 'success');
          TOKEN = data.token;
          USERNAME = data.username;
          localStorage.setItem('rh_token', TOKEN);
          localStorage.setItem('rh_username', USERNAME);
          setTimeout(() => location.reload(), 500);
        }
      } catch (e) {
        showMsg('login-msg', 'Network error', 'error');
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
            <div class="price">\${p.price}</div>
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
app.all('*', async (c) => {
  const url = new URL(c.req.url)
  if (url.pathname.startsWith('/api/')) return c.json({ error: 'Not found' }, 404)
  return c.html(LANDING_HTML)
})

export default app
