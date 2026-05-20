import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

const app = new Hono()

app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './' }))

// ─── Config ────────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'bounty2025'   // change before deploy

// ─── Types ─────────────────────────────────────────────────────────────────────
type Priority = 'top-bounty' | 'high-priority' | 'gap-killer' | 'standard'
type Status = 'active' | 'filled' | 'expired'

interface Property {
  id: string
  name: string
  photo: string
  priority: Priority
  why: string
  eligibleDates: string
  minStay: number
  bountyPerNight: number
  bonusAmount: number
  bonusCondition: string
  cap: number
  status: Status
  postedAt: string
  bountyIncreasedAt?: string   // ISO timestamp of last increase -- used for board highlight
  previousBounty?: number      // what it was before the last change
}

interface ChangeLog {
  id: string
  propertyId: string
  propertyName: string
  field: string
  oldValue: string | number
  newValue: string | number
  changedAt: string
  isIncrease: boolean          // true when bountyPerNight or bonusAmount went up
}

interface Booking {
  id: string
  propertyId: string
  agentName: string
  guestName: string
  checkIn: string
  checkOut: string
  nights: number
  rate: number
  isWeekend: boolean
  isLastMinute: boolean
  isLongStay: boolean
  baseBounty: number
  bonusEarned: number
  totalEarned: number
  status: 'pending' | 'cleared' | 'disqualified'
  submittedAt: string
}

// ─── Data Store ────────────────────────────────────────────────────────────────
const properties: Property[] = [
  {
    id: 'fire-station-lodge',
    name: 'Fire Station Lodge',
    photo: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&q=80',
    priority: 'top-bounty',
    why: 'Too many open dates on the calendar',
    eligibleDates: 'May 26 – June 30',
    minStay: 2,
    bountyPerNight: 3,
    bonusAmount: 15,
    bonusCondition: 'Fill a full calendar gap',
    cap: 35,
    status: 'active',
    postedAt: new Date().toISOString(),
  },
  {
    id: 'lakeview-retreat',
    name: 'Lakeview Retreat',
    photo: 'https://images.unsplash.com/photo-1449158743715-0a90ebb6d2d8?w=600&q=80',
    priority: 'high-priority',
    why: 'New owner unit – needs early momentum',
    eligibleDates: 'Next 45 days',
    minStay: 2,
    bountyPerNight: 5,
    bonusAmount: 25,
    bonusCondition: 'After 3 separate bookings',
    cap: 40,
    status: 'active',
    postedAt: new Date().toISOString(),
  },
  {
    id: 'pine-ridge-cabin',
    name: 'Pine Ridge Cabin',
    photo: 'https://images.unsplash.com/photo-1510798831971-661eb04b3739?w=600&q=80',
    priority: 'gap-killer',
    why: 'Small gap that needs to be filled',
    eligibleDates: 'May 20 – May 23',
    minStay: 2,
    bountyPerNight: 3,
    bonusAmount: 20,
    bonusCondition: 'Fill this exact gap',
    cap: 30,
    status: 'active',
    postedAt: new Date().toISOString(),
  },
]

const bookings: Booking[] = []
const changelog: ChangeLog[] = []

// ─── Global Bonus Rules (editable via Admin) ───────────────────────────────────
const bonusRules = {
  lastMinute: { amount: 25, label: 'LAST MINUTE HERO', description: 'within 14 days', icon: 'bolt' },
  weekend:    { amount: 15, label: 'WEEKEND WARRIOR',  description: 'Fri or Sat night', icon: 'calendar-week' },
  longStay:   { amount: 15, label: 'LONG STAY LEGEND', description: '5+ nights',        icon: 'moon' },
}

const leaderboard: { name: string; total: number; bookings: number }[] = [
  { name: 'Sarah M.', total: 187, bookings: 6 },
  { name: 'Jake T.', total: 142, bookings: 5 },
  { name: 'Carmen R.', total: 98, bookings: 3 },
]

// ─── Auth ──────────────────────────────────────────────────────────────────────
// Simple session store -- maps token -> expiry timestamp
const sessions: Map<string, number> = new Map()

function makeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

function isValidSession(token: string | undefined): boolean {
  if (!token) return false
  const exp = sessions.get(token)
  if (!exp) return false
  if (Date.now() > exp) { sessions.delete(token); return false }
  return true
}

app.post('/api/auth/login', async (c) => {
  const { password } = await c.req.json<{ password: string }>()
  if (password !== ADMIN_PASSWORD) {
    return c.json({ error: 'Invalid password' }, 401)
  }
  const token = makeToken()
  sessions.set(token, Date.now() + 4 * 60 * 60 * 1000) // 4-hour session
  return c.json({ token })
})

app.post('/api/auth/logout', async (c) => {
  const token = c.req.header('x-admin-token')
  if (token) sessions.delete(token)
  return c.json({ ok: true })
})

app.get('/api/auth/check', (c) => {
  const token = c.req.header('x-admin-token')
  return c.json({ valid: isValidSession(token) })
})

// ─── Properties API ────────────────────────────────────────────────────────────
app.get('/api/properties', (c) => {
  return c.json(properties)
})

app.get('/api/properties/:id', (c) => {
  const prop = properties.find((p) => p.id === c.req.param('id'))
  if (!prop) return c.json({ error: 'Not found' }, 404)
  return c.json(prop)
})

app.post('/api/properties', async (c) => {
  if (!isValidSession(c.req.header('x-admin-token'))) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json<Omit<Property, 'id' | 'postedAt'>>()
  const newProp: Property = {
    ...body,
    id: body.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(),
    postedAt: new Date().toISOString(),
  }
  properties.push(newProp)
  return c.json(newProp, 201)
})

// Full property update (inline edit)
app.patch('/api/properties/:id', async (c) => {
  if (!isValidSession(c.req.header('x-admin-token'))) return c.json({ error: 'Unauthorized' }, 401)
  const prop = properties.find((p) => p.id === c.req.param('id'))
  if (!prop) return c.json({ error: 'Not found' }, 404)

  const updates = await c.req.json<Partial<Property>>()
  const now = new Date().toISOString()
  const moneyFields: (keyof Property)[] = ['bountyPerNight', 'bonusAmount', 'cap']

  // Track changes
  for (const [key, newVal] of Object.entries(updates)) {
    const k = key as keyof Property
    const oldVal = prop[k]
    if (oldVal === newVal) continue

    const isMoneyField = moneyFields.includes(k)
    const isIncrease = isMoneyField &&
      typeof newVal === 'number' && typeof oldVal === 'number' && newVal > oldVal

    changelog.unshift({
      id: 'log-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      propertyId: prop.id,
      propertyName: prop.name,
      field: key,
      oldValue: oldVal as string | number,
      newValue: newVal as string | number,
      changedAt: now,
      isIncrease,
    })

    // Flag on the property itself so the board can highlight it
    if (k === 'bountyPerNight' && isIncrease) {
      prop.bountyIncreasedAt = now
      prop.previousBounty = oldVal as number
    }
  }

  Object.assign(prop, updates)
  return c.json(prop)
})

app.patch('/api/properties/:id/status', async (c) => {
  if (!isValidSession(c.req.header('x-admin-token'))) return c.json({ error: 'Unauthorized' }, 401)
  const prop = properties.find((p) => p.id === c.req.param('id'))
  if (!prop) return c.json({ error: 'Not found' }, 404)
  const { status } = await c.req.json<{ status: Status }>()
  prop.status = status
  return c.json(prop)
})

app.delete('/api/properties/:id', (c) => {
  if (!isValidSession(c.req.header('x-admin-token'))) return c.json({ error: 'Unauthorized' }, 401)
  const idx = properties.findIndex((p) => p.id === c.req.param('id'))
  if (idx === -1) return c.json({ error: 'Not found' }, 404)
  properties.splice(idx, 1)
  return c.json({ success: true })
})

// ─── Bonus Rules API ──────────────────────────────────────────────────────────
app.get('/api/bonus-rules', (c) => {
  return c.json(bonusRules)
})

app.patch('/api/bonus-rules', async (c) => {
  if (!isValidSession(c.req.header('x-admin-token'))) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json<Partial<typeof bonusRules>>()
  if (body.lastMinute) {
    if (typeof body.lastMinute.amount      === 'number') bonusRules.lastMinute.amount      = body.lastMinute.amount
    if (typeof body.lastMinute.label       === 'string') bonusRules.lastMinute.label       = body.lastMinute.label
    if (typeof body.lastMinute.description === 'string') bonusRules.lastMinute.description = body.lastMinute.description
  }
  if (body.weekend) {
    if (typeof body.weekend.amount      === 'number') bonusRules.weekend.amount      = body.weekend.amount
    if (typeof body.weekend.label       === 'string') bonusRules.weekend.label       = body.weekend.label
    if (typeof body.weekend.description === 'string') bonusRules.weekend.description = body.weekend.description
  }
  if (body.longStay) {
    if (typeof body.longStay.amount      === 'number') bonusRules.longStay.amount      = body.longStay.amount
    if (typeof body.longStay.label       === 'string') bonusRules.longStay.label       = body.longStay.label
    if (typeof body.longStay.description === 'string') bonusRules.longStay.description = body.longStay.description
  }
  return c.json(bonusRules)
})

// ─── Changelog API ─────────────────────────────────────────────────────────────
app.get('/api/changelog', (c) => {
  return c.json(changelog.slice(0, 100)) // most recent 100
})

// ─── Bookings API ──────────────────────────────────────────────────────────────
app.get('/api/bookings', (c) => {
  return c.json(bookings)
})

app.post('/api/bookings', async (c) => {
  const body = await c.req.json<Omit<Booking, 'id' | 'submittedAt' | 'baseBounty' | 'bonusEarned' | 'totalEarned' | 'status'>>()
  const prop = properties.find((p) => p.id === body.propertyId)
  if (!prop) return c.json({ error: 'Property not found' }, 404)

  const baseBounty = Math.min(body.nights * prop.bountyPerNight, prop.cap)
  let bonusEarned = 0
  if (body.isLastMinute) bonusEarned += bonusRules.lastMinute.amount
  if (body.isWeekend)    bonusEarned += bonusRules.weekend.amount
  if (body.isLongStay)   bonusEarned += bonusRules.longStay.amount
  const totalEarned = baseBounty + bonusEarned

  const booking: Booking = {
    ...body,
    id: 'booking-' + Date.now(),
    baseBounty,
    bonusEarned,
    totalEarned,
    status: 'pending',
    submittedAt: new Date().toISOString(),
  }
  bookings.push(booking)

  const existing = leaderboard.find((l) => l.name === body.agentName)
  if (existing) {
    existing.total += totalEarned
    existing.bookings += 1
  } else {
    leaderboard.push({ name: body.agentName, total: totalEarned, bookings: 1 })
  }
  leaderboard.sort((a, b) => b.total - a.total)

  return c.json(booking, 201)
})

app.patch('/api/bookings/:id/status', async (c) => {
  if (!isValidSession(c.req.header('x-admin-token'))) return c.json({ error: 'Unauthorized' }, 401)
  const booking = bookings.find((b) => b.id === c.req.param('id'))
  if (!booking) return c.json({ error: 'Not found' }, 404)
  const { status } = await c.req.json<{ status: Booking['status'] }>()
  booking.status = status
  return c.json(booking)
})

app.get('/api/leaderboard', (c) => {
  return c.json(leaderboard)
})

// ─── Frontend ──────────────────────────────────────────────────────────────────
app.get('*', (c) => {
  return c.html(/* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Thousand Hills – Booking Bounty Board</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=Dancing+Script:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            display: ['Playfair Display', 'serif'],
            script:  ['Dancing Script', 'cursive'],
          },
          colors: {
            bounty: {
              dark:      '#1a1208',
              brown:     '#5c3d1e',
              tan:       '#f5e6c8',
              parchment: '#fdf6e3',
              red:       '#c0392b',
              gold:      '#d4a017',
              blue:      '#1a3a5c',
              green:     '#1e6b3a',
            }
          }
        }
      }
    }
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #1a1208; }

    /* ── Parchment texture ── */
    .parchment {
      background: #fdf6e3;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
    }

    /* ── Corkboard ── */
    .corkboard {
      background-color: #c8a060;
      background-image: url('/static/cork-bg.jpg');
      background-repeat: repeat;
      background-size: 380px 380px;
      background-attachment: local;
    }

    /* ── Ribbons ── */
    .ribbon-top  { background: linear-gradient(90deg,#c0392b,#922b21); color:#fff; }
    .ribbon-high { background: linear-gradient(90deg,#d4a017,#a07810); color:#fff; }
    .ribbon-gap  { background: linear-gradient(90deg,#1a3a5c,#0d2540); color:#ffd700; }
    .ribbon-std  { background: linear-gradient(90deg,#1e6b3a,#145429); color:#fff; }

    /* ── Card shadow + tilt ── */
    .card-shadow { box-shadow: 4px 6px 20px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.15); }
    .tilt-l { transform: rotate(-1deg); }
    .tilt-r { transform: rotate(0.8deg); }
    .tilt-n { transform: rotate(-0.3deg); }

    /* ── Bounty panel inside card ── */
    .bounty-panel { background: linear-gradient(135deg,#1a1208,#2d1f0a); }
    .bonus-chip   { background: linear-gradient(135deg,#c0392b,#922b21); }

    /* ── Nav active ── */
    .nav-btn { border-bottom: 2px solid transparent; transition: all .2s; }
    .nav-active { border-bottom: 2px solid #d4a017 !important; color:#fff !important; }

    /* ── Pushpins ── */
    .pin { width:16px; height:16px; border-radius:50%; position:absolute; top:-8px; left:50%; transform:translateX(-50%); box-shadow:0 2px 6px rgba(0,0,0,0.6); z-index:10; }
    .pin-red    { background:radial-gradient(circle at 35% 35%,#ff6b6b,#c0392b); }
    .pin-gold   { background:radial-gradient(circle at 35% 35%,#ffe066,#d4a017); }
    .pin-blue   { background:radial-gradient(circle at 35% 35%,#74b9ff,#1a3a5c); }
    .pin-green  { background:radial-gradient(circle at 35% 35%,#55efc4,#1e6b3a); }

    /* ── Badge labels (admin) ── */
    .badge-top  { background:#c0392b; color:#fff; }
    .badge-high { background:#d4a017; color:#fff; }
    .badge-gap  { background:#1a3a5c; color:#ffd700; }
    .badge-std  { background:#1e6b3a; color:#fff; }

    /* ── Increase highlight on board card ── */
    @keyframes pulseGold {
      0%,100% { box-shadow: 4px 6px 20px rgba(0,0,0,0.35), 0 0 0 0 rgba(212,160,23,0.6); }
      50%      { box-shadow: 4px 6px 20px rgba(0,0,0,0.35), 0 0 0 8px rgba(212,160,23,0); }
    }
    .bounty-increased { animation: pulseGold 2s ease-in-out 3; border: 2px solid #d4a017 !important; }

    /* ── Increase banner pill ── */
    .increase-pill {
      background: linear-gradient(90deg,#d4a017,#c0392b);
      color: #fff; font-size:10px; font-weight:800;
      letter-spacing:.07em; text-transform:uppercase;
      padding:2px 8px; border-radius:999px;
      display:inline-flex; align-items:center; gap:4px;
    }

    /* ── Status pills ── */
    .s-active { background:#d4edda; color:#155724; }
    .s-filled { background:#cce5ff; color:#004085; }
    .s-expired{ background:#f8d7da; color:#721c24; }
    .s-pending { background:#fff3cd; color:#856404; }
    .s-cleared { background:#d4edda; color:#155724; }
    .s-disq    { background:#f8d7da; color:#721c24; }

    /* ── Inline edit row ── */
    .edit-input {
      border: 1px solid #d4a017;
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 13px;
      background: #fffef5;
      width: 80px;
      outline: none;
    }
    .edit-input:focus { box-shadow: 0 0 0 2px rgba(212,160,23,0.35); }

    /* ── Admin login overlay ── */
    #admin-gate {
      position:fixed; inset:0; background:rgba(20,10,0,0.92);
      display:flex; align-items:center; justify-content:center;
      z-index:9999;
    }
    #admin-gate.hidden { display:none; }

    /* ── Changelog ── */
    .cl-increase { border-left: 3px solid #d4a017; background: #fffbee; }
    .cl-decrease { border-left: 3px solid #1a3a5c; background: #f5f8ff; }
    .cl-neutral  { border-left: 3px solid #ccc;    background: #fafafa; }

    select, input[type=text], input[type=number], input[type=date],
    input[type=url], input[type=password], textarea { background: #fff; }

    .th-input {
      width:100%; border:1px solid rgba(212,160,23,0.4); border-radius:4px;
      padding:8px 10px; font-size:14px; background:#fff; outline:none;
      transition: border .2s;
    }
    .th-input:focus { border-color:#d4a017; box-shadow:0 0 0 2px rgba(212,160,23,0.2); }
  </style>
</head>
<body class="min-h-screen text-gray-800">

<!-- ════════════ ADMIN LOGIN GATE ════════════ -->
<div id="admin-gate" class="hidden">
  <div class="parchment rounded-2xl p-8 w-full max-w-sm card-shadow relative">
    <div class="pin pin-red" style="top:-7px;left:50%;transform:translateX(-50%)"></div>
    <div class="text-center mb-6">
      <div class="flex justify-center mb-3">
        <div style="width:80px;height:100px;border-radius:50%;border:3px solid #1a1208;overflow:hidden;background:white;display:flex;align-items:center;justify-content:center;">
          <img src="/static/th-logo.png" alt="Thousand Hills" style="width:100%;height:100%;object-fit:cover;object-position:center top;" />
        </div>
      </div>
      <div class="font-display text-bounty-dark text-2xl font-black">Admin Access</div>
      <p class="text-gray-500 text-sm mt-1">Enter the admin password to continue</p>
    </div>
    <div id="gate-error" class="hidden mb-3 text-center text-bounty-red text-sm font-semibold bg-red-50 rounded px-3 py-2">
      Incorrect password. Try again.
    </div>
    <input type="password" id="gate-pw" placeholder="Admin password"
      class="th-input mb-3" onkeydown="if(event.key==='Enter')doLogin()" />
    <button onclick="doLogin()"
      class="w-full py-2.5 bg-bounty-dark text-white font-bold rounded uppercase tracking-wide hover:bg-bounty-brown transition-all text-sm">
      <i class="fas fa-lock-open mr-1.5"></i> Unlock Admin
    </button>
  </div>
</div>

<!-- ════════════ HEADER ════════════ -->
<header class="bg-bounty-dark border-b border-bounty-gold/30 sticky top-0 z-40">
  <div class="max-w-7xl mx-auto px-4">
    <div class="flex items-center justify-between py-3 gap-4">

      <!-- Logo + wordmark -->
      <div class="flex items-center gap-3 flex-shrink-0">
        <div style="width:56px;height:70px;border-radius:50%;border:2.5px solid #2a1a08;overflow:hidden;background:white;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <img src="/static/th-logo.png" alt="Thousand Hills" style="width:100%;height:100%;object-fit:cover;object-position:center top;" />
        </div>
        <div>
          <div class="font-script text-bounty-gold text-2xl leading-none">Thousand Hills</div>
          <div class="text-bounty-tan/50 text-xs tracking-widest uppercase mt-0.5">Booking Bounty Board</div>
        </div>
      </div>

      <!-- Nav tabs -->
      <nav class="flex gap-0.5">
        <button onclick="showTab('board')" id="tab-board"
          class="nav-btn nav-active px-4 py-2 text-white text-sm font-semibold">
          <i class="fas fa-clipboard-list mr-1 text-bounty-gold"></i>Board
        </button>
        <button onclick="showTab('submit')" id="tab-submit"
          class="nav-btn px-4 py-2 text-bounty-tan/60 text-sm font-semibold hover:text-white">
          <i class="fas fa-plus-circle mr-1"></i>Log Booking
        </button>
        <button onclick="showTab('leaderboard')" id="tab-leaderboard"
          class="nav-btn px-4 py-2 text-bounty-tan/60 text-sm font-semibold hover:text-white">
          <i class="fas fa-trophy mr-1"></i>Leaderboard
        </button>
        <button onclick="gotoAdmin()" id="tab-admin"
          class="nav-btn px-4 py-2 text-bounty-tan/60 text-sm font-semibold hover:text-white">
          <i class="fas fa-lock mr-1 text-xs"></i>Admin
        </button>
      </nav>
    </div>
    <div class="text-center pb-2">
      <p class="text-bounty-gold/50 text-xs tracking-widest uppercase">Fill More Nights &bull; Earn Rewards &bull; Be the Hero</p>
    </div>
  </div>
</header>

<!-- ════════════ BOARD TAB ════════════ -->
<div id="view-board" class="view">

  <!-- Hero -->
  <div class="bg-gradient-to-r from-bounty-dark via-bounty-brown/60 to-bounty-dark py-7 border-b border-bounty-gold/20">
    <div class="max-w-7xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-5">
      <div>
        <div class="font-display text-white text-4xl md:text-5xl font-black leading-none">
          WANTED: <span class="text-bounty-gold">BOOKINGS.</span>
        </div>
        <p class="text-bounty-tan/70 mt-2 text-sm">Pick a property. Book a qualifying stay. Log it here. Collect your bounty.</p>
      </div>
      <div class="flex gap-3">
        <div class="text-center bg-white/8 border border-bounty-gold/20 rounded-lg px-5 py-2.5">
          <div class="text-bounty-gold font-display text-2xl font-black" id="stat-active">3</div>
          <div class="text-bounty-tan/60 text-xs uppercase tracking-wide">Active Bounties</div>
        </div>
        <div class="text-center bg-white/8 border border-bounty-gold/20 rounded-lg px-5 py-2.5">
          <div class="text-bounty-gold font-display text-2xl font-black" id="stat-earned">--</div>
          <div class="text-bounty-tan/60 text-xs uppercase tracking-wide">Paid This Month</div>
        </div>
        <div class="text-center bg-white/8 border border-bounty-gold/20 rounded-lg px-5 py-2.5">
          <div class="text-bounty-gold font-display text-2xl font-black" id="stat-bookings">--</div>
          <div class="text-bounty-tan/60 text-xs uppercase tracking-wide">Bookings Logged</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Bonus bar (rendered dynamically from /api/bonus-rules) -->
  <div class="bg-bounty-dark border-b border-bounty-gold/25 py-2">
    <div class="max-w-7xl mx-auto px-4 flex flex-wrap gap-2 justify-center" id="bonus-pill-bar">
      <!-- populated by renderBonusPills() -->
    </div>
  </div>

  <!-- Corkboard -->
  <div class="corkboard min-h-screen p-6">
    <div class="max-w-7xl mx-auto">

      <!-- Increase alert banner (shown when any bounty was recently bumped) -->
      <div id="increase-banner" class="hidden mb-5 rounded-lg overflow-hidden border border-bounty-gold">
        <div class="bg-bounty-gold px-4 py-2 flex items-center gap-2">
          <i class="fas fa-arrow-up text-bounty-dark text-sm"></i>
          <span class="font-black text-bounty-dark text-sm uppercase tracking-wide">Bounty Increased!</span>
        </div>
        <div id="increase-banner-body" class="bg-bounty-parchment px-4 py-2 text-sm text-bounty-dark"></div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6" id="property-grid"></div>

      <!-- How It Works + Rules -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">

        <div class="parchment rounded-lg p-5 relative card-shadow" style="overflow:visible;margin-top:10px;">
          <div class="pin pin-blue"></div>
          <h3 class="font-display text-bounty-dark text-lg font-black mb-4 flex items-center gap-2">
            <i class="fas fa-flag-checkered text-bounty-gold"></i> How It Works
          </h3>
          <div class="space-y-3">
            <div class="flex gap-3 items-start">
              <div class="w-8 h-8 rounded-full bg-bounty-dark text-white flex items-center justify-center font-black text-sm flex-shrink-0">1</div>
              <div><div class="font-bold text-bounty-dark text-sm">Choose a Property</div><div class="text-gray-500 text-xs mt-0.5">Pick any active listing from the board above.</div></div>
            </div>
            <div class="flex gap-3 items-start">
              <div class="w-8 h-8 rounded-full bg-bounty-red text-white flex items-center justify-center font-black text-sm flex-shrink-0">2</div>
              <div><div class="font-bold text-bounty-dark text-sm">Book It</div><div class="text-gray-500 text-xs mt-0.5">Secure a qualifying reservation on the eligible dates.</div></div>
            </div>
            <div class="flex gap-3 items-start">
              <div class="w-8 h-8 rounded-full bg-bounty-gold text-bounty-dark flex items-center justify-center font-black text-sm flex-shrink-0">3</div>
              <div><div class="font-bold text-bounty-dark text-sm">Log It Here</div><div class="text-gray-500 text-xs mt-0.5">Submit through the "Log Booking" tab above.</div></div>
            </div>
            <div class="flex gap-3 items-start">
              <div class="w-8 h-8 rounded-full bg-bounty-green text-white flex items-center justify-center font-black text-sm flex-shrink-0">4</div>
              <div><div class="font-bold text-bounty-dark text-sm">Earn the Bounty</div><div class="text-gray-500 text-xs mt-0.5">Get paid once the stay completes and payment clears.</div></div>
            </div>
          </div>
          <div class="mt-4 text-center font-script text-bounty-brown text-xl">"Fill the calendar. Earn the reward."</div>
        </div>

        <div class="parchment rounded-lg p-5 relative card-shadow" style="overflow:visible;margin-top:10px;">
          <div class="pin pin-red"></div>
          <h3 class="font-display text-bounty-red text-lg font-black mb-4 flex items-center gap-2">
            <i class="fas fa-shield-alt text-bounty-red"></i> Important Rules
          </h3>
          <ul class="space-y-2">
            <li class="flex gap-2 items-start text-xs text-gray-700"><i class="fas fa-check text-bounty-green mt-0.5 flex-shrink-0"></i><span>Bounties apply only to properties and dates listed on the active board.</span></li>
            <li class="flex gap-2 items-start text-xs text-gray-700"><i class="fas fa-check text-bounty-green mt-0.5 flex-shrink-0"></i><span>Reservations must be booked at approved rates. Discounts over 15% need prior approval.</span></li>
            <li class="flex gap-2 items-start text-xs text-gray-700"><i class="fas fa-check text-bounty-green mt-0.5 flex-shrink-0"></i><span>Bounties paid after the guest stay completes and payment fully clears.</span></li>
            <li class="flex gap-2 items-start text-xs text-gray-700"><i class="fas fa-times text-bounty-red mt-0.5 flex-shrink-0"></i><span>Cancellations, owner stays, comps, OTAs, heavily discounted or moved reservations do not qualify.</span></li>
            <li class="flex gap-2 items-start text-xs text-gray-700"><i class="fas fa-check text-bounty-green mt-0.5 flex-shrink-0"></i><span>Bounties begin when the property is officially posted on the board.</span></li>
            <li class="flex gap-2 items-start text-xs text-gray-700"><i class="fas fa-check text-bounty-green mt-0.5 flex-shrink-0"></i><span>Per-reservation caps apply. See each property card for the cap amount.</span></li>
          </ul>
          <div class="mt-4 text-center text-xs text-gray-400 italic">More Bookings &bull; Happier Owners &bull; Better Together</div>
        </div>

      </div>
    </div>
  </div>
</div>

<!-- ════════════ LOG BOOKING TAB ════════════ -->
<div id="view-submit" class="view hidden bg-bounty-tan min-h-screen p-6">
  <div class="max-w-2xl mx-auto">
    <div class="parchment rounded-xl p-8 card-shadow relative">
      <div class="pin pin-gold"></div>
      <div class="text-center mb-6">
        <div class="font-display text-bounty-dark text-3xl font-black">Log a Booking</div>
        <p class="text-gray-500 text-sm mt-1">Submit a qualifying reservation to earn your bounty</p>
      </div>
      <form id="booking-form" class="space-y-4" onsubmit="submitBooking(event)">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Your Name *</label>
            <input type="text" id="f-agent" required placeholder="Agent name" class="th-input" />
          </div>
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Guest Name *</label>
            <input type="text" id="f-guest" required placeholder="Guest name" class="th-input" />
          </div>
        </div>
        <div>
          <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Property *</label>
          <select id="f-property" required class="th-input">
            <option value="">-- Select a property --</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Check-In *</label>
            <input type="date" id="f-checkin" required class="th-input" />
          </div>
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Check-Out *</label>
            <input type="date" id="f-checkout" required class="th-input" />
          </div>
        </div>
        <div>
          <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Nightly Rate (USD) *</label>
          <input type="number" id="f-rate" required min="0" placeholder="e.g. 249" class="th-input" />
        </div>
        <div class="bg-bounty-tan/60 rounded-lg p-4 border border-bounty-brown/20">
          <p class="text-xs font-bold text-bounty-dark mb-3 uppercase tracking-wide">Bonus Qualifiers</p>
          <div class="space-y-2">
            <label class="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" id="f-lastminute" class="accent-red-700 w-4 h-4" />
              <span><strong>Last Minute Hero</strong> – within 14 days of arrival</span>
              <span class="ml-auto text-bounty-red font-bold text-xs">+$25</span>
            </label>
            <label class="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" id="f-weekend" class="accent-yellow-600 w-4 h-4" />
              <span><strong>Weekend Warrior</strong> – includes Fri or Sat night</span>
              <span class="ml-auto text-bounty-red font-bold text-xs">+$15</span>
            </label>
            <label class="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" id="f-longstay" class="accent-green-700 w-4 h-4" />
              <span><strong>Long Stay Legend</strong> – 5+ nights</span>
              <span class="ml-auto text-bounty-red font-bold text-xs">+$15</span>
            </label>
          </div>
        </div>
        <div id="bounty-preview" class="hidden bounty-panel text-white rounded-lg p-4">
          <div class="font-display text-bounty-gold text-base font-black mb-2 uppercase tracking-wide">Bounty Estimate</div>
          <div class="space-y-1 text-sm">
            <div class="flex justify-between"><span class="text-white/60">Base (nights x per-night)</span><span id="est-base" class="font-bold">--</span></div>
            <div class="flex justify-between"><span class="text-white/60">Bonus Opportunities</span><span id="est-bonus" class="font-bold text-bounty-gold">--</span></div>
            <div class="border-t border-white/20 mt-2 pt-2 flex justify-between text-lg"><span class="font-bold">Estimated Total</span><span id="est-total" class="font-black text-bounty-gold">--</span></div>
            <div class="text-xs text-white/30 mt-1">Subject to property cap and admin review.</div>
          </div>
        </div>
        <div class="flex gap-3">
          <button type="button" onclick="calcPreview()"
            class="flex-1 py-2 border-2 border-bounty-gold text-bounty-dark font-bold rounded text-sm hover:bg-bounty-gold/20 transition-all">
            <i class="fas fa-calculator mr-1"></i> Estimate
          </button>
          <button type="submit"
            class="flex-2 py-2.5 bg-bounty-red text-white font-black rounded text-sm uppercase tracking-wide hover:bg-red-800 transition-all" style="flex:2">
            <i class="fas fa-paper-plane mr-1"></i> Submit Booking
          </button>
        </div>
      </form>
      <div id="submit-success" class="hidden text-center py-8">
        <div class="text-5xl mb-3">🎯</div>
        <div class="font-display text-2xl font-black text-bounty-dark">Bounty Logged!</div>
        <p class="text-gray-500 text-sm mt-2 max-w-sm mx-auto" id="success-msg"></p>
        <button onclick="resetForm()" class="mt-4 px-6 py-2 bg-bounty-dark text-white rounded font-bold text-sm">Log Another</button>
      </div>
    </div>
  </div>
</div>

<!-- ════════════ LEADERBOARD TAB ════════════ -->
<div id="view-leaderboard" class="view hidden bg-bounty-tan min-h-screen p-6">
  <div class="max-w-3xl mx-auto">
    <div class="parchment rounded-xl p-8 card-shadow relative">
      <div class="pin pin-gold"></div>
      <div class="text-center mb-6">
        <i class="fas fa-trophy text-bounty-gold text-4xl mb-2 block"></i>
        <div class="font-display text-bounty-dark text-3xl font-black">Top Bounty Earners</div>
        <p class="text-gray-500 text-sm">Current Month Rankings</p>
      </div>
      <div id="leaderboard-list" class="space-y-3 mb-8"></div>
      <div class="border-t border-bounty-brown/20 pt-6">
        <h4 class="font-display text-bounty-dark text-base font-black mb-3 flex items-center gap-2">
          <i class="fas fa-history text-bounty-red text-sm"></i> Recent Bookings
        </h4>
        <div id="bookings-list" class="space-y-2">
          <p class="text-gray-400 text-center text-sm py-3">No bookings logged yet.</p>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ════════════ ADMIN TAB ════════════ -->
<div id="view-admin" class="view hidden bg-bounty-tan min-h-screen p-6">
  <div class="max-w-5xl mx-auto space-y-6">

    <!-- Admin header bar -->
    <div class="flex items-center justify-between bg-bounty-dark rounded-lg px-5 py-3">
      <div class="flex items-center gap-2 text-bounty-gold font-bold">
        <i class="fas fa-shield-alt"></i> Admin Panel
      </div>
      <button onclick="doLogout()"
        class="text-xs text-bounty-tan/60 hover:text-bounty-tan border border-bounty-tan/20 rounded px-3 py-1 transition-all">
        <i class="fas fa-sign-out-alt mr-1"></i> Log Out
      </button>
    </div>

    <!-- Post New Property -->
    <div class="parchment rounded-xl overflow-hidden card-shadow">
      <div class="bg-bounty-dark px-5 py-3 flex items-center gap-2">
        <i class="fas fa-plus-square text-bounty-gold"></i>
        <span class="font-display text-white text-base font-bold">Post a New Property</span>
      </div>
      <div class="p-5">
        <form id="admin-form" class="grid grid-cols-1 md:grid-cols-2 gap-4" onsubmit="addProperty(event)">
          <div><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Property Name *</label>
            <input type="text" id="a-name" required placeholder="e.g. Sunset Chalet" class="th-input" /></div>
          <div><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Priority Level *</label>
            <select id="a-priority" required class="th-input">
              <option value="top-bounty">Top Bounty</option>
              <option value="high-priority">High Priority</option>
              <option value="gap-killer">Gap Killer</option>
              <option value="standard">Standard</option>
            </select></div>
          <div class="md:col-span-2"><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Why It's on the Board *</label>
            <input type="text" id="a-why" required placeholder="e.g. Too many open dates in June" class="th-input" /></div>
          <div><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Eligible Dates *</label>
            <input type="text" id="a-dates" required placeholder="e.g. June 1 – July 15" class="th-input" /></div>
          <div><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Min Stay (nights) *</label>
            <input type="number" id="a-minstay" required min="1" value="2" class="th-input" /></div>
          <div><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Bounty Per Night ($) *</label>
            <input type="number" id="a-pernite" required min="1" value="3" class="th-input" /></div>
          <div><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Cap Per Reservation ($) *</label>
            <input type="number" id="a-cap" required min="1" value="35" class="th-input" /></div>
          <div><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Bonus Amount ($)</label>
            <input type="number" id="a-bonus" min="0" value="15" class="th-input" /></div>
          <div><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Bonus Condition</label>
            <input type="text" id="a-boncond" placeholder="e.g. Fill a full calendar gap" class="th-input" /></div>
          <div class="md:col-span-2"><label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Property Photo URL</label>
            <input type="url" id="a-photo" placeholder="https://..." class="th-input" /></div>
          <div class="md:col-span-2">
            <button type="submit" class="px-6 py-2.5 bg-bounty-red text-white font-black rounded uppercase tracking-wide hover:bg-red-800 transition-all text-sm">
              <i class="fas fa-thumbtack mr-1"></i> Post to Board
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Manage Properties (with inline edit) -->
    <div class="parchment rounded-xl overflow-hidden card-shadow">
      <div class="bg-bounty-dark px-5 py-3 flex items-center gap-2">
        <i class="fas fa-tasks text-bounty-gold"></i>
        <span class="font-display text-white text-base font-bold">Manage Properties</span>
        <span class="ml-auto text-bounty-tan/40 text-xs">Click any value to edit inline</span>
      </div>
      <div class="p-4">
        <div id="admin-prop-list" class="space-y-3"></div>
      </div>
    </div>

    <!-- Bonus Rules Editor -->
    <div class="parchment rounded-xl overflow-hidden card-shadow" id="bonus-rules-panel">
      <div class="bg-bounty-dark px-5 py-3 flex items-center gap-2">
        <i class="fas fa-star text-bounty-gold"></i>
        <span class="font-display text-white text-base font-bold">Bonus Rules</span>
        <span class="ml-auto text-bounty-tan/40 text-xs">Changes apply instantly to bar + booking calculator</span>
      </div>
      <div class="p-5">
        <div id="bonus-rules-form" class="space-y-4"></div>
        <div class="mt-4 flex items-center gap-3">
          <button onclick="saveBonusRules()" class="px-5 py-2 bg-bounty-red text-white font-black rounded uppercase tracking-wide hover:bg-red-800 transition-all text-sm">
            <i class="fas fa-save mr-1"></i> Save Bonus Rules
          </button>
          <span id="bonus-save-msg" class="text-xs text-bounty-green font-semibold hidden"><i class="fas fa-check-circle mr-1"></i>Saved!</span>
        </div>
      </div>
    </div>

    <!-- Changelog -->
    <div class="parchment rounded-xl overflow-hidden card-shadow">
      <div class="bg-bounty-dark px-5 py-3 flex items-center gap-2">
        <i class="fas fa-history text-bounty-gold"></i>
        <span class="font-display text-white text-base font-bold">Change History</span>
        <span class="ml-2 text-bounty-tan/40 text-xs">All edits tracked here</span>
      </div>
      <div class="p-4">
        <div id="admin-changelog" class="space-y-2">
          <p class="text-gray-400 text-sm text-center py-4">No changes logged yet.</p>
        </div>
      </div>
    </div>

    <!-- Review Bookings -->
    <div class="parchment rounded-xl overflow-hidden card-shadow">
      <div class="bg-bounty-dark px-5 py-3 flex items-center gap-2">
        <i class="fas fa-clipboard-check text-bounty-gold"></i>
        <span class="font-display text-white text-base font-bold">Review Bookings</span>
      </div>
      <div class="p-4">
        <div id="admin-booking-list" class="space-y-3">
          <p class="text-gray-400 text-sm text-center py-4">No bookings submitted yet.</p>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- ════════════ FOOTER ════════════ -->
<footer class="bg-bounty-dark border-t border-bounty-gold/20 py-4 text-center">
  <div class="font-script text-bounty-gold text-xl mb-0.5">Thousand Hills</div>
  <p class="text-bounty-tan/30 text-xs tracking-widest uppercase">More Bookings &bull; Happier Owners &bull; Better Together</p>
</footer>

<script>
// ════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════
let allProperties  = [];
let allBookings    = [];
let allLeaderboard = [];
let allChangelog   = [];
let allBonusRules  = { lastMinute:{amount:25,label:'LAST MINUTE HERO',description:'within 14 days',icon:'bolt'}, weekend:{amount:15,label:'WEEKEND WARRIOR',description:'Fri or Sat night',icon:'calendar-week'}, longStay:{amount:15,label:'LONG STAY LEGEND',description:'5+ nights',icon:'moon'} };
let adminToken     = sessionStorage.getItem('adminToken') || null;

// ════════════════════════════════════════════════════════════
//  ADMIN AUTH
// ════════════════════════════════════════════════════════════
async function doLogin() {
  const pw = document.getElementById('gate-pw').value;
  const res = await fetch('/api/auth/login', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({password: pw}),
  });
  if (!res.ok) {
    document.getElementById('gate-error').classList.remove('hidden');
    document.getElementById('gate-pw').value = '';
    return;
  }
  const { token } = await res.json();
  adminToken = token;
  sessionStorage.setItem('adminToken', token);
  document.getElementById('admin-gate').classList.add('hidden');
  document.getElementById('gate-error').classList.add('hidden');
  renderAdmin();
}

async function doLogout() {
  if (adminToken) {
    await fetch('/api/auth/logout', {
      method:'POST', headers:{'x-admin-token': adminToken}
    });
  }
  adminToken = null;
  sessionStorage.removeItem('adminToken');
  showTab('board');
  document.getElementById('tab-admin').classList.remove('nav-active');
}

function gotoAdmin() {
  if (!adminToken) {
    document.getElementById('admin-gate').classList.remove('hidden');
    // highlight the tab anyway so user knows where they're headed
    return;
  }
  showTab('admin');
}

// ════════════════════════════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════════════════════════════
function showTab(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.remove('nav-active');
    b.classList.remove('text-white');
    b.classList.add('text-bounty-tan/60');
  });
  document.getElementById('view-' + name).classList.remove('hidden');
  const btn = document.getElementById('tab-' + name);
  if (btn) {
    btn.classList.add('nav-active','text-white');
    btn.classList.remove('text-bounty-tan/60');
  }
  if (name === 'board')       renderBoard();
  if (name === 'leaderboard') renderLeaderboard();
  if (name === 'admin')       renderAdmin();
}

// ════════════════════════════════════════════════════════════
//  FETCH HELPERS
// ════════════════════════════════════════════════════════════
async function fetchProperties() {
  const r = await fetch('/api/properties'); allProperties = await r.json();
}
async function fetchBookings() {
  const r = await fetch('/api/bookings'); allBookings = await r.json();
}
async function fetchLeaderboard() {
  const r = await fetch('/api/leaderboard'); allLeaderboard = await r.json();
}
async function fetchChangelog() {
  const r = await fetch('/api/changelog'); allChangelog = await r.json();
}
async function fetchBonusRules() {
  const r = await fetch('/api/bonus-rules'); allBonusRules = await r.json();
}

function renderBonusPills() {
  const bar = document.getElementById('bonus-pill-bar');
  if (!bar) return;
  const rules = [
    ['lastMinute', allBonusRules.lastMinute],
    ['weekend',    allBonusRules.weekend],
    ['longStay',   allBonusRules.longStay],
  ];
  bar.innerHTML = rules.map(([,r]) => \`
    <div class="flex items-center gap-2 bg-bounty-gold/15 border border-bounty-gold/25 rounded-full px-4 py-1">
      <i class="fas fa-\${r.icon} text-bounty-gold text-xs"></i>
      <span class="text-bounty-tan text-xs font-semibold">\${r.label}</span>
      <span class="text-bounty-gold font-black text-sm">+$\${r.amount}</span>
      <span class="text-bounty-tan/50 text-xs hidden sm:inline">\${r.description}</span>
    </div>\`).join('');
}

function renderBonusRulesForm() {
  const wrap = document.getElementById('bonus-rules-form');
  if (!wrap) return;
  const keys = [
    { key:'lastMinute', title:'Last Minute Hero' },
    { key:'weekend',    title:'Weekend Warrior'  },
    { key:'longStay',   title:'Long Stay Legend' },
  ];
  wrap.innerHTML = keys.map(({key,title}) => {
    const r = allBonusRules[key];
    return \`
    <div class="border border-bounty-gold/20 rounded-lg p-4 bg-white/40">
      <div class="font-bold text-bounty-dark text-sm mb-3 flex items-center gap-2">
        <i class="fas fa-\${r.icon} text-bounty-gold"></i> \${title}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Bonus Amount ($)</label>
          <input type="number" id="br-\${key}-amount" value="\${r.amount}" min="0" class="th-input" />
        </div>
        <div>
          <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Label</label>
          <input type="text" id="br-\${key}-label" value="\${r.label}" class="th-input" />
        </div>
        <div>
          <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Description</label>
          <input type="text" id="br-\${key}-description" value="\${r.description}" class="th-input" />
        </div>
      </div>
    </div>\`;
  }).join('');
}

async function saveBonusRules() {
  const payload = {
    lastMinute: {
      amount:      parseFloat(document.getElementById('br-lastMinute-amount').value) || 0,
      label:       document.getElementById('br-lastMinute-label').value.trim(),
      description: document.getElementById('br-lastMinute-description').value.trim(),
    },
    weekend: {
      amount:      parseFloat(document.getElementById('br-weekend-amount').value) || 0,
      label:       document.getElementById('br-weekend-label').value.trim(),
      description: document.getElementById('br-weekend-description').value.trim(),
    },
    longStay: {
      amount:      parseFloat(document.getElementById('br-longStay-amount').value) || 0,
      label:       document.getElementById('br-longStay-label').value.trim(),
      description: document.getElementById('br-longStay-description').value.trim(),
    },
  };
  const res = await fetch('/api/bonus-rules', {
    method:'PATCH',
    headers:{'Content-Type':'application/json','x-admin-token': adminToken||''},
    body: JSON.stringify(payload),
  });
  if (!res.ok) { alert('Save failed -- are you still logged in?'); return; }
  allBonusRules = await res.json();
  renderBonusPills();
  const msg = document.getElementById('bonus-save-msg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 3000);
}

// ════════════════════════════════════════════════════════════
//  PRIORITY META
// ════════════════════════════════════════════════════════════
const PRIORITY = {
  'top-bounty':   { badge:'TOP BOUNTY',    ribbonCls:'ribbon-top',  badgeCls:'badge-top',  pin:'pin-red'   },
  'high-priority':{ badge:'HIGH PRIORITY', ribbonCls:'ribbon-high', badgeCls:'badge-high', pin:'pin-gold'  },
  'gap-killer':   { badge:'GAP KILLER',    ribbonCls:'ribbon-gap',  badgeCls:'badge-gap',  pin:'pin-blue'  },
  'standard':     { badge:'AVAILABLE',     ribbonCls:'ribbon-std',  badgeCls:'badge-std',  pin:'pin-green' },
};

// ════════════════════════════════════════════════════════════
//  BOARD RENDER
// ════════════════════════════════════════════════════════════
function renderBoard() {
  const grid    = document.getElementById('property-grid');
  const banner  = document.getElementById('increase-banner');
  const bannerB = document.getElementById('increase-banner-body');
  const active  = allProperties.filter(p => p.status === 'active');
  document.getElementById('stat-active').textContent = active.length;
  // Live stats from real booking data
  const now = new Date();
  const monthBookings = allBookings.filter(b => { const d = new Date(b.submittedAt); return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth(); });
  const monthPaid = monthBookings.filter(b => b.status==='cleared').reduce((s,b) => s + b.totalEarned, 0);
  document.getElementById('stat-earned').textContent  = '$' + monthBookings.reduce((s,b) => s + b.totalEarned, 0);
  document.getElementById('stat-bookings').textContent = allBookings.length;

  // ── Bounty increase banner ──
  const increased = active.filter(p => p.bountyIncreasedAt);
  if (increased.length > 0) {
    banner.classList.remove('hidden');
    bannerB.innerHTML = increased.map(p =>
      \`<span class="increase-pill mr-2"><i class="fas fa-arrow-up"></i> \${p.name}: now $\${p.bountyPerNight}/night</span>\`
    ).join('') + '<span class="text-gray-500 text-xs ml-1">– bounty recently increased! Now is the time to book.</span>';
  } else {
    banner.classList.add('hidden');
  }

  if (active.length === 0) {
    grid.innerHTML = '<p class="col-span-3 text-center text-bounty-brown py-12 text-base font-display italic">No active bounties posted. Check back soon!</p>';
    return;
  }

  const tilts = ['tilt-l','tilt-r','tilt-n'];
  grid.innerHTML = active.map((p, i) => {
    const pr = PRIORITY[p.priority] || PRIORITY['standard'];
    const wasIncreased = !!p.bountyIncreasedAt;
    const tilt = tilts[i % tilts.length];
    const increaseNote = wasIncreased
      ? \`<div class="flex items-center gap-1.5 mb-2">
           <span class="increase-pill"><i class="fas fa-arrow-up"></i> Bounty Increased!</span>
           \${p.previousBounty ? \`<span class="text-xs text-gray-500">was $\${p.previousBounty}/night</span>\` : ''}
         </div>\`
      : '';
    return \`
    <div class="parchment rounded-lg card-shadow relative mt-2 \${tilt} hover:rotate-0 hover:scale-[1.02] transition-transform duration-200 \${wasIncreased ? 'bounty-increased' : ''}" style="overflow:visible;">
      <div class="\${pr.pin} pin"></div>
      <div class="\${pr.ribbonCls} text-xs font-black px-4 py-1.5 text-center tracking-widest">\${pr.badge}</div>
      \${p.photo ? \`<img src="\${p.photo}" alt="\${p.name}" class="w-full h-44 object-cover" onerror="this.style.display='none'" />\` : ''}
      <div class="p-4">
        \${increaseNote}
        <div class="font-display text-bounty-dark text-xl font-black leading-tight mb-3">\${p.name}</div>
        <div class="space-y-1.5 text-xs text-gray-600 mb-4">
          <div class="flex gap-2 items-start"><i class="fas fa-info-circle text-bounty-red w-3 mt-0.5 flex-shrink-0"></i><span>\${p.why}</span></div>
          <div class="flex gap-2 items-center"><i class="fas fa-calendar-alt text-bounty-green w-3 flex-shrink-0"></i><span>\${p.eligibleDates}</span></div>
          <div class="flex gap-2 items-center"><i class="fas fa-moon text-bounty-blue w-3 flex-shrink-0"></i><span>Min Stay: \${p.minStay} nights</span></div>
        </div>
        <div class="bounty-panel text-white rounded-lg p-3 mb-3">
          <div class="text-white/50 text-xs uppercase tracking-wide mb-1">Bounty</div>
          <div class="flex items-baseline gap-1.5">
            <span class="font-display text-3xl font-black text-bounty-gold">$\${p.bountyPerNight}</span>
            <span class="text-xs text-white/60">per paid night</span>
          </div>
          \${p.bonusAmount > 0 ? \`
          <div class="bonus-chip mt-2 rounded px-2.5 py-1.5 flex items-center justify-between text-xs">
            <span class="font-bold">+ $\${p.bonusAmount} BONUS</span>
            <span class="opacity-80">\${p.bonusCondition}</span>
          </div>\` : ''}
          <div class="text-right text-xs text-white/30 mt-1.5">Cap: $\${p.cap} per reservation</div>
        </div>
        <button onclick="showTab('submit')" class="w-full py-2 bg-bounty-red text-white font-black text-xs rounded uppercase tracking-wide hover:bg-red-800 transition-all">
          <i class="fas fa-crosshairs mr-1"></i> Claim This Bounty
        </button>
      </div>
    </div>\`;
  }).join('');
}

// ════════════════════════════════════════════════════════════
//  LEADERBOARD RENDER
// ════════════════════════════════════════════════════════════
function renderLeaderboard() {
  const podium = ['border-l-4 border-bounty-gold', 'border-l-4 border-gray-400', 'border-l-4 border-yellow-700'];
  const medals = ['🥇','🥈','🥉'];
  const list   = document.getElementById('leaderboard-list');

  list.innerHTML = allLeaderboard.length === 0
    ? '<p class="text-center text-gray-400 text-sm py-6">No earners yet. Be first!</p>'
    : allLeaderboard.map((l, i) => \`
    <div class="flex items-center gap-4 bg-white/50 rounded-lg px-4 py-3 border border-bounty-brown/10 \${podium[i]||''}">
      <span class="text-2xl w-8 text-center">\${medals[i]||'#'+(i+1)}</span>
      <div class="flex-1">
        <div class="font-bold text-bounty-dark">\${l.name}</div>
        <div class="text-xs text-gray-500">\${l.bookings} booking\${l.bookings!==1?'s':''} logged</div>
      </div>
      <div class="text-right">
        <div class="font-display text-xl font-black text-bounty-red">$\${l.total}</div>
        <div class="text-xs text-gray-400">earned</div>
      </div>
    </div>\`).join('');

  const bList = document.getElementById('bookings-list');
  bList.innerHTML = allBookings.length === 0
    ? '<p class="text-gray-400 text-center text-sm py-3">No bookings logged yet.</p>'
    : allBookings.slice().reverse().map(b => {
        const prop    = allProperties.find(p => p.id === b.propertyId);
        const stCls   = {pending:'s-pending',cleared:'s-cleared',disqualified:'s-disq'}[b.status]||'';
        return \`<div class="flex items-center justify-between bg-white/50 rounded px-3 py-2.5 border border-bounty-brown/10">
          <div>
            <span class="font-bold text-bounty-dark text-xs">\${b.agentName}</span>
            <span class="text-gray-400 text-xs"> &rarr; \${prop?prop.name:b.propertyId}</span>
            <div class="text-xs text-gray-500">\${b.nights} nights | Check-in: \${b.checkIn}</div>
          </div>
          <div class="text-right">
            <div class="font-black text-bounty-red text-sm">$\${b.totalEarned}</div>
            <span class="text-xs px-2 py-0.5 rounded-full \${stCls}">\${b.status}</span>
          </div>
        </div>\`;
      }).join('');
}

// ════════════════════════════════════════════════════════════
//  ADMIN RENDER
// ════════════════════════════════════════════════════════════
function renderAdmin() {
  renderAdminProps();
  renderBonusRulesForm();
  renderAdminChangelog();
  renderAdminBookings();
}

function renderAdminProps() {
  const list = document.getElementById('admin-prop-list');
  if (allProperties.length === 0) {
    list.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">No properties posted yet.</p>';
    return;
  }
  list.innerHTML = allProperties.map(p => {
    const pr    = PRIORITY[p.priority] || PRIORITY['standard'];
    const stCls = {active:'s-active',filled:'s-filled',expired:'s-expired'}[p.status]||'';
    return \`
    <div class="bg-white rounded-lg border border-bounty-brown/15 shadow-sm overflow-hidden" id="proprow-\${p.id}">
      <!-- Summary row -->
      <div class="flex flex-wrap items-center gap-3 px-4 py-3">
        <span class="\${pr.badgeCls} text-xs font-bold px-2 py-0.5 rounded">\${pr.badge}</span>
        <div class="flex-1 min-w-0">
          <div class="font-bold text-bounty-dark text-sm truncate">\${p.name}</div>
          <div class="text-xs text-gray-500">\${p.eligibleDates}</div>
        </div>
        <div class="flex items-center gap-1.5 text-xs text-gray-600">
          <span class="font-semibold">$\${p.bountyPerNight}/night</span>
          <span class="text-gray-300">|</span>
          <span>Cap $\${p.cap}</span>
          \${p.bonusAmount > 0 ? \`<span class="text-gray-300">|</span><span>Bonus +$\${p.bonusAmount}</span>\` : ''}
        </div>
        <span class="text-xs px-2 py-0.5 rounded-full \${stCls}">\${p.status}</span>
        <button onclick="toggleEditRow('\${p.id}')"
          class="text-xs border border-bounty-gold/40 text-bounty-brown hover:bg-bounty-gold/10 px-2.5 py-1 rounded transition-all">
          <i class="fas fa-edit mr-1"></i>Edit
        </button>
        <select onchange="updatePropStatus('\${p.id}', this.value)"
          class="text-xs border border-gray-200 rounded px-2 py-1 bg-white">
          <option value="active"  \${p.status==='active' ?'selected':''}>Active</option>
          <option value="filled"  \${p.status==='filled' ?'selected':''}>Filled</option>
          <option value="expired" \${p.status==='expired'?'selected':''}>Expired</option>
        </select>
        <button onclick="deleteProp('\${p.id}')"
          class="text-xs bg-red-50 text-bounty-red hover:bg-red-100 border border-red-100 px-2 py-1 rounded transition-all">
          <i class="fas fa-trash"></i>
        </button>
      </div>

      <!-- Inline edit panel (hidden by default) -->
      <div class="edit-panel hidden bg-bounty-parchment border-t border-bounty-gold/20 px-4 py-4" id="editpanel-\${p.id}">
        <div class="text-xs font-bold text-bounty-dark uppercase tracking-wide mb-3">
          <i class="fas fa-pencil-alt text-bounty-gold mr-1"></i> Edit: \${p.name}
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Bounty/Night ($)</label>
            <input type="number" id="e-\${p.id}-bountyPerNight" value="\${p.bountyPerNight}" min="1" class="edit-input w-full" />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Cap ($)</label>
            <input type="number" id="e-\${p.id}-cap" value="\${p.cap}" min="1" class="edit-input w-full" />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Bonus Amount ($)</label>
            <input type="number" id="e-\${p.id}-bonusAmount" value="\${p.bonusAmount}" min="0" class="edit-input w-full" />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Min Stay (nights)</label>
            <input type="number" id="e-\${p.id}-minStay" value="\${p.minStay}" min="1" class="edit-input w-full" />
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Eligible Dates</label>
            <input type="text" id="e-\${p.id}-eligibleDates" value="\${p.eligibleDates}" class="edit-input w-full" style="width:100%" />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Bonus Condition</label>
            <input type="text" id="e-\${p.id}-bonusCondition" value="\${p.bonusCondition}" class="edit-input w-full" style="width:100%" />
          </div>
        </div>
        <div class="mb-3">
          <label class="block text-xs text-gray-500 mb-1">Why It's on the Board</label>
          <input type="text" id="e-\${p.id}-why" value="\${p.why}" class="edit-input" style="width:100%" />
        </div>
        <div class="flex gap-2">
          <button onclick="savePropertyEdit('\${p.id}')"
            class="px-4 py-1.5 bg-bounty-red text-white font-bold rounded text-xs uppercase hover:bg-red-800 transition-all">
            <i class="fas fa-save mr-1"></i> Save Changes
          </button>
          <button onclick="toggleEditRow('\${p.id}')"
            class="px-4 py-1.5 border border-gray-300 text-gray-600 font-bold rounded text-xs hover:bg-gray-100 transition-all">
            Cancel
          </button>
        </div>
      </div>
    </div>\`;
  }).join('');
}

function toggleEditRow(id) {
  const panel = document.getElementById('editpanel-' + id);
  if (panel) panel.classList.toggle('hidden');
}

async function savePropertyEdit(id) {
  const fields = ['bountyPerNight','cap','bonusAmount','minStay','eligibleDates','bonusCondition','why'];
  const updates = {};
  fields.forEach(f => {
    const el = document.getElementById(\`e-\${id}-\${f}\`);
    if (!el) return;
    updates[f] = el.type === 'number' ? parseFloat(el.value) : el.value;
  });
  const res = await fetch(\`/api/properties/\${id}\`, {
    method:'PATCH',
    headers:{'Content-Type':'application/json','x-admin-token': adminToken||''},
    body: JSON.stringify(updates),
  });
  if (res.status === 401) { alert('Session expired. Please log in again.'); doLogout(); return; }
  if (!res.ok) { alert('Save failed.'); return; }
  await fetchProperties();
  await fetchChangelog();
  renderAdmin();
  // Refresh board so increase highlight appears immediately
  renderBoard();
}

function renderAdminChangelog() {
  const el = document.getElementById('admin-changelog');
  if (allChangelog.length === 0) {
    el.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">No changes logged yet.</p>';
    return;
  }
  const fieldLabels = {
    bountyPerNight:'Bounty/Night', cap:'Cap', bonusAmount:'Bonus Amount',
    minStay:'Min Stay', eligibleDates:'Eligible Dates',
    bonusCondition:'Bonus Condition', why:'Why on Board', status:'Status',
  };
  el.innerHTML = allChangelog.map(cl => {
    const rowCls = cl.isIncrease ? 'cl-increase' : 'cl-neutral';
    const label  = fieldLabels[cl.field] || cl.field;
    const dt     = new Date(cl.changedAt).toLocaleString();
    return \`
    <div class="\${rowCls} rounded px-3 py-2 text-xs flex items-start gap-3">
      <div class="flex-1">
        <span class="font-bold text-bounty-dark">\${cl.propertyName}</span>
        <span class="text-gray-500 mx-1">&mdash;</span>
        <span class="text-gray-600">\${label}:</span>
        <span class="line-through text-gray-400 mx-1">\${cl.oldValue}</span>
        <i class="fas fa-arrow-right text-gray-400 text-xs mx-1"></i>
        <span class="font-bold \${cl.isIncrease ? 'text-bounty-gold' : 'text-bounty-dark'}">\${cl.newValue}</span>
        \${cl.isIncrease ? '<span class="increase-pill ml-2"><i class="fas fa-arrow-up"></i> Increase</span>' : ''}
      </div>
      <div class="text-gray-400 flex-shrink-0 whitespace-nowrap">\${dt}</div>
    </div>\`;
  }).join('');
}

function renderAdminBookings() {
  const list = document.getElementById('admin-booking-list');
  if (allBookings.length === 0) {
    list.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">No bookings submitted yet.</p>';
    return;
  }
  list.innerHTML = allBookings.slice().reverse().map(b => {
    const prop  = allProperties.find(p => p.id === b.propertyId);
    const stCls = {pending:'s-pending',cleared:'s-cleared',disqualified:'s-disq'}[b.status]||'';
    return \`
    <div class="flex flex-wrap items-start justify-between gap-2 bg-white rounded-lg px-4 py-3 border border-bounty-brown/10">
      <div>
        <div class="font-bold text-bounty-dark text-sm">\${b.agentName} &rarr; \${prop?prop.name:b.propertyId}</div>
        <div class="text-xs text-gray-500">Guest: \${b.guestName} | \${b.checkIn} &ndash; \${b.checkOut} | \${b.nights} nights | $\${b.rate}/night</div>
        <div class="text-xs text-gray-500 mt-0.5">
          Base: $\${b.baseBounty} + Bonuses: $\${b.bonusEarned} = <strong>$\${b.totalEarned}</strong>
          \${b.isLastMinute?'<span class="ml-1 bg-red-50 text-bounty-red border border-red-100 px-1.5 rounded text-xs">Last Min</span>':''}
          \${b.isWeekend?'<span class="ml-1 bg-yellow-50 text-yellow-700 border border-yellow-100 px-1.5 rounded text-xs">Weekend</span>':''}
          \${b.isLongStay?'<span class="ml-1 bg-green-50 text-bounty-green border border-green-100 px-1.5 rounded text-xs">Long Stay</span>':''}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs px-2 py-0.5 rounded-full \${stCls}">\${b.status}</span>
        <select onchange="updateBookingStatus('\${b.id}', this.value)"
          class="text-xs border border-gray-200 rounded px-2 py-1 bg-white">
          <option value="pending"       \${b.status==='pending'      ?'selected':''}>Pending</option>
          <option value="cleared"       \${b.status==='cleared'      ?'selected':''}>Cleared</option>
          <option value="disqualified"  \${b.status==='disqualified' ?'selected':''}>Disqualified</option>
        </select>
      </div>
    </div>\`;
  }).join('');
}

// ════════════════════════════════════════════════════════════
//  BOOKING FORM
// ════════════════════════════════════════════════════════════
function populatePropertySelect() {
  const sel    = document.getElementById('f-property');
  const active = allProperties.filter(p => p.status === 'active');
  sel.innerHTML = '<option value="">-- Select a property --</option>' +
    active.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
}

function calcPreview() {
  const propId = document.getElementById('f-property').value;
  const cin    = document.getElementById('f-checkin').value;
  const cout   = document.getElementById('f-checkout').value;
  if (!propId || !cin || !cout) { alert('Select a property and dates first.'); return; }
  const prop   = allProperties.find(p => p.id === propId);
  const nights = Math.max(0, Math.round((new Date(cout) - new Date(cin)) / 86400000));
  const base   = Math.min(nights * prop.bountyPerNight, prop.cap);
  const lm = document.getElementById('f-lastminute').checked ? allBonusRules.lastMinute.amount : 0;
  const wk = document.getElementById('f-weekend').checked   ? allBonusRules.weekend.amount    : 0;
  const ls = document.getElementById('f-longstay').checked  ? allBonusRules.longStay.amount   : 0;
  const bonus  = lm + wk + ls;
  document.getElementById('est-base').textContent  = \`$\${base}\`;
  document.getElementById('est-bonus').textContent = bonus > 0 ? \`+$\${bonus}\` : '$0';
  document.getElementById('est-total').textContent = \`$\${base + bonus}\`;
  document.getElementById('bounty-preview').classList.remove('hidden');
}

async function submitBooking(e) {
  e.preventDefault();
  const propId = document.getElementById('f-property').value;
  const cin    = document.getElementById('f-checkin').value;
  const cout   = document.getElementById('f-checkout').value;
  const nights = Math.max(0, Math.round((new Date(cout) - new Date(cin)) / 86400000));
  const prop   = allProperties.find(p => p.id === propId);
  if (nights < prop.minStay) {
    alert(\`Min stay for \${prop.name} is \${prop.minStay} nights. This booking doesn't qualify.\`);
    return;
  }
  const res = await fetch('/api/bookings', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      propertyId: propId,
      agentName:  document.getElementById('f-agent').value,
      guestName:  document.getElementById('f-guest').value,
      checkIn: cin, checkOut: cout, nights,
      rate:        parseFloat(document.getElementById('f-rate').value),
      isWeekend:   document.getElementById('f-weekend').checked,
      isLastMinute:document.getElementById('f-lastminute').checked,
      isLongStay:  document.getElementById('f-longstay').checked,
    }),
  });
  const booking = await res.json();
  await fetchBookings();
  await fetchLeaderboard();
  document.getElementById('booking-form').classList.add('hidden');
  document.getElementById('submit-success').classList.remove('hidden');
  document.getElementById('success-msg').textContent =
    \`Booking logged for \${prop.name}! Estimated bounty: $\${booking.totalEarned}. You'll be paid once the stay completes and payment clears.\`;
}

function resetForm() {
  document.getElementById('booking-form').reset();
  document.getElementById('booking-form').classList.remove('hidden');
  document.getElementById('submit-success').classList.add('hidden');
  document.getElementById('bounty-preview').classList.add('hidden');
}

// ════════════════════════════════════════════════════════════
//  ADMIN ACTIONS
// ════════════════════════════════════════════════════════════
async function addProperty(e) {
  e.preventDefault();
  const res = await fetch('/api/properties', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-admin-token': adminToken||''},
    body: JSON.stringify({
      name:           document.getElementById('a-name').value,
      priority:       document.getElementById('a-priority').value,
      why:            document.getElementById('a-why').value,
      eligibleDates:  document.getElementById('a-dates').value,
      minStay:        parseInt(document.getElementById('a-minstay').value),
      bountyPerNight: parseFloat(document.getElementById('a-pernite').value),
      cap:            parseFloat(document.getElementById('a-cap').value),
      bonusAmount:    parseFloat(document.getElementById('a-bonus').value)||0,
      bonusCondition: document.getElementById('a-boncond').value||'',
      photo:          document.getElementById('a-photo').value||'',
      status: 'active',
    }),
  });
  if (res.status === 401) { alert('Session expired.'); doLogout(); return; }
  await fetchProperties();
  document.getElementById('admin-form').reset();
  renderAdmin();
  populatePropertySelect();
}

async function updatePropStatus(id, status) {
  await fetch(\`/api/properties/\${id}/status\`, {
    method:'PATCH',
    headers:{'Content-Type':'application/json','x-admin-token': adminToken||''},
    body: JSON.stringify({status}),
  });
  await fetchProperties();
  renderAdmin();
  renderBoard();
}

async function deleteProp(id) {
  if (!confirm('Remove this property from the board?')) return;
  await fetch(\`/api/properties/\${id}\`, {
    method:'DELETE', headers:{'x-admin-token': adminToken||''}
  });
  await fetchProperties();
  renderAdmin();
  renderBoard();
  populatePropertySelect();
}

async function updateBookingStatus(id, status) {
  await fetch(\`/api/bookings/\${id}/status\`, {
    method:'PATCH',
    headers:{'Content-Type':'application/json','x-admin-token': adminToken||''},
    body: JSON.stringify({status}),
  });
  await fetchBookings();
  renderAdmin();
}

// ════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════
async function init() {
  await Promise.all([fetchProperties(), fetchBookings(), fetchLeaderboard(), fetchChangelog(), fetchBonusRules()]);
  renderBoard();
  renderBonusPills();
  populatePropertySelect();
}

init();
</script>
</body>
</html>`)
})

export default app
