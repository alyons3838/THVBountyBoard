import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

const app = new Hono()

app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './' }))

// ─── In-memory data store (KV-ready swap-out later) ───────────────────────────

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

const leaderboard: { name: string; total: number; bookings: number }[] = [
  { name: 'Sarah M.', total: 187, bookings: 6 },
  { name: 'Jake T.', total: 142, bookings: 5 },
  { name: 'Carmen R.', total: 98, bookings: 3 },
]

// ─── API Routes ────────────────────────────────────────────────────────────────

app.get('/api/properties', (c) => {
  return c.json(properties)
})

app.get('/api/properties/:id', (c) => {
  const prop = properties.find((p) => p.id === c.req.param('id'))
  if (!prop) return c.json({ error: 'Not found' }, 404)
  return c.json(prop)
})

app.post('/api/properties', async (c) => {
  const body = await c.req.json<Omit<Property, 'id' | 'postedAt'>>()
  const newProp: Property = {
    ...body,
    id: body.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(),
    postedAt: new Date().toISOString(),
  }
  properties.push(newProp)
  return c.json(newProp, 201)
})

app.patch('/api/properties/:id/status', async (c) => {
  const prop = properties.find((p) => p.id === c.req.param('id'))
  if (!prop) return c.json({ error: 'Not found' }, 404)
  const { status } = await c.req.json<{ status: Status }>()
  prop.status = status
  return c.json(prop)
})

app.delete('/api/properties/:id', (c) => {
  const idx = properties.findIndex((p) => p.id === c.req.param('id'))
  if (idx === -1) return c.json({ error: 'Not found' }, 404)
  properties.splice(idx, 1)
  return c.json({ success: true })
})

app.get('/api/bookings', (c) => {
  return c.json(bookings)
})

app.post('/api/bookings', async (c) => {
  const body = await c.req.json<Omit<Booking, 'id' | 'submittedAt' | 'baseBounty' | 'bonusEarned' | 'totalEarned' | 'status'>>()
  const prop = properties.find((p) => p.id === body.propertyId)
  if (!prop) return c.json({ error: 'Property not found' }, 404)

  // Calculate bounty
  const baseBounty = Math.min(body.nights * prop.bountyPerNight, prop.cap)
  let bonusEarned = 0
  if (body.isLastMinute) bonusEarned += 25
  if (body.isWeekend) bonusEarned += 15
  if (body.isLongStay) bonusEarned += 15

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

  // Update leaderboard
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
            script: ['Dancing Script', 'cursive'],
            body: ['Inter', 'sans-serif'],
          },
          colors: {
            th: {
              black:  '#0d0d0d',
              red:    '#C80000',
              reddk:  '#9a0000',
              gold:   '#FFD200',
              golddk: '#c9a400',
              green:  '#1A8F2A',
              greendk:'#126b1e',
              white:  '#ffffff',
              offwhite: '#f8f5ef',
              cream:  '#f0ebe0',
              slate:  '#2c2c2c',
            }
          }
        }
      }
    }
  </script>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #0d0d0d; color: #2c2c2c; }

    /* ── Brand Palette ── */
    .bg-th-header   { background: linear-gradient(180deg, #0d0d0d 0%, #1a1a1a 100%); }
    .bg-th-hero     { background: linear-gradient(135deg, #0d0d0d 0%, #1c0000 40%, #0d0d0d 100%); }
    .bg-th-fairway  { background: linear-gradient(180deg, #f8f5ef 0%, #e8e2d5 100%); }
    .bg-th-card     { background: #ffffff; }

    /* ── Typography ── */
    .font-script    { font-family: 'Dancing Script', cursive; }
    .font-display   { font-family: 'Playfair Display', serif; }

    /* ── Logo SVG embed ── */
    .th-logo-oval {
      width: 64px; height: 80px;
      border-radius: 50%;
      border: 3px solid #0d0d0d;
      overflow: hidden;
      background: white;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }

    /* ── Nav ── */
    .nav-btn { transition: all 0.2s; border-bottom: 2px solid transparent; }
    .nav-active { border-bottom: 2px solid #FFD200 !important; color: #ffffff !important; }

    /* ── Cards ── */
    .th-card {
      background: #ffffff;
      border-radius: 4px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06);
      overflow: hidden;
      position: relative;
    }
    .th-card-tilt-l { transform: rotate(-0.8deg); }
    .th-card-tilt-r { transform: rotate(0.7deg); }
    .th-card-tilt-n { transform: rotate(-0.2deg); }

    /* ── Ribbon banners ── */
    .ribbon-top  { background: linear-gradient(90deg, #C80000, #9a0000); color: white; }
    .ribbon-high { background: linear-gradient(90deg, #1A8F2A, #126b1e); color: white; }
    .ribbon-gap  { background: linear-gradient(90deg, #0d0d0d, #2c2c2c); color: #FFD200; }
    .ribbon-std  { background: linear-gradient(90deg, #2c6e9a, #1a4b6e); color: white; }

    /* ── Bounty strip (bottom of card) ── */
    .bounty-panel { background: linear-gradient(135deg, #0d0d0d 0%, #1c0000 100%); }
    .bonus-chip   { background: #C80000; color: white; border-radius: 3px; }

    /* ── Divider ornament ── */
    .ornament::before, .ornament::after {
      content: '';
      display: inline-block;
      height: 1px;
      width: 60px;
      background: currentColor;
      vertical-align: middle;
      margin: 0 10px;
      opacity: 0.4;
    }

    /* ── Stat cards ── */
    .stat-chip { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,210,0,0.25); border-radius: 6px; }

    /* ── Bonus bar ── */
    .bonus-bar { background: linear-gradient(90deg, #0d0d0d, #1c1c1c); border-bottom: 1px solid rgba(255,210,0,0.2); }
    .bonus-pill { background: rgba(255,210,0,0.12); border: 1px solid rgba(255,210,0,0.3); border-radius: 999px; }

    /* ── Fairway section (where cards live) ── */
    .fairway { background: #f0ebe0; background-image: repeating-linear-gradient(
      0deg, transparent, transparent 39px, rgba(0,0,0,0.03) 39px, rgba(0,0,0,0.03) 40px
    ); }

    /* ── Info panels ── */
    .info-panel { background: #ffffff; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; }
    .step-circle { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:14px; flex-shrink:0; }

    /* ── Badge labels (admin) ── */
    .badge-top  { background:#C80000; color:white; }
    .badge-high { background:#1A8F2A; color:white; }
    .badge-gap  { background:#0d0d0d; color:#FFD200; }
    .badge-std  { background:#2c6e9a; color:white; }

    /* ── Status pills ── */
    .status-active     { background:#d4edda; color:#155724; }
    .status-filled     { background:#cce5ff; color:#004085; }
    .status-expired    { background:#f8d7da; color:#721c24; }
    .status-pending    { background:#fff3cd; color:#856404; }
    .status-cleared    { background:#d4edda; color:#155724; }
    .status-disq       { background:#f8d7da; color:#721c24; }

    /* ── Form ── */
    .th-input { width:100%; border:1px solid #d4c9b5; border-radius:4px; padding:8px 12px; font-size:14px; background:white; outline:none; transition:border 0.2s; }
    .th-input:focus { border-color:#C80000; }
    .th-label { display:block; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#0d0d0d; margin-bottom:4px; }

    /* ── Buttons ── */
    .btn-primary { background:#C80000; color:white; font-weight:800; font-size:13px; letter-spacing:0.06em; text-transform:uppercase; padding:10px 20px; border-radius:4px; border:none; cursor:pointer; transition:background 0.2s; }
    .btn-primary:hover { background:#9a0000; }
    .btn-outline { background:transparent; color:#0d0d0d; font-weight:700; font-size:13px; letter-spacing:0.06em; text-transform:uppercase; padding:9px 20px; border-radius:4px; border:2px solid #FFD200; cursor:pointer; transition:all 0.2s; }
    .btn-outline:hover { background:#FFD200; }

    /* ── Leaderboard podium ── */
    .podium-1 { border-left: 4px solid #FFD200; }
    .podium-2 { border-left: 4px solid #a8a8a8; }
    .podium-3 { border-left: 4px solid #c87533; }

    select, input, textarea { background: white; }
  </style>
</head>
<body class="min-h-screen">

  <!-- ════════════════════ HEADER ════════════════════ -->
  <header class="bg-th-header border-b border-th-gold/20 sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4">
      <div class="flex items-center justify-between py-3 gap-4">

        <!-- Logo + Wordmark -->
        <div class="flex items-center gap-3 flex-shrink-0">
          <!-- Inline oval logo (SVG recreation of Thousand Hills badge) -->
          <div style="width:52px;height:65px;border-radius:50%;border:2.5px solid #000;background:white;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">
            <img src="https://www.genspark.ai/api/files/s/QNwq3OwQ" alt="Thousand Hills" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'" />
          </div>
          <div>
            <div class="font-script text-th-gold text-2xl leading-none" style="text-shadow:0 1px 4px rgba(0,0,0,0.6)">Thousand Hills</div>
            <div class="text-white/50 text-xs tracking-widest uppercase font-semibold mt-0.5">Booking Bounty Board</div>
          </div>
        </div>

        <!-- Nav -->
        <nav class="flex gap-0.5">
          <button onclick="showTab('board')" id="tab-board" class="nav-btn nav-active px-4 py-2 text-white text-sm font-semibold transition-all">
            <i class="fas fa-clipboard-list mr-1.5 text-th-gold"></i>Board
          </button>
          <button onclick="showTab('submit')" id="tab-submit" class="nav-btn px-4 py-2 text-white/60 text-sm font-semibold transition-all hover:text-white">
            <i class="fas fa-plus-circle mr-1.5"></i>Log Booking
          </button>
          <button onclick="showTab('leaderboard')" id="tab-leaderboard" class="nav-btn px-4 py-2 text-white/60 text-sm font-semibold transition-all hover:text-white">
            <i class="fas fa-trophy mr-1.5"></i>Leaderboard
          </button>
          <button onclick="showTab('admin')" id="tab-admin" class="nav-btn px-4 py-2 text-white/60 text-sm font-semibold transition-all hover:text-white">
            <i class="fas fa-cog mr-1.5"></i>Admin
          </button>
        </nav>
      </div>
    </div>
  </header>

  <!-- ════════════════════ BOARD TAB ════════════════════ -->
  <div id="view-board" class="view">

    <!-- Hero -->
    <div class="bg-th-hero py-8 border-b border-th-gold/20">
      <div class="max-w-7xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-6">
        <div>
          <div class="font-script text-th-gold text-5xl md:text-6xl leading-tight" style="text-shadow:0 2px 8px rgba(0,0,0,0.5)">Fill the Calendar.</div>
          <div class="font-display text-white text-xl font-bold mt-1 tracking-wide">Earn the Bounty. Be the Hero.</div>
          <p class="text-white/50 text-sm mt-2">Pick a property below, book a qualifying stay, log it here, and get paid.</p>
        </div>
        <div class="flex gap-3 flex-shrink-0">
          <div class="stat-chip text-center px-5 py-3">
            <div class="font-display text-th-gold text-2xl font-black" id="stat-active">3</div>
            <div class="text-white/50 text-xs uppercase tracking-wide mt-0.5">Active Bounties</div>
          </div>
          <div class="stat-chip text-center px-5 py-3">
            <div class="font-display text-th-gold text-2xl font-black" id="stat-earned">$427</div>
            <div class="text-white/50 text-xs uppercase tracking-wide mt-0.5">Paid This Month</div>
          </div>
          <div class="stat-chip text-center px-5 py-3">
            <div class="font-display text-th-gold text-2xl font-black" id="stat-bookings">14</div>
            <div class="text-white/50 text-xs uppercase tracking-wide mt-0.5">Bookings Logged</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bonus Opportunities Bar -->
    <div class="bonus-bar py-2.5">
      <div class="max-w-7xl mx-auto px-4 flex flex-wrap gap-2 justify-center items-center">
        <span class="text-white/40 text-xs uppercase tracking-widest mr-1 hidden md:inline">Stack Your Earnings:</span>
        <div class="bonus-pill flex items-center gap-2 px-3 py-1">
          <i class="fas fa-bolt text-th-gold text-xs"></i>
          <span class="text-white text-xs font-semibold">Last Minute Hero</span>
          <span class="text-th-gold font-black text-sm">+$25</span>
          <span class="text-white/40 text-xs hidden sm:inline">within 14 days</span>
        </div>
        <div class="bonus-pill flex items-center gap-2 px-3 py-1">
          <i class="fas fa-calendar-week text-th-gold text-xs"></i>
          <span class="text-white text-xs font-semibold">Weekend Warrior</span>
          <span class="text-th-gold font-black text-sm">+$15</span>
          <span class="text-white/40 text-xs hidden sm:inline">Fri or Sat night</span>
        </div>
        <div class="bonus-pill flex items-center gap-2 px-3 py-1">
          <i class="fas fa-moon text-th-gold text-xs"></i>
          <span class="text-white text-xs font-semibold">Long Stay Legend</span>
          <span class="text-th-gold font-black text-sm">+$15</span>
          <span class="text-white/40 text-xs hidden sm:inline">5+ nights</span>
        </div>
      </div>
    </div>

    <!-- Property Cards (Fairway) -->
    <div class="fairway min-h-screen p-6">
      <div class="max-w-7xl mx-auto">

        <!-- Section heading -->
        <div class="text-center mb-6">
          <div class="font-script text-th-black text-3xl ornament">Priority Properties</div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6" id="property-grid">
          <!-- JS rendered -->
        </div>

        <!-- How It Works + Rules -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">

          <!-- How It Works -->
          <div class="info-panel p-6 shadow-sm">
            <h3 class="font-display text-th-black text-lg font-bold mb-4 flex items-center gap-2">
              <i class="fas fa-flag-checkered text-th-red text-base"></i> How It Works
            </h3>
            <div class="space-y-4">
              <div class="flex gap-3 items-start">
                <div class="step-circle bg-th-black text-white">1</div>
                <div><div class="font-bold text-th-black text-sm">Choose a Property</div><div class="text-gray-500 text-xs mt-0.5">Pick any active listing from the board above.</div></div>
              </div>
              <div class="flex gap-3 items-start">
                <div class="step-circle bg-th-red text-white">2</div>
                <div><div class="font-bold text-th-black text-sm">Book It</div><div class="text-gray-500 text-xs mt-0.5">Secure a qualifying reservation on the eligible dates.</div></div>
              </div>
              <div class="flex gap-3 items-start">
                <div class="step-circle" style="background:#FFD200;color:#0d0d0d;">3</div>
                <div><div class="font-bold text-th-black text-sm">Log It Here</div><div class="text-gray-500 text-xs mt-0.5">Submit through the "Log Booking" tab above.</div></div>
              </div>
              <div class="flex gap-3 items-start">
                <div class="step-circle bg-th-green text-white">4</div>
                <div><div class="font-bold text-th-black text-sm">Earn the Bounty</div><div class="text-gray-500 text-xs mt-0.5">Get paid once the guest stay completes and payment clears.</div></div>
              </div>
            </div>
            <div class="mt-5 pt-4 border-t border-gray-100 text-center">
              <span class="font-script text-th-red text-xl">"Fill the calendar. Earn the reward."</span>
            </div>
          </div>

          <!-- Important Rules -->
          <div class="info-panel p-6 shadow-sm">
            <h3 class="font-display text-th-red text-lg font-bold mb-4 flex items-center gap-2">
              <i class="fas fa-shield-alt text-th-red text-base"></i> Important Rules
            </h3>
            <ul class="space-y-2.5">
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check text-th-green mt-0.5 flex-shrink-0 text-xs"></i>
                <span>Bounties apply only to properties and dates listed on the active board.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check text-th-green mt-0.5 flex-shrink-0 text-xs"></i>
                <span>Reservations must be booked at approved rates. Discounts over 15% require prior approval.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check text-th-green mt-0.5 flex-shrink-0 text-xs"></i>
                <span>Bounties are paid after the guest stay completes and payment fully clears.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-times text-th-red mt-0.5 flex-shrink-0 text-xs"></i>
                <span>Cancellations, owner stays, comps, OTAs, heavily discounted, or moved reservations do not qualify.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check text-th-green mt-0.5 flex-shrink-0 text-xs"></i>
                <span>Bounties begin when the property is officially posted to the board.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check text-th-green mt-0.5 flex-shrink-0 text-xs"></i>
                <span>Per-reservation caps apply. See each property card for the cap amount.</span>
              </li>
            </ul>
            <div class="mt-5 pt-4 border-t border-gray-100 text-center text-xs text-gray-400 italic">
              More Bookings &bull; Happier Owners &bull; Better Together
            </div>
          </div>

        </div>
      </div>
    </div>
  </div>

  <!-- ════════════════════ LOG BOOKING TAB ════════════════════ -->
  <div id="view-submit" class="view hidden min-h-screen" style="background:#f0ebe0;">
    <div class="max-w-2xl mx-auto p-6">

      <!-- Header card -->
      <div class="bg-th-black text-white rounded-t-lg px-6 py-4 text-center">
        <div class="font-script text-th-gold text-3xl">Log a Booking</div>
        <p class="text-white/50 text-xs mt-1 uppercase tracking-widest">Submit for Bounty Consideration</p>
      </div>

      <div class="bg-white rounded-b-lg p-6 shadow-lg">
        <form id="booking-form" class="space-y-4" onsubmit="submitBooking(event)">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="th-label">Your Name *</label>
              <input type="text" id="f-agent" required placeholder="Agent name" class="th-input" />
            </div>
            <div>
              <label class="th-label">Guest Name *</label>
              <input type="text" id="f-guest" required placeholder="Guest name" class="th-input" />
            </div>
          </div>

          <div>
            <label class="th-label">Property *</label>
            <select id="f-property" required class="th-input">
              <option value="">-- Select a property --</option>
            </select>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="th-label">Check-In *</label>
              <input type="date" id="f-checkin" required class="th-input" />
            </div>
            <div>
              <label class="th-label">Check-Out *</label>
              <input type="date" id="f-checkout" required class="th-input" />
            </div>
          </div>

          <div>
            <label class="th-label">Nightly Rate (USD) *</label>
            <input type="number" id="f-rate" required min="0" placeholder="e.g. 249" class="th-input" />
          </div>

          <!-- Bonus Qualifiers -->
          <div class="bg-gray-50 rounded p-4 border border-gray-100">
            <p class="th-label mb-3">Bonus Qualifiers – Check all that apply</p>
            <div class="space-y-2">
              <label class="flex items-center gap-3 text-sm cursor-pointer hover:text-th-red transition-colors">
                <input type="checkbox" id="f-lastminute" class="accent-red-700 w-4 h-4" />
                <span><strong>Last Minute Hero</strong> – booked within 14 days of arrival</span>
                <span class="ml-auto text-th-red font-bold text-xs">+$25</span>
              </label>
              <label class="flex items-center gap-3 text-sm cursor-pointer hover:text-th-red transition-colors">
                <input type="checkbox" id="f-weekend" class="accent-red-700 w-4 h-4" />
                <span><strong>Weekend Warrior</strong> – includes a Friday or Saturday night</span>
                <span class="ml-auto text-th-red font-bold text-xs">+$15</span>
              </label>
              <label class="flex items-center gap-3 text-sm cursor-pointer hover:text-th-red transition-colors">
                <input type="checkbox" id="f-longstay" class="accent-red-700 w-4 h-4" />
                <span><strong>Long Stay Legend</strong> – 5 or more nights in one stay</span>
                <span class="ml-auto text-th-red font-bold text-xs">+$15</span>
              </label>
            </div>
          </div>

          <!-- Live Estimate -->
          <div id="bounty-preview" class="hidden rounded overflow-hidden">
            <div class="bounty-panel text-white px-4 py-3">
              <div class="font-display text-th-gold text-sm font-bold uppercase tracking-wide mb-2">Bounty Estimate</div>
              <div class="space-y-1 text-sm">
                <div class="flex justify-between"><span class="text-white/60">Base (nights x per-night)</span><span id="est-base" class="font-bold">--</span></div>
                <div class="flex justify-between"><span class="text-white/60">Bonus Opportunities</span><span id="est-bonus" class="font-bold text-th-gold">--</span></div>
                <div class="border-t border-white/20 mt-2 pt-2 flex justify-between text-base"><span class="font-bold">Estimated Total</span><span id="est-total" class="font-black text-th-gold text-lg">--</span></div>
              </div>
              <div class="text-xs text-white/30 mt-2">Subject to property cap and final admin review.</div>
            </div>
          </div>

          <div class="flex gap-3">
            <button type="button" onclick="calcPreview()" class="btn-outline flex-1">
              <i class="fas fa-calculator mr-1"></i> Estimate Bounty
            </button>
            <button type="submit" class="btn-primary flex-2" style="flex:2">
              <i class="fas fa-paper-plane mr-1"></i> Submit Booking
            </button>
          </div>
        </form>

        <!-- Success State -->
        <div id="submit-success" class="hidden text-center py-10">
          <div class="w-16 h-16 rounded-full bg-th-green/10 flex items-center justify-center mx-auto mb-4">
            <i class="fas fa-check text-th-green text-2xl"></i>
          </div>
          <div class="font-script text-th-black text-3xl">Bounty Logged!</div>
          <p class="text-gray-500 text-sm mt-2 max-w-sm mx-auto" id="success-msg">Your booking has been submitted for review.</p>
          <button onclick="resetForm()" class="mt-5 btn-primary">Log Another Booking</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ════════════════════ LEADERBOARD TAB ════════════════════ -->
  <div id="view-leaderboard" class="view hidden min-h-screen" style="background:#f0ebe0;">
    <div class="max-w-3xl mx-auto p-6">

      <div class="bg-th-black text-white rounded-t-lg px-6 py-5 text-center">
        <i class="fas fa-trophy text-th-gold text-3xl mb-2 block"></i>
        <div class="font-script text-th-gold text-3xl">Top Bounty Earners</div>
        <p class="text-white/40 text-xs mt-1 uppercase tracking-widest">Current Month Rankings</p>
      </div>

      <div class="bg-white rounded-b-lg p-6 shadow-lg">
        <div id="leaderboard-list" class="space-y-3 mb-8"><!-- JS --></div>

        <div class="border-t border-gray-100 pt-6">
          <h4 class="font-display text-th-black text-base font-bold mb-3 flex items-center gap-2">
            <i class="fas fa-history text-th-red text-sm"></i> Recent Bookings
          </h4>
          <div id="bookings-list" class="space-y-2 text-sm">
            <p class="text-gray-400 text-center text-sm py-4">No bookings logged yet.</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ════════════════════ ADMIN TAB ════════════════════ -->
  <div id="view-admin" class="view hidden min-h-screen" style="background:#f0ebe0;">
    <div class="max-w-4xl mx-auto p-6 space-y-6">

      <!-- Post New Property -->
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <div class="bg-th-black px-5 py-3">
          <div class="font-display text-white text-base font-bold flex items-center gap-2">
            <i class="fas fa-plus-square text-th-gold"></i> Post a New Property
          </div>
        </div>
        <div class="p-5">
          <form id="admin-form" class="grid grid-cols-1 md:grid-cols-2 gap-4" onsubmit="addProperty(event)">
            <div>
              <label class="th-label">Property Name *</label>
              <input type="text" id="a-name" required placeholder="e.g. Ridgeline Chalet" class="th-input" />
            </div>
            <div>
              <label class="th-label">Priority Level *</label>
              <select id="a-priority" required class="th-input">
                <option value="top-bounty">Top Bounty</option>
                <option value="high-priority">High Priority</option>
                <option value="gap-killer">Gap Killer</option>
                <option value="standard">Standard</option>
              </select>
            </div>
            <div class="md:col-span-2">
              <label class="th-label">Why It's on the Board *</label>
              <input type="text" id="a-why" required placeholder="e.g. Too many open dates in June" class="th-input" />
            </div>
            <div>
              <label class="th-label">Eligible Dates *</label>
              <input type="text" id="a-dates" required placeholder="e.g. June 1 – July 15" class="th-input" />
            </div>
            <div>
              <label class="th-label">Min Stay (nights) *</label>
              <input type="number" id="a-minstay" required min="1" value="2" class="th-input" />
            </div>
            <div>
              <label class="th-label">Bounty Per Night ($) *</label>
              <input type="number" id="a-pernite" required min="1" value="3" class="th-input" />
            </div>
            <div>
              <label class="th-label">Cap Per Reservation ($) *</label>
              <input type="number" id="a-cap" required min="1" value="35" class="th-input" />
            </div>
            <div>
              <label class="th-label">Bonus Amount ($)</label>
              <input type="number" id="a-bonus" min="0" value="15" class="th-input" />
            </div>
            <div>
              <label class="th-label">Bonus Condition</label>
              <input type="text" id="a-boncond" placeholder="e.g. Fill a full calendar gap" class="th-input" />
            </div>
            <div class="md:col-span-2">
              <label class="th-label">Property Photo URL</label>
              <input type="url" id="a-photo" placeholder="https://..." class="th-input" />
            </div>
            <div class="md:col-span-2">
              <button type="submit" class="btn-primary">
                <i class="fas fa-thumbtack mr-1"></i> Post to Board
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Manage Properties -->
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <div class="bg-th-black px-5 py-3">
          <div class="font-display text-white text-base font-bold flex items-center gap-2">
            <i class="fas fa-tasks text-th-gold"></i> Manage Properties
          </div>
        </div>
        <div class="p-5">
          <div id="admin-prop-list" class="space-y-3"><!-- JS --></div>
        </div>
      </div>

      <!-- Review Bookings -->
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <div class="bg-th-black px-5 py-3">
          <div class="font-display text-white text-base font-bold flex items-center gap-2">
            <i class="fas fa-clipboard-check text-th-gold"></i> Review Bookings
          </div>
        </div>
        <div class="p-5">
          <div id="admin-booking-list" class="space-y-3">
            <p class="text-gray-400 text-sm text-center py-4">No bookings submitted yet.</p>
          </div>
        </div>
      </div>

    </div>
  </div>

  <!-- ════════════════════ FOOTER ════════════════════ -->
  <footer class="bg-th-black border-t border-th-gold/20 py-5 text-center">
    <div class="font-script text-th-gold text-xl mb-1">Thousand Hills</div>
    <p class="text-white/30 text-xs tracking-widest uppercase">More Bookings &bull; Happier Owners &bull; Better Together</p>
  </footer>

<script>
// ── State ──────────────────────────────────────────────────────────────────────
let allProperties = [];
let allBookings = [];
let allLeaderboard = [];

// ── Navigation ─────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.remove('nav-active');
    b.classList.remove('text-white');
    b.classList.add('text-white/60');
  });
  document.getElementById('view-' + name).classList.remove('hidden');
  const btn = document.getElementById('tab-' + name);
  btn.classList.add('nav-active');
  btn.classList.remove('text-white/60');
  btn.classList.add('text-white');
  if (name === 'board') renderBoard();
  if (name === 'leaderboard') renderLeaderboard();
  if (name === 'admin') renderAdmin();
}

// ── Fetch Helpers ──────────────────────────────────────────────────────────────
async function fetchProperties() {
  const res = await fetch('/api/properties');
  allProperties = await res.json();
}
async function fetchBookings() {
  const res = await fetch('/api/bookings');
  allBookings = await res.json();
}
async function fetchLeaderboard() {
  const res = await fetch('/api/leaderboard');
  allLeaderboard = await res.json();
}

// ── Priority Styles ────────────────────────────────────────────────────────────
const PRIORITY = {
  'top-bounty':   { badge: 'TOP BOUNTY',    ribbonCls: 'ribbon-top',  badgeCls: 'badge-top',  icon: 'fa-star'        },
  'high-priority':{ badge: 'HIGH PRIORITY', ribbonCls: 'ribbon-high', badgeCls: 'badge-high', icon: 'fa-arrow-up'    },
  'gap-killer':   { badge: 'GAP KILLER',    ribbonCls: 'ribbon-gap',  badgeCls: 'badge-gap',  icon: 'fa-compress-alt'},
  'standard':     { badge: 'AVAILABLE',     ribbonCls: 'ribbon-std',  badgeCls: 'badge-std',  icon: 'fa-calendar'    },
};

// ── Board Render ───────────────────────────────────────────────────────────────
function renderBoard() {
  const grid = document.getElementById('property-grid');
  const active = allProperties.filter(p => p.status === 'active');
  document.getElementById('stat-active').textContent = active.length;

  if (active.length === 0) {
    grid.innerHTML = '<p class="col-span-3 text-center text-gray-400 py-12 text-base font-display italic">No active bounties right now. Check back soon!</p>';
    return;
  }

  const tilts = ['th-card-tilt-l','th-card-tilt-r','th-card-tilt-n'];
  grid.innerHTML = active.map((p, i) => {
    const pr = PRIORITY[p.priority] || PRIORITY['standard'];
    const tilt = tilts[i % tilts.length];
    return \`
    <div class="th-card \${tilt} transition-transform hover:rotate-0 hover:scale-[1.02] duration-200">
      <div class="\${pr.ribbonCls} text-xs font-black px-6 py-1.5 text-center tracking-widest flex items-center justify-center gap-1.5">
        <i class="fas \${pr.icon} text-xs opacity-80"></i> \${pr.badge}
      </div>
      \${p.photo ? \`<img src="\${p.photo}" alt="\${p.name}" class="w-full h-44 object-cover" onerror="this.style.display='none'" />\` : \`<div class="w-full h-24 bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center"><i class="fas fa-home text-gray-300 text-4xl"></i></div>\`}
      <div class="p-4">
        <div class="font-display text-th-black text-xl font-bold leading-tight mb-3">\${p.name}</div>
        <div class="space-y-1.5 text-xs text-gray-600 mb-4">
          <div class="flex gap-2 items-start"><i class="fas fa-info-circle text-th-red w-3 mt-0.5 flex-shrink-0"></i><span>\${p.why}</span></div>
          <div class="flex gap-2 items-center"><i class="fas fa-calendar-alt text-th-green w-3 flex-shrink-0"></i><span>\${p.eligibleDates}</span></div>
          <div class="flex gap-2 items-center"><i class="fas fa-moon text-gray-400 w-3 flex-shrink-0"></i><span>Min Stay: \${p.minStay} nights</span></div>
        </div>
        <div class="bounty-panel text-white rounded p-3 mb-3">
          <div class="text-white/50 text-xs uppercase tracking-wide mb-1">Bounty</div>
          <div class="flex items-baseline gap-1.5">
            <span class="font-display text-3xl font-bold" style="color:#FFD200">$\${p.bountyPerNight}</span>
            <span class="text-xs text-white/60">per paid night booked</span>
          </div>
          \${p.bonusAmount > 0 ? \`
          <div class="bonus-chip mt-2 px-2.5 py-1.5 flex items-center justify-between text-xs">
            <span class="font-bold">+ $\${p.bonusAmount} BONUS</span>
            <span class="opacity-80">\${p.bonusCondition}</span>
          </div>\` : ''}
          <div class="text-right text-xs text-white/30 mt-1.5">Cap: $\${p.cap} per reservation</div>
        </div>
        <button onclick="showTab('submit')" class="btn-primary w-full text-center">
          <i class="fas fa-golf-ball mr-1.5"></i> Claim This Bounty
        </button>
      </div>
    </div>
    \`;
  }).join('');
}

// ── Leaderboard Render ─────────────────────────────────────────────────────────
function renderLeaderboard() {
  const podiumCls = ['podium-1','podium-2','podium-3'];
  const medals = ['🥇','🥈','🥉'];
  const list = document.getElementById('leaderboard-list');
  if (allLeaderboard.length === 0) {
    list.innerHTML = '<p class="text-center text-gray-400 text-sm py-6">No earners yet. Be the first to claim a bounty!</p>';
  } else {
    list.innerHTML = allLeaderboard.map((l, i) => \`
    <div class="flex items-center gap-4 bg-gray-50 rounded px-4 py-3 border border-gray-100 \${podiumCls[i] || ''}">
      <span class="text-2xl w-8 text-center">\${medals[i] || '#'+(i+1)}</span>
      <div class="flex-1">
        <div class="font-bold text-th-black">\${l.name}</div>
        <div class="text-xs text-gray-500">\${l.bookings} booking\${l.bookings !== 1 ? 's' : ''} logged</div>
      </div>
      <div class="text-right">
        <div class="font-display text-xl font-bold text-th-red">$\${l.total}</div>
        <div class="text-xs text-gray-400">earned</div>
      </div>
    </div>\`).join('');
  }

  const bList = document.getElementById('bookings-list');
  if (allBookings.length === 0) {
    bList.innerHTML = '<p class="text-gray-400 text-center text-sm py-4">No bookings logged yet.</p>';
  } else {
    bList.innerHTML = allBookings.slice().reverse().map(b => {
      const prop = allProperties.find(p => p.id === b.propertyId);
      const statusCls = {pending:'status-pending', cleared:'status-cleared', disqualified:'status-disq'}[b.status] || '';
      return \`<div class="flex items-center justify-between bg-gray-50 rounded px-3 py-2.5 border border-gray-100">
        <div>
          <span class="font-bold text-th-black text-xs">\${b.agentName}</span>
          <span class="text-gray-400 text-xs"> &rarr; \${prop ? prop.name : b.propertyId}</span>
          <div class="text-xs text-gray-500 mt-0.5">\${b.nights} nights | Check-in: \${b.checkIn}</div>
        </div>
        <div class="text-right">
          <div class="font-bold text-th-red text-sm">$\${b.totalEarned}</div>
          <span class="text-xs px-2 py-0.5 rounded-full \${statusCls}">\${b.status}</span>
        </div>
      </div>\`;
    }).join('');
  }
}

// ── Admin Render ───────────────────────────────────────────────────────────────
function renderAdmin() {
  const propList = document.getElementById('admin-prop-list');
  if (allProperties.length === 0) {
    propList.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">No properties posted yet.</p>';
  } else {
    propList.innerHTML = allProperties.map(p => {
      const stCls = {active:'status-active', filled:'status-filled', expired:'status-expired'}[p.status] || '';
      const pr = PRIORITY[p.priority] || PRIORITY['standard'];
      return \`<div class="flex flex-wrap items-center justify-between gap-3 bg-gray-50 rounded px-4 py-3 border border-gray-100">
        <div class="flex items-center gap-3">
          <span class="\${pr.badgeCls} text-xs font-bold px-2 py-0.5 rounded">\${pr.badge}</span>
          <div>
            <div class="font-bold text-th-black text-sm">\${p.name}</div>
            <div class="text-xs text-gray-500">\${p.eligibleDates} | $\${p.bountyPerNight}/night | Cap: $\${p.cap}</div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-1 rounded-full \${stCls}">\${p.status}</span>
          <select onchange="updatePropStatus('\${p.id}', this.value)" class="text-xs border border-gray-200 rounded px-2 py-1 bg-white">
            <option value="active" \${p.status==='active'?'selected':''}>Active</option>
            <option value="filled" \${p.status==='filled'?'selected':''}>Filled</option>
            <option value="expired" \${p.status==='expired'?'selected':''}>Expired</option>
          </select>
          <button onclick="deleteProp('\${p.id}')" class="text-xs bg-red-50 text-th-red hover:bg-red-100 px-2 py-1 rounded transition-all border border-red-100">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>\`;
    }).join('');
  }

  const bList = document.getElementById('admin-booking-list');
  if (allBookings.length === 0) {
    bList.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">No bookings submitted yet.</p>';
  } else {
    bList.innerHTML = allBookings.slice().reverse().map(b => {
      const prop = allProperties.find(p => p.id === b.propertyId);
      const statusCls = {pending:'status-pending', cleared:'status-cleared', disqualified:'status-disq'}[b.status] || '';
      return \`<div class="flex flex-wrap items-start justify-between gap-2 bg-gray-50 rounded px-4 py-3 border border-gray-100">
        <div>
          <div class="font-bold text-th-black text-sm">\${b.agentName} &rarr; \${prop ? prop.name : b.propertyId}</div>
          <div class="text-xs text-gray-500">Guest: \${b.guestName} | \${b.checkIn} – \${b.checkOut} | \${b.nights} nights | $\${b.rate}/night</div>
          <div class="text-xs text-gray-500 mt-0.5">
            Base: $\${b.baseBounty} + Bonuses: $\${b.bonusEarned} = <strong class="text-th-black">$\${b.totalEarned}</strong>
            \${b.isLastMinute ? '<span class="ml-1 bg-red-50 text-th-red border border-red-100 px-1.5 rounded text-xs">Last Min</span>' : ''}
            \${b.isWeekend ? '<span class="ml-1 bg-yellow-50 text-yellow-700 border border-yellow-100 px-1.5 rounded text-xs">Weekend</span>' : ''}
            \${b.isLongStay ? '<span class="ml-1 bg-green-50 text-th-green border border-green-100 px-1.5 rounded text-xs">Long Stay</span>' : ''}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-1 rounded-full \${statusCls}">\${b.status}</span>
          <select onchange="updateBookingStatus('\${b.id}', this.value)" class="text-xs border border-gray-200 rounded px-2 py-1 bg-white">
            <option value="pending" \${b.status==='pending'?'selected':''}>Pending</option>
            <option value="cleared" \${b.status==='cleared'?'selected':''}>Cleared</option>
            <option value="disqualified" \${b.status==='disqualified'?'selected':''}>Disqualified</option>
          </select>
        </div>
      </div>\`;
    }).join('');
  }
}

// ── Booking Form ───────────────────────────────────────────────────────────────
function populatePropertySelect() {
  const sel = document.getElementById('f-property');
  const active = allProperties.filter(p => p.status === 'active');
  sel.innerHTML = '<option value="">-- Select a property --</option>' +
    active.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
}

function calcPreview() {
  const propId = document.getElementById('f-property').value;
  const cin = document.getElementById('f-checkin').value;
  const cout = document.getElementById('f-checkout').value;
  if (!propId || !cin || !cout) { alert('Please select a property and dates first.'); return; }
  const prop = allProperties.find(p => p.id === propId);
  const nights = Math.max(0, Math.round((new Date(cout) - new Date(cin)) / 86400000));
  const base = Math.min(nights * prop.bountyPerNight, prop.cap);
  const lm = document.getElementById('f-lastminute').checked ? 25 : 0;
  const wk = document.getElementById('f-weekend').checked ? 15 : 0;
  const ls = document.getElementById('f-longstay').checked ? 15 : 0;
  const bonus = lm + wk + ls;
  const total = base + bonus;
  document.getElementById('est-base').textContent = \`$\${base}\`;
  document.getElementById('est-bonus').textContent = bonus > 0 ? \`+$\${bonus}\` : '$0';
  document.getElementById('est-total').textContent = \`$\${total}\`;
  document.getElementById('bounty-preview').classList.remove('hidden');
}

async function submitBooking(e) {
  e.preventDefault();
  const propId = document.getElementById('f-property').value;
  const cin = document.getElementById('f-checkin').value;
  const cout = document.getElementById('f-checkout').value;
  const nights = Math.max(0, Math.round((new Date(cout) - new Date(cin)) / 86400000));
  const prop = allProperties.find(p => p.id === propId);

  if (nights < prop.minStay) {
    alert(\`Minimum stay for \${prop.name} is \${prop.minStay} nights. This booking doesn't qualify.\`);
    return;
  }

  const payload = {
    propertyId: propId,
    agentName: document.getElementById('f-agent').value,
    guestName: document.getElementById('f-guest').value,
    checkIn: cin,
    checkOut: cout,
    nights,
    rate: parseFloat(document.getElementById('f-rate').value),
    isWeekend: document.getElementById('f-weekend').checked,
    isLastMinute: document.getElementById('f-lastminute').checked,
    isLongStay: document.getElementById('f-longstay').checked,
  };

  const res = await fetch('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const booking = await res.json();

  await fetchBookings();
  await fetchLeaderboard();

  document.getElementById('booking-form').classList.add('hidden');
  document.getElementById('submit-success').classList.remove('hidden');
  document.getElementById('success-msg').textContent =
    \`Booking logged for \${prop.name}! Estimated bounty: $\${booking.totalEarned}. You'll get paid once the guest stay completes and payment clears.\`;
}

function resetForm() {
  document.getElementById('booking-form').reset();
  document.getElementById('booking-form').classList.remove('hidden');
  document.getElementById('submit-success').classList.add('hidden');
  document.getElementById('bounty-preview').classList.add('hidden');
}

// ── Admin Actions ──────────────────────────────────────────────────────────────
async function addProperty(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('a-name').value,
    priority: document.getElementById('a-priority').value,
    why: document.getElementById('a-why').value,
    eligibleDates: document.getElementById('a-dates').value,
    minStay: parseInt(document.getElementById('a-minstay').value),
    bountyPerNight: parseFloat(document.getElementById('a-pernite').value),
    cap: parseFloat(document.getElementById('a-cap').value),
    bonusAmount: parseFloat(document.getElementById('a-bonus').value) || 0,
    bonusCondition: document.getElementById('a-boncond').value || '',
    photo: document.getElementById('a-photo').value || '',
    status: 'active',
  };
  await fetch('/api/properties', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await fetchProperties();
  document.getElementById('admin-form').reset();
  renderAdmin();
  populatePropertySelect();
}

async function updatePropStatus(id, status) {
  await fetch(\`/api/properties/\${id}/status\`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  await fetchProperties();
  renderAdmin();
  renderBoard();
}

async function deleteProp(id) {
  if (!confirm('Remove this property from the board?')) return;
  await fetch(\`/api/properties/\${id}\`, { method: 'DELETE' });
  await fetchProperties();
  renderAdmin();
  renderBoard();
  populatePropertySelect();
}

async function updateBookingStatus(id, status) {
  await fetch(\`/api/bookings/\${id}/status\`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  await fetchBookings();
  renderAdmin();
}

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  await Promise.all([fetchProperties(), fetchBookings(), fetchLeaderboard()]);
  renderBoard();
  populatePropertySelect();
}

init();
</script>
</body>
</html>`)
})

export default app
