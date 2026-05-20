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
  <title>Booking Bounty Board</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            display: ['Playfair Display', 'serif'],
            body: ['Inter', 'sans-serif'],
          },
          colors: {
            bounty: {
              dark: '#1a1208',
              brown: '#5c3d1e',
              tan: '#f5e6c8',
              parchment: '#fdf6e3',
              red: '#c0392b',
              gold: '#d4a017',
              blue: '#1a3a5c',
              green: '#1e6b3a',
            }
          }
        }
      }
    }
  </script>
  <style>
    body { font-family: 'Inter', sans-serif; background: #1a1208; }
    .font-display { font-family: 'Playfair Display', serif; }
    .card-shadow { box-shadow: 4px 4px 16px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1); }
    .parchment { background: #fdf6e3; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='400' height='400' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E"); }
    .wanted-ribbon { background: linear-gradient(135deg, #c0392b, #922b21); clip-path: polygon(0 0, 100% 0, 95% 50%, 100% 100%, 0 100%, 5% 50%); }
    .priority-ribbon { background: linear-gradient(135deg, #d4a017, #a07810); clip-path: polygon(0 0, 100% 0, 95% 50%, 100% 100%, 0 100%, 5% 50%); }
    .gap-ribbon { background: linear-gradient(135deg, #1a3a5c, #0d2540); clip-path: polygon(0 0, 100% 0, 95% 50%, 100% 100%, 0 100%, 5% 50%); }
    .std-ribbon { background: linear-gradient(135deg, #1e6b3a, #145429); clip-path: polygon(0 0, 100% 0, 95% 50%, 100% 100%, 0 100%, 5% 50%); }
    .corkboard { background-color: #c8a870; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Cfilter id='grain'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0.5'/%3E%3C/filter%3E%3Crect width='100' height='100' filter='url(%23grain)' opacity='0.15'/%3E%3C/svg%3E"); }
    .pushpin { width: 16px; height: 16px; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.5); position: absolute; top: -8px; left: 50%; transform: translateX(-50%); }
    .pin-red { background: radial-gradient(circle at 35% 35%, #ff6b6b, #c0392b); }
    .pin-blue { background: radial-gradient(circle at 35% 35%, #74b9ff, #1a3a5c); }
    .pin-yellow { background: radial-gradient(circle at 35% 35%, #fdcb6e, #d4a017); }
    .pin-green { background: radial-gradient(circle at 35% 35%, #55efc4, #1e6b3a); }
    .bounty-strip { background: linear-gradient(135deg, #1a1208, #2d1f0a); }
    .bonus-box { background: linear-gradient(135deg, #c0392b, #922b21); }
    .nav-active { background: rgba(255,255,255,0.15); border-bottom: 2px solid #d4a017; }
    .modal-overlay { backdrop-filter: blur(4px); }
    .slide-in { animation: slideIn 0.3s ease-out; }
    @keyframes slideIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .badge-top { background: linear-gradient(135deg, #c0392b, #922b21); }
    .badge-high { background: linear-gradient(135deg, #d4a017, #a07810); }
    .badge-gap { background: linear-gradient(135deg, #1a3a5c, #0d2540); }
    .badge-std { background: linear-gradient(135deg, #1e6b3a, #145429); }
    .status-active { background: #d4edda; color: #155724; }
    .status-filled { background: #cce5ff; color: #004085; }
    .status-expired { background: #f8d7da; color: #721c24; }
    select, input, textarea { background: white !important; }
  </style>
</head>
<body class="min-h-screen text-gray-800">

  <!-- ── Header ── -->
  <header class="bg-bounty-dark border-b border-bounty-gold/30">
    <div class="max-w-7xl mx-auto px-4">
      <div class="flex items-center justify-between py-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full border-2 border-bounty-gold flex items-center justify-center bg-bounty-brown/40">
            <i class="fas fa-bullseye text-bounty-gold text-sm"></i>
          </div>
          <div>
            <div class="font-display text-bounty-gold text-xl font-black tracking-wide leading-none">BOOKING BOUNTY BOARD</div>
            <div class="text-bounty-tan/70 text-xs tracking-widest uppercase">Priority Properties. Big Rewards.</div>
          </div>
        </div>
        <nav class="flex gap-1">
          <button onclick="showTab('board')" id="tab-board" class="nav-btn nav-active px-4 py-2 text-bounty-tan text-sm font-semibold rounded-t transition-all">
            <i class="fas fa-clipboard-list mr-1"></i> Board
          </button>
          <button onclick="showTab('submit')" id="tab-submit" class="nav-btn px-4 py-2 text-bounty-tan/70 text-sm font-semibold rounded-t transition-all hover:bg-white/10">
            <i class="fas fa-plus-circle mr-1"></i> Log Booking
          </button>
          <button onclick="showTab('leaderboard')" id="tab-leaderboard" class="nav-btn px-4 py-2 text-bounty-tan/70 text-sm font-semibold rounded-t transition-all hover:bg-white/10">
            <i class="fas fa-trophy mr-1"></i> Leaderboard
          </button>
          <button onclick="showTab('admin')" id="tab-admin" class="nav-btn px-4 py-2 text-bounty-tan/70 text-sm font-semibold rounded-t transition-all hover:bg-white/10">
            <i class="fas fa-cog mr-1"></i> Admin
          </button>
        </nav>
      </div>
      <div class="text-center pb-2">
        <p class="text-bounty-gold/60 text-xs tracking-widest uppercase">Fill More Nights &bull; Earn Rewards &bull; Be the Hero</p>
      </div>
    </div>
  </header>

  <!-- ── Board Tab ── -->
  <div id="view-board" class="view">
    <!-- Hero Banner -->
    <div class="bg-gradient-to-r from-bounty-dark via-bounty-brown to-bounty-dark py-6 border-b border-bounty-gold/20">
      <div class="max-w-7xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-4">
        <div>
          <div class="font-display text-4xl md:text-5xl font-black text-white leading-none">
            WANTED: <span class="text-bounty-gold">BOOKINGS.</span>
          </div>
          <p class="text-bounty-tan/80 mt-1 text-sm">Pick a property. Book a qualifying stay. Collect your bounty.</p>
        </div>
        <div class="flex gap-3">
          <div class="text-center bg-white/10 rounded-lg px-4 py-2">
            <div class="text-bounty-gold font-display text-2xl font-black" id="stat-active">3</div>
            <div class="text-bounty-tan/70 text-xs uppercase tracking-wide">Active Bounties</div>
          </div>
          <div class="text-center bg-white/10 rounded-lg px-4 py-2">
            <div class="text-bounty-gold font-display text-2xl font-black" id="stat-earned">$427</div>
            <div class="text-bounty-tan/70 text-xs uppercase tracking-wide">Paid Out This Month</div>
          </div>
          <div class="text-center bg-white/10 rounded-lg px-4 py-2">
            <div class="text-bounty-gold font-display text-2xl font-black" id="stat-bookings">14</div>
            <div class="text-bounty-tan/70 text-xs uppercase tracking-wide">Bookings Logged</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bonus Opportunities Bar -->
    <div class="bg-bounty-dark border-b border-bounty-gold/30 py-2">
      <div class="max-w-7xl mx-auto px-4 flex flex-wrap gap-3 justify-center">
        <div class="flex items-center gap-2 bg-bounty-gold/20 rounded-full px-4 py-1">
          <i class="fas fa-bolt text-bounty-gold text-xs"></i>
          <span class="text-bounty-tan text-xs font-semibold">LAST MINUTE HERO</span>
          <span class="text-bounty-gold font-black text-sm">+$25</span>
          <span class="text-bounty-tan/60 text-xs">Book within 14 days</span>
        </div>
        <div class="flex items-center gap-2 bg-bounty-gold/20 rounded-full px-4 py-1">
          <i class="fas fa-calendar-week text-bounty-gold text-xs"></i>
          <span class="text-bounty-tan text-xs font-semibold">WEEKEND WARRIOR</span>
          <span class="text-bounty-gold font-black text-sm">+$15</span>
          <span class="text-bounty-tan/60 text-xs">Fri or Sat night stay</span>
        </div>
        <div class="flex items-center gap-2 bg-bounty-gold/20 rounded-full px-4 py-1">
          <i class="fas fa-moon text-bounty-gold text-xs"></i>
          <span class="text-bounty-tan text-xs font-semibold">LONG STAY LEGEND</span>
          <span class="text-bounty-gold font-black text-sm">+$15</span>
          <span class="text-bounty-tan/60 text-xs">5+ nights in one stay</span>
        </div>
      </div>
    </div>

    <!-- Corkboard -->
    <div class="corkboard min-h-screen p-6">
      <div class="max-w-7xl mx-auto">
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6" id="property-grid">
          <!-- Cards rendered by JS -->
        </div>

        <!-- Rules + How It Works -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
          <!-- How It Works -->
          <div class="parchment rounded-lg p-5 relative card-shadow">
            <div class="pushpin pin-blue"></div>
            <h3 class="font-display text-bounty-dark text-xl font-black mb-4 flex items-center gap-2">
              <i class="fas fa-star text-bounty-gold text-sm"></i> HOW IT WORKS
            </h3>
            <div class="space-y-4">
              <div class="flex gap-3 items-start">
                <div class="w-8 h-8 rounded-full bg-bounty-dark text-white flex items-center justify-center font-black text-sm flex-shrink-0">1</div>
                <div>
                  <div class="font-bold text-bounty-dark text-sm">CHOOSE A PROPERTY</div>
                  <div class="text-gray-600 text-xs mt-0.5">Pick a property from the board with eligible dates.</div>
                </div>
              </div>
              <div class="flex gap-3 items-start">
                <div class="w-8 h-8 rounded-full bg-bounty-red text-white flex items-center justify-center font-black text-sm flex-shrink-0">2</div>
                <div>
                  <div class="font-bold text-bounty-dark text-sm">BOOK IT</div>
                  <div class="text-gray-600 text-xs mt-0.5">Book a qualifying reservation on the eligible dates.</div>
                </div>
              </div>
              <div class="flex gap-3 items-start">
                <div class="w-8 h-8 rounded-full bg-bounty-gold text-white flex items-center justify-center font-black text-sm flex-shrink-0">3</div>
                <div>
                  <div class="font-bold text-bounty-dark text-sm">LOG IT HERE</div>
                  <div class="text-gray-600 text-xs mt-0.5">Submit it through the "Log Booking" tab above.</div>
                </div>
              </div>
              <div class="flex gap-3 items-start">
                <div class="w-8 h-8 rounded-full bg-bounty-green text-white flex items-center justify-center font-black text-sm flex-shrink-0">4</div>
                <div>
                  <div class="font-bold text-bounty-dark text-sm">EARN THE BOUNTY</div>
                  <div class="text-gray-600 text-xs mt-0.5">Get paid after the guest stay completes and payment clears.</div>
                </div>
              </div>
            </div>
            <div class="mt-4 text-center italic text-bounty-brown font-display text-lg">"Be the hero. Fill the calendar!"</div>
          </div>

          <!-- Important Rules -->
          <div class="parchment rounded-lg p-5 relative card-shadow">
            <div class="pushpin pin-red"></div>
            <h3 class="font-display text-bounty-red text-xl font-black mb-4 flex items-center gap-2">
              <i class="fas fa-star text-bounty-red text-sm"></i> IMPORTANT RULES
            </h3>
            <ul class="space-y-2.5">
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check-square text-bounty-red mt-0.5 flex-shrink-0"></i>
                <span>Bounties apply only to properties and dates listed on the board.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check-square text-bounty-red mt-0.5 flex-shrink-0"></i>
                <span>Reservations must be booked at approved rates. Discounts over 15% need prior approval.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check-square text-bounty-red mt-0.5 flex-shrink-0"></i>
                <span>Bounties are paid after the guest stay is completed and payment fully clears.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check-square text-bounty-red mt-0.5 flex-shrink-0"></i>
                <span>Cancellations, owner stays, comps, OTAs, heavily discounted, or moved reservations do not qualify.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check-square text-bounty-red mt-0.5 flex-shrink-0"></i>
                <span>Bounties begin only when the property is officially posted on the board.</span>
              </li>
              <li class="flex gap-2 items-start text-xs text-gray-700">
                <i class="fas fa-check-square text-bounty-red mt-0.5 flex-shrink-0"></i>
                <span>Per-reservation caps apply. See each property card for the cap amount.</span>
              </li>
            </ul>
            <div class="mt-4 text-center text-xs text-gray-500 italic">More bookings. Happier owners. Better together.</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Submit / Log Booking Tab ── -->
  <div id="view-submit" class="view hidden bg-bounty-tan min-h-screen p-6">
    <div class="max-w-2xl mx-auto">
      <div class="parchment rounded-xl p-8 card-shadow relative">
        <div class="pushpin pin-yellow" style="top:-8px; left:50%; transform:translateX(-50%)"></div>
        <div class="text-center mb-6">
          <div class="font-display text-bounty-dark text-3xl font-black">LOG A BOOKING</div>
          <p class="text-gray-500 text-sm mt-1">Submit a qualifying reservation and calculate your bounty</p>
        </div>

        <form id="booking-form" class="space-y-4" onsubmit="submitBooking(event)">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Your Name *</label>
              <input type="text" id="f-agent" required placeholder="Agent name"
                class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-bounty-gold" />
            </div>
            <div>
              <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Guest Name *</label>
              <input type="text" id="f-guest" required placeholder="Guest name"
                class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-bounty-gold" />
            </div>
          </div>

          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Property *</label>
            <select id="f-property" required
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-bounty-gold">
              <option value="">-- Select a property --</option>
            </select>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Check-In *</label>
              <input type="date" id="f-checkin" required
                class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-bounty-gold" />
            </div>
            <div>
              <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Check-Out *</label>
              <input type="date" id="f-checkout" required
                class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-bounty-gold" />
            </div>
          </div>

          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase tracking-wide">Nightly Rate (USD) *</label>
            <input type="number" id="f-rate" required min="0" placeholder="e.g. 189"
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-bounty-gold" />
          </div>

          <div class="bg-bounty-tan/80 rounded-lg p-4 border border-bounty-brown/20">
            <p class="text-xs font-bold text-bounty-dark mb-3 uppercase tracking-wide">Bonus Qualifiers</p>
            <div class="space-y-2">
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" id="f-lastminute" class="accent-bounty-red" />
                <span><strong>Last Minute Hero</strong> – booked within 14 days of arrival <span class="text-bounty-red font-bold">(+$25)</span></span>
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" id="f-weekend" class="accent-bounty-gold" />
                <span><strong>Weekend Warrior</strong> – includes a Fri or Sat night <span class="text-bounty-red font-bold">(+$15)</span></span>
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" id="f-longstay" class="accent-bounty-green" />
                <span><strong>Long Stay Legend</strong> – 5 or more nights in this stay <span class="text-bounty-red font-bold">(+$15)</span></span>
              </label>
            </div>
          </div>

          <!-- Live Bounty Estimate -->
          <div id="bounty-preview" class="hidden bg-bounty-dark text-white rounded-lg p-4">
            <div class="font-display text-lg font-black mb-2 text-bounty-gold">BOUNTY ESTIMATE</div>
            <div class="space-y-1 text-sm">
              <div class="flex justify-between"><span class="text-white/70">Nights x Per-Night Bounty</span><span id="est-base" class="font-bold">--</span></div>
              <div class="flex justify-between"><span class="text-white/70">Bonus Opportunities</span><span id="est-bonus" class="font-bold text-bounty-gold">--</span></div>
              <div class="border-t border-white/20 mt-2 pt-2 flex justify-between text-lg"><span class="font-bold">Est. Total Bounty</span><span id="est-total" class="font-black text-bounty-gold">--</span></div>
              <div class="text-xs text-white/50 mt-1">* Subject to property cap and final admin review</div>
            </div>
          </div>

          <button type="button" onclick="calcPreview()"
            class="w-full py-2 border-2 border-bounty-gold text-bounty-dark font-bold rounded text-sm hover:bg-bounty-gold/20 transition-all">
            <i class="fas fa-calculator mr-1"></i> Calculate Estimate
          </button>

          <button type="submit"
            class="w-full py-3 bg-bounty-red text-white font-black rounded text-sm uppercase tracking-wide hover:bg-red-800 transition-all">
            <i class="fas fa-paper-plane mr-1"></i> Submit Booking for Bounty
          </button>
        </form>

        <div id="submit-success" class="hidden text-center py-8">
          <div class="text-6xl mb-4">🎯</div>
          <div class="font-display text-2xl font-black text-bounty-dark">BOUNTY LOGGED!</div>
          <p class="text-gray-500 text-sm mt-2" id="success-msg">Your booking has been submitted. You'll get paid once the stay completes.</p>
          <button onclick="resetForm()" class="mt-4 px-6 py-2 bg-bounty-dark text-white rounded font-bold text-sm">Log Another</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Leaderboard Tab ── -->
  <div id="view-leaderboard" class="view hidden bg-bounty-tan min-h-screen p-6">
    <div class="max-w-3xl mx-auto">
      <div class="parchment rounded-xl p-8 card-shadow relative">
        <div class="pushpin pin-yellow" style="top:-8px; left:50%; transform:translateX(-50%)"></div>
        <div class="text-center mb-6">
          <i class="fas fa-trophy text-bounty-gold text-4xl mb-2"></i>
          <div class="font-display text-bounty-dark text-3xl font-black">TOP BOUNTY EARNERS</div>
          <p class="text-gray-500 text-sm">Current Month Rankings</p>
        </div>
        <div id="leaderboard-list" class="space-y-3">
          <!-- Rendered by JS -->
        </div>
        <div class="mt-8">
          <h4 class="font-display text-bounty-dark text-lg font-black mb-3">RECENT BOOKINGS</h4>
          <div id="bookings-list" class="space-y-2 text-sm">
            <p class="text-gray-400 text-center text-sm">No bookings logged yet.</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Admin Tab ── -->
  <div id="view-admin" class="view hidden bg-bounty-tan min-h-screen p-6">
    <div class="max-w-4xl mx-auto space-y-6">
      <div class="parchment rounded-xl p-6 card-shadow">
        <div class="font-display text-bounty-dark text-2xl font-black mb-4 flex items-center gap-2">
          <i class="fas fa-plus-square text-bounty-red"></i> POST A NEW PROPERTY
        </div>
        <form id="admin-form" class="grid grid-cols-1 md:grid-cols-2 gap-4" onsubmit="addProperty(event)">
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Property Name *</label>
            <input type="text" id="a-name" required placeholder="e.g. Sunset Chalet"
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Priority Level *</label>
            <select id="a-priority" required class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm">
              <option value="top-bounty">Top Bounty</option>
              <option value="high-priority">High Priority</option>
              <option value="gap-killer">Gap Killer</option>
              <option value="standard">Standard</option>
            </select>
          </div>
          <div class="md:col-span-2">
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Why It's on the Board *</label>
            <input type="text" id="a-why" required placeholder="e.g. Too many open dates in June"
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Eligible Dates *</label>
            <input type="text" id="a-dates" required placeholder="e.g. June 1 – July 15"
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Min Stay (nights) *</label>
            <input type="number" id="a-minstay" required min="1" value="2"
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Bounty Per Night ($) *</label>
            <input type="number" id="a-pernite" required min="1" value="3"
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Cap Per Reservation ($) *</label>
            <input type="number" id="a-cap" required min="1" value="35"
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Bonus Amount ($)</label>
            <input type="number" id="a-bonus" min="0" value="15"
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Bonus Condition</label>
            <input type="text" id="a-boncond" placeholder="e.g. Fill a full calendar gap"
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm" />
          </div>
          <div class="md:col-span-2">
            <label class="block text-xs font-bold text-bounty-dark mb-1 uppercase">Photo URL</label>
            <input type="url" id="a-photo" placeholder="https://..."
              class="w-full border border-bounty-brown/30 rounded px-3 py-2 text-sm" />
          </div>
          <div class="md:col-span-2">
            <button type="submit" class="px-6 py-2.5 bg-bounty-red text-white font-black rounded uppercase tracking-wide hover:bg-red-800 transition-all text-sm">
              <i class="fas fa-thumbtack mr-1"></i> Post to Board
            </button>
          </div>
        </form>
      </div>

      <!-- Manage Existing Properties -->
      <div class="parchment rounded-xl p-6 card-shadow">
        <div class="font-display text-bounty-dark text-2xl font-black mb-4 flex items-center gap-2">
          <i class="fas fa-tasks text-bounty-blue"></i> MANAGE PROPERTIES
        </div>
        <div id="admin-prop-list" class="space-y-3">
          <!-- Rendered by JS -->
        </div>
      </div>

      <!-- Manage Bookings -->
      <div class="parchment rounded-xl p-6 card-shadow">
        <div class="font-display text-bounty-dark text-2xl font-black mb-4 flex items-center gap-2">
          <i class="fas fa-clipboard-check text-bounty-green"></i> REVIEW BOOKINGS
        </div>
        <div id="admin-booking-list" class="space-y-3">
          <p class="text-gray-400 text-sm text-center">No bookings submitted yet.</p>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Footer ── -->
  <footer class="bg-bounty-dark text-bounty-tan/50 text-center text-xs py-4 border-t border-bounty-gold/20">
    More Bookings &bull; Happier Owners &bull; Better Together &bull; Book It. Earn It. Own It.
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
    b.classList.add('text-bounty-tan/70');
  });
  document.getElementById('view-' + name).classList.remove('hidden');
  const btn = document.getElementById('tab-' + name);
  btn.classList.add('nav-active');
  btn.classList.remove('text-bounty-tan/70');
  btn.classList.add('text-bounty-tan');
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
  'top-bounty':   { badge: 'WANTED',        ribbon: 'wanted-ribbon',   pin: 'pin-red',    badgeCls: 'badge-top'  },
  'high-priority':{ badge: 'HIGH PRIORITY', ribbon: 'priority-ribbon', pin: 'pin-yellow', badgeCls: 'badge-high' },
  'gap-killer':   { badge: 'GAP KILLER',    ribbon: 'gap-ribbon',      pin: 'pin-blue',   badgeCls: 'badge-gap'  },
  'standard':     { badge: 'OPEN',          ribbon: 'std-ribbon',      pin: 'pin-green',  badgeCls: 'badge-std'  },
};

// ── Board Render ───────────────────────────────────────────────────────────────
function renderBoard() {
  const grid = document.getElementById('property-grid');
  const active = allProperties.filter(p => p.status === 'active');
  document.getElementById('stat-active').textContent = active.length;

  if (active.length === 0) {
    grid.innerHTML = '<p class="col-span-3 text-center text-bounty-brown/60 py-12 text-lg font-display">No active bounties right now. Check back soon!</p>';
    return;
  }

  grid.innerHTML = active.map(p => {
    const pr = PRIORITY[p.priority] || PRIORITY['standard'];
    const maxBounty = p.cap;
    return \`
    <div class="parchment rounded-lg overflow-hidden card-shadow relative" style="transform: rotate(\${(Math.random()-0.5)*1.5}deg)">
      <div class="\${pr.pin} pushpin"></div>
      <div class="\${pr.ribbon} text-white text-xs font-black px-6 py-1.5 text-center tracking-widest">\${pr.badge}</div>
      \${p.photo ? \`<img src="\${p.photo}" alt="\${p.name}" class="w-full h-44 object-cover" onerror="this.style.display='none'" />\` : ''}
      <div class="p-4">
        <div class="font-display text-bounty-dark text-xl font-black leading-tight mb-3">\${p.name}</div>
        <div class="space-y-1.5 text-xs text-gray-600 mb-4">
          <div class="flex gap-2 items-start"><i class="fas fa-fire-alt text-bounty-red w-3 mt-0.5"></i><span>\${p.why}</span></div>
          <div class="flex gap-2 items-center"><i class="fas fa-calendar-alt text-bounty-brown w-3"></i><span>\${p.eligibleDates}</span></div>
          <div class="flex gap-2 items-center"><i class="fas fa-moon text-bounty-blue w-3"></i><span>Min Stay: \${p.minStay} nights</span></div>
        </div>
        <div class="bounty-strip text-white rounded-lg p-3 mb-2">
          <div class="text-white/60 text-xs uppercase tracking-wide mb-0.5">Bounty</div>
          <div class="flex items-baseline gap-1">
            <span class="font-display text-3xl font-black text-bounty-gold">$\${p.bountyPerNight}</span>
            <span class="text-xs text-white/70">per paid night booked</span>
          </div>
          \${p.bonusAmount > 0 ? \`
          <div class="bonus-box mt-2 rounded px-2 py-1.5 flex justify-between items-center">
            <span class="text-xs font-bold">+ $\${p.bonusAmount} BONUS</span>
            <span class="text-xs text-white/80">\${p.bonusCondition}</span>
          </div>\` : ''}
          <div class="text-right text-xs text-white/40 mt-1.5">Cap: $\${p.cap} per reservation</div>
        </div>
        <button onclick="showTab('submit')" class="w-full py-2 bg-bounty-red text-white font-black text-xs rounded uppercase tracking-wide hover:bg-red-800 transition-all">
          <i class="fas fa-crosshairs mr-1"></i> Claim This Bounty
        </button>
      </div>
    </div>
    \`;
  }).join('');
}

// ── Leaderboard Render ─────────────────────────────────────────────────────────
function renderLeaderboard() {
  const medals = ['🥇','🥈','🥉'];
  const list = document.getElementById('leaderboard-list');
  if (allLeaderboard.length === 0) {
    list.innerHTML = '<p class="text-center text-gray-400 text-sm">No earners yet. Be the first!</p>';
  } else {
    list.innerHTML = allLeaderboard.map((l, i) => \`
    <div class="flex items-center gap-4 bg-white/60 rounded-lg px-4 py-3 border border-bounty-brown/10">
      <span class="text-2xl">\${medals[i] || (i+1)+'.'}</span>
      <div class="flex-1">
        <div class="font-bold text-bounty-dark">\${l.name}</div>
        <div class="text-xs text-gray-500">\${l.bookings} booking\${l.bookings !== 1 ? 's' : ''} logged</div>
      </div>
      <div class="text-right">
        <div class="font-display text-xl font-black text-bounty-red">$\${l.total}</div>
        <div class="text-xs text-gray-500">earned</div>
      </div>
    </div>\`).join('');
  }

  const bList = document.getElementById('bookings-list');
  if (allBookings.length === 0) {
    bList.innerHTML = '<p class="text-gray-400 text-center text-sm">No bookings logged yet.</p>';
  } else {
    bList.innerHTML = allBookings.slice().reverse().map(b => {
      const prop = allProperties.find(p => p.id === b.propertyId);
      const statusCls = {pending:'bg-yellow-100 text-yellow-800', cleared:'bg-green-100 text-green-800', disqualified:'bg-red-100 text-red-800'}[b.status] || '';
      return \`<div class="flex items-center justify-between bg-white/60 rounded px-3 py-2 border border-bounty-brown/10">
        <div>
          <span class="font-bold text-bounty-dark text-xs">\${b.agentName}</span>
          <span class="text-gray-400 text-xs"> – \${prop ? prop.name : b.propertyId}</span>
          <div class="text-xs text-gray-500">\${b.nights} nights | Check-in: \${b.checkIn}</div>
        </div>
        <div class="text-right">
          <div class="font-black text-bounty-red">$\${b.totalEarned}</div>
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
    propList.innerHTML = '<p class="text-gray-400 text-sm text-center">No properties posted yet.</p>';
  } else {
    propList.innerHTML = allProperties.map(p => {
      const stCls = {active:'status-active', filled:'status-filled', expired:'status-expired'}[p.status] || '';
      const pr = PRIORITY[p.priority] || PRIORITY['standard'];
      return \`<div class="flex items-center justify-between bg-white/60 rounded-lg px-4 py-3 border border-bounty-brown/10">
        <div class="flex items-center gap-3">
          <span class="\${pr.badgeCls} text-white text-xs font-bold px-2 py-0.5 rounded">\${pr.badge}</span>
          <div>
            <div class="font-bold text-bounty-dark text-sm">\${p.name}</div>
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
          <button onclick="deleteProp('\${p.id}')" class="text-xs bg-red-100 text-red-600 hover:bg-red-200 px-2 py-1 rounded transition-all">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>\`;
    }).join('');
  }

  const bList = document.getElementById('admin-booking-list');
  if (allBookings.length === 0) {
    bList.innerHTML = '<p class="text-gray-400 text-sm text-center">No bookings submitted yet.</p>';
  } else {
    bList.innerHTML = allBookings.slice().reverse().map(b => {
      const prop = allProperties.find(p => p.id === b.propertyId);
      const statusCls = {pending:'bg-yellow-100 text-yellow-800', cleared:'bg-green-100 text-green-800', disqualified:'bg-red-100 text-red-800'}[b.status] || '';
      return \`<div class="flex flex-wrap items-start justify-between gap-2 bg-white/60 rounded-lg px-4 py-3 border border-bounty-brown/10">
        <div>
          <div class="font-bold text-bounty-dark text-sm">\${b.agentName} → \${prop ? prop.name : b.propertyId}</div>
          <div class="text-xs text-gray-500">Guest: \${b.guestName} | \${b.checkIn} – \${b.checkOut} | \${b.nights} nights | $\${b.rate}/night</div>
          <div class="text-xs text-gray-500 mt-0.5">
            Base: $\${b.baseBounty} + Bonuses: $\${b.bonusEarned} = <strong>$\${b.totalEarned}</strong>
            \${b.isLastMinute ? '<span class="ml-1 bg-red-100 text-red-700 px-1 rounded text-xs">Last Min</span>' : ''}
            \${b.isWeekend ? '<span class="ml-1 bg-yellow-100 text-yellow-700 px-1 rounded text-xs">Weekend</span>' : ''}
            \${b.isLongStay ? '<span class="ml-1 bg-blue-100 text-blue-700 px-1 rounded text-xs">Long Stay</span>' : ''}
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
