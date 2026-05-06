<script>
// ── Tab switching ──
function switchTab(i) {
  document.querySelectorAll('.tab-content').forEach((t,j) => t.classList.toggle('active', i===j));
  document.querySelectorAll('.tab').forEach((t,j) => t.classList.toggle('active', i===j));
}
// Reorder tabs: Onboarding (index 4) before ROI Model (index 5) — matches button bar order
(function() {
  var roi = document.getElementById('tab-roi');
  var ob  = document.getElementById('tab-onboarding');
  if (roi && ob && roi.parentNode) roi.parentNode.insertBefore(ob, roi);
})();

// ── Slide switching ──
function switchSlide(i) {
  document.querySelectorAll('.slide').forEach((s,j) => s.classList.toggle('active', i===j));
  document.querySelectorAll('.slide-dot').forEach((d,j) => d.classList.toggle('active', i===j));
}

/* ═══════════════════════════════════════════════════════════════════════════
   PERSONA POOLS — DO NOT MIX. Single source of truth. Never cross-reference.

   QS_CLIENTS      → existing Quantum Scaling clients.
                     Use ONLY in: case studies, social proof, testimonials.
                     NEVER in: webinar chat, attendee lists, booking messages.

   WEBINAR_PROSPECTS → lead-list prospects attending the webinar.
                       Use ONLY in: chat messages, attendee names, booking notifications.
                       NEVER in: case studies or client testimonials.
   ═══════════════════════════════════════════════════════════════════════════ */
const QS_CLIENTS = [
  { name: 'Sarah Chen',    firm: 'Meridian Advisory',  result: 'went from 100% referral-dependent to 847 registered attendees in her first webinar cycle' },
  { name: 'Derek Okonkwo', firm: 'Vantage Partners',   result: 'booked 31 qualified sales calls in Month 2 using this exact outreach system' },
  { name: 'Marcus Webb',   firm: 'Sterling Growth',    result: 'broke through a $1.8M plateau and reached $212K/month recurring within 6 months' },
  { name: 'Jordan Marsh',  firm: 'Pinnacle Growth Co.',result: 'scaled from 3 referrals/month to 22 inbound calls in 60 days' },
  { name: 'Alicia Fontaine',firm:'Meridian Advisory',  result: 'first webinar cycle generated 6 new clients at $42K average contract value' },
  { name: 'Tyler Breckenridge', firm: 'Northbrook Digital', result: '$1.1M in pipeline from a single 90-minute webinar run to 600 attendees' },
  { name: 'Priya Menon',   firm: 'Apex Revenue Labs',  result: 'Phase 1 alone identified 6,200 ICP-matched contacts her team had never reached' },
  { name: 'David Nakamura',firm: 'Horizon Strategy Group', result: 'Phase 2 outreach hit 31K contacts in Month 1, 14 calls booked in Week 3' },
  { name: 'Camille Rousseau', firm: 'Rousseau Consulting', result: 'close rate improved from 18% to 31% after adopting the 2-call structure' },
];

// Webinar prospects: attendees, chat participants, booking notifications.
// These are leads, NOT clients. Never use their names as case studies.
const WEBINAR_PROSPECTS = [
  { name: 'Nadia Caruso',    firm: 'Lumina Strategies',  init: 'Nadia C.' },
  { name: 'Sophie Whitfield', firm: 'Whitfield & Co.',   init: 'Sophie W.' },
  { name: 'Ryan Calloway',   firm: 'Calloway Advisors',  init: 'Ryan C.' },
];

// ── Variant switching ──
function descHTML(hook, cases, bullets) {
  return `<div class="cal-desc-cta">
  👉 <strong>Click Yes or Maybe</strong> to reserve your spot.<br>
  Click <strong>No</strong> and we'll remove you from this invite series.<br>
  🔗 <a href="#">Your registration link →</a>
</div>
<div class="cal-desc-hook">${hook}</div>
<div class="cal-desc-cases">
  <div class="cal-desc-cases-label">What clients built in their first 90 days</div>
  ${cases.map(c=>`<div class="cal-desc-case">${c}</div>`).join('')}
</div>
<div class="cal-desc-section">
  <div class="cal-desc-section-label">What You'll Walk Away With</div>
  <ul class="cal-desc-bullets">${bullets.map(b=>`<li>${b}</li>`).join('')}</ul>
</div>
<div class="cal-desc-meta">
  <span><strong>For:</strong> B2B consulting &amp; advisory founders · $1M–$5M revenue</span>
  <span><strong>Duration:</strong> 90 min + live Q&amp;A · Join link sent on confirmation</span>
</div>`;
}

// Helper: format a QS_CLIENTS entry as a case study line
function clientCase(c) {
  return `<strong>${c.name} (${c.firm})</strong> — ${c.result}.`;
}

const variants = [
  {
    tag: 'Problem-aware',
    title: 'Why 90% of Consulting Firms Plateau at $1.5M — and the Revenue System That Actually Breaks Through',
    desc: descHTML(
      'If 80% of your pipeline comes from referrals, you don\'t have a business — you have a dependency. In 90 minutes, I\'ll show you the exact system 1,400+ consulting firms used to break through the $1.5M ceiling and build predictable revenue that doesn\'t rely on who you know.',
      [clientCase(QS_CLIENTS[0]), clientCase(QS_CLIENTS[1]), clientCase(QS_CLIENTS[2])],
      [
        'Why the referral ceiling exists — and the 3-phase system that breaks through it',
        'How to run 30,000+ automated outreaches per month without cold calling or discounting',
        'Live funnel math built with your firm\'s specific numbers'
      ]
    )
  },
  {
    tag: 'Outcome-focused',
    title: 'The Webinar Funnel That Generated $500M+ for Consulting Firms — Live Training',
    desc: descHTML(
      'The same acquisition system behind $500M+ in client revenue — now live, with your numbers built in.',
      [clientCase(QS_CLIENTS[3]), clientCase(QS_CLIENTS[4]), clientCase(QS_CLIENTS[5])],
      [
        'The exact webinar funnel deployed across 1,400+ B2B firms — live, with your numbers',
        'How clients scaled from referral-dependent to 30K+ outreaches/month on autopilot',
        'Your 90-day revenue projection built live during the session'
      ]
    )
  },
  {
    tag: 'Mechanism-led',
    title: 'The 3-Phase Revenue Engine Replacing Referrals for $1M–$5M Consulting Firms',
    desc: descHTML(
      'Referrals work — until they don\'t. Here\'s the 3-phase system replacing them across 1,400+ consulting firms.',
      [clientCase(QS_CLIENTS[6]), clientCase(QS_CLIENTS[7]), clientCase(QS_CLIENTS[8])],
      [
        'Phase 1: Market identification — pull your exact ICP from a database of 87M+ contacts',
        'Phase 2: Automated webinar outreach — 30K+ targeted invites per month, zero cold calls',
        'Phase 3: Pipeline conversion — the exact call flow that closes 25%+ of booked calls'
      ]
    )
  }
];

function switchVariant(i) {
  [0,1,2].forEach(j => {
    const btn = document.getElementById('var-btn-' + j);
    if (j === i) {
      btn.style.background = '#1a73e8'; btn.style.borderColor = '#1a73e8'; btn.style.color = '#fff';
    } else {
      btn.style.background = '#fff'; btn.style.borderColor = '#dadce0'; btn.style.color = '#5f6368';
    }
  });
  document.getElementById('var-tag').textContent = variants[i].tag;
  document.getElementById('cal-title').textContent = variants[i].title;
  document.getElementById('cal-desc').innerHTML = variants[i].desc;
  document.getElementById('slide-title').textContent = variants[i].title;
  resetRsvp();
}

function resetRsvp() {
  ['rsvp-yes-btn','rsvp-no-btn','rsvp-maybe-btn'].forEach(id => {
    const b = document.getElementById(id);
    b.classList.remove('confirmed-yes','confirmed-no','confirmed-maybe');
    b.textContent = id === 'rsvp-yes-btn' ? 'Yes' : id === 'rsvp-no-btn' ? 'No' : 'Maybe';
  });
  document.getElementById('rsvp-confirmed').style.display = 'none';
  document.getElementById('email-side-panel').classList.remove('open');
}

function setRsvp(btn, type) {
  ['rsvp-yes-btn','rsvp-no-btn','rsvp-maybe-btn'].forEach(id => {
    document.getElementById(id).classList.remove('confirmed-yes','confirmed-no','confirmed-maybe');
  });
  if (type === 'yes') {
    btn.classList.add('confirmed-yes');
    btn.textContent = '✓ Going';
    document.getElementById('rsvp-confirmed').style.display = 'block';
    document.getElementById('email-side-panel').classList.add('open');
  } else if (type === 'no') {
    btn.classList.add('confirmed-no');
    btn.textContent = '✗ Not Going';
    document.getElementById('rsvp-confirmed').style.display = 'none';
    document.getElementById('email-side-panel').classList.remove('open');
  } else {
    btn.classList.add('confirmed-maybe');
    btn.textContent = '? Maybe';
    document.getElementById('rsvp-confirmed').style.display = 'none';
    document.getElementById('email-side-panel').classList.remove('open');
  }
}

// ── ROI Model (3-slide) ──
function fmt(n) {
  if (n >= 1000000) return '$' + (n/1000000).toFixed(1).replace(/\.0$/,'') + 'M';
  if (n >= 1000) return '$' + Math.round(n/1000) + 'K';
  return '$' + Math.round(n).toLocaleString();
}
function fmtN(n) { return Math.round(n).toLocaleString(); }
function parseKM(v) {
  if (v == null || v === '') return null;
  const m = String(v).replace(/[$,\s]/g, '').match(/(\d+(?:\.\d+)?)(k|m)?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') n *= 1000;
  if (unit === 'm') n *= 1000000;
  return isNaN(n) ? null : Math.round(n);
}
function normalizeDomain(value) {
  return value ? String(value).replace(/^https?:\/\//, '').split('/')[0] : '';
}

// ── Prospect config (set per prospect before sharing) ──
const PROSPECT = { name: 'Acme Corp', domain: 'acme.com' };

// ── QS benchmark rate ranges ──
const RATES = {
  attend:  { conservative: 0.003, aggressive: 0.005 },  // 0.3% vs 0.5%
  booking: { conservative: 0.14,  aggressive: 0.22  },  // 14% vs 22%
  show:    { conservative: 0.65,  aggressive: 0.80  },  // 65% vs 80%
  close:   { conservative: 0.20,  aggressive: 0.30  },  // 20% vs 30%
};
let _modes = { attend: 'conservative', booking: 'conservative', show: 'conservative', close: 'conservative' };

let MONTHLY_INVITES = 30000;

// Ramp: index = month (1-based). Month 1 = onboarding (0). Full velocity Month 6+.
const RAMP = [0, 0, 0.10, 0.25, 0.45, 0.70, 1, 1, 1, 1, 1, 1, 1];

let _roiSlide = 0;

function roiGoSlide(n) {
  _roiSlide = n;
  document.getElementById('roi-track').style.transform = `translateX(-${n * 100}%)`;
  [0,1,2].forEach(i => {
    document.getElementById('roi-s' + i).classList.toggle('active', i === n);
  });
}

function toggleMode(step, mode) {
  _modes[step] = mode;
  ['conservative', 'aggressive'].forEach(m => {
    const btn = document.getElementById('m-' + step + '-' + m[0]);
    if (btn) btn.classList.toggle('active', m === mode);
  });
  roiCalc();
}

// ── parseKM — safely parse any format: 75000, "75K", "$75,000", "75K80K" ──
function parseKM(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[$,\s]/g, '');
  // Take the first valid number+optional K/M unit found (ignores trailing garbage)
  const m = s.match(/(\d+(?:\.\d+)?)(k|m)?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') n *= 1000;
  if (unit === 'm') n *= 1000000;
  return isNaN(n) ? null : Math.round(n);
}

function roiCalc() {
  const ltv         = parseFloat(document.getElementById('ltv').value) || 0;
  const attendRate  = RATES.attend[_modes.attend];
  const bookingRate = RATES.booking[_modes.booking];
  const showRate    = (parseFloat(document.getElementById('show-rate').value) || 75) / 100;
  const closeRate   = (parseFloat(document.getElementById('close-rate').value) || 25) / 100;

  document.getElementById('r-show-pill').textContent  = Math.round(showRate * 100) + '% show up to the call';
  document.getElementById('r-close-pill').textContent = Math.round(closeRate * 100) + '% close';

  const vol         = Math.max(1, isNaN(MONTHLY_INVITES) ? 30000 : MONTHLY_INVITES);
  const attendees   = Math.round(vol * attendRate);
  const booked      = Math.round(attendees * bookingRate);
  const held        = Math.round(booked * showRate);
  const clients     = Math.round(held * closeRate);
  const monthly     = clients * ltv;
  const annual      = monthly * 12;

  document.getElementById('r-attendees').textContent = fmtN(attendees);
  document.getElementById('r-booked').textContent    = fmtN(booked);
  document.getElementById('r-held').textContent      = fmtN(held);
  document.getElementById('r-clients').textContent   = fmtN(clients);

  // Proportional bar widths (attendees anchored to 70%)
  const base = attendees || 1;
  document.getElementById('rfb-2').style.width = '70%';
  document.getElementById('rfb-3').style.width = Math.max(8, Math.round(70 * booked  / base)) + '%';
  document.getElementById('rfb-4').style.width = Math.max(5, Math.round(70 * held    / base)) + '%';
  document.getElementById('rfb-5').style.width = Math.max(3, Math.round(70 * clients / base)) + '%';

  document.getElementById('r-monthly').textContent = monthly > 0 ? fmt(monthly) : '—';
  document.getElementById('r-annual').textContent  = annual  > 0 ? fmt(annual)  : '—';

  // Build 12-month ramp table
  const tbody = document.getElementById('ramp-body');
  tbody.innerHTML = '';
  let cumulative = 0; let cum6 = 0;
  for (let m = 1; m <= 12; m++) {
    const ramp      = RAMP[m] || 0;
    const mClients  = clients * ramp;
    const mRev      = mClients * ltv;
    cumulative += mRev;
    if (m === 6) cum6 = cumulative;
    const hasRev        = mRev > 0.5;
    const isOnboarding  = m === 1;
    const isRamp        = !isOnboarding && ramp > 0 && ramp < 1;
    const tag = isOnboarding
      ? `<span class="ramp-ramp-tag">ONBOARDING</span>`
      : isRamp ? `<span class="ramp-ramp-tag">RAMP</span>` : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>Month ${m}${tag}</td>
      <td class="${hasRev ? 'has-rev' : ''}">${hasRev ? fmtN(Math.round(mClients)) : '—'}</td>
      <td class="${hasRev ? 'has-rev' : ''}">${hasRev ? fmt(mRev) : '—'}</td>
      <td class="${cumulative > 0.5 ? 'cumul' : ''}">${cumulative > 0.5 ? fmt(cumulative) : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
  document.getElementById('total-12m').textContent = cumulative > 0 ? fmt(cumulative) : '—';
  document.getElementById('ret-6m').textContent  = cum6      > 0 ? fmt(cum6)      : '—';
  document.getElementById('ret-12m').textContent = cumulative > 0 ? fmt(cumulative) : '—';
}

function roiCalcAndNext() {
  roiCalc();
  roiGoSlide(1);
}

// ── Case Studies dual filter (stage × industry) ──
let _csStage = 'all', _csIndustry = 'all';
function csFilter(type, value) {
  if (type === 'stage') _csStage = value;
  else _csIndustry = value;
  document.querySelectorAll('.cs-filter').forEach(b => b.classList.toggle('active', b.dataset.v === _csStage));
  document.querySelectorAll('.cs-industry-btn').forEach(b => b.classList.toggle('active', b.dataset.v === _csIndustry));
  document.querySelectorAll('.cs-card').forEach(card => {
    const stageOk    = _csStage    === 'all' || card.dataset.stage    === _csStage;
    const industryOk = _csIndustry === 'all' || card.dataset.industry === _csIndustry;
    card.style.display = (stageOk && industryOk) ? '' : 'none';
  });
}

// ── Case Study Modal ──
const CS_RESULTS = {
  early: {
    consulting: 'Went from inconsistent project-based income to a predictable acquisition system — first recurring $15–25K months within the first 6 months.',
    software:   'Broke through early-stage stagnation with a webinar funnel that consistently generated qualified demo bookings, hitting first $100K ARR.',
    coaching:   'Moved away from referral dependence and built a scalable webinar-to-close system that filled their first cohort within weeks.',
    agencies:   'Landed first retainer clients through a structured outreach-to-webinar sequence, creating a repeatable new business pipeline.',
    other:      'Built first predictable revenue channel, transitioning from project-based sporadic income to consistent monthly client acquisition.',
  },
  growth: {
    consulting: 'Scaled from $150K to $400K+ annually by systematizing their webinar funnel and implementing a two-call close process.',
    software:   'Grew from $100K to $450K ARR by adding a webinar-driven top-of-funnel that filled their pipeline with pre-educated prospects.',
    coaching:   'Broke the $300K ceiling with a high-ticket webinar offer and automated follow-up that kept show rates above 60%.',
    agencies:   'Scaled retainer revenue from $120K to $480K by adding a scalable acquisition system that reduced reliance on referrals.',
    other:      'Scaled past $300K by building a repeatable webinar-based acquisition engine that consistently generated qualified sales calls.',
  },
  scale: {
    consulting: 'Crossed the $1M revenue mark by systematizing their entire sales process — from ad spend to close — with a predictable webinar funnel.',
    software:   'Reached $1M+ ARR after implementing a webinar-led growth system that shortened sales cycles and improved close rates by 40%.',
    coaching:   'Built a $1M+ coaching business with a high-converting webinar program that maintained a 70%+ Call 2 show rate.',
    agencies:   'Scaled to $1.2M in retainer revenue by adding a structured acquisition system that consistently filled the pipeline.',
    other:      'Hit $1M+ revenue with a systematized sales and marketing engine that produced consistent new client acquisition month over month.',
  },
  large: {
    consulting: 'Added $1.5M+ in incremental revenue without increasing headcount — by optimizing their existing funnel and improving close rates.',
    software:   'Grew from $3M to $5M ARR through a systematic expansion of their webinar-driven acquisition machine into new market segments.',
    coaching:   'Added $2M in revenue by scaling their proven webinar system into new audiences while maintaining their premium positioning.',
    agencies:   'Expanded from $2M to $4M in billings by systematizing their sales process and reducing dependency on founder-led selling.',
    other:      'Added significant incremental revenue to an already established business by introducing systematic outbound and webinar acquisition.',
  },
};

const CS_INDUSTRY_LABELS = {
  consulting: 'Consulting & Professional Services',
  software:   'Software',
  coaching:   'Coaching & Training',
  agencies:   'Agencies',
  other:      'Other B2B',
};

const CS_STAGE_LABELS = {
  early:  'Early Stage',
  growth: 'Growth Stage',
  scale:  'Scale Stage',
  large:  'Large Stage',
};

// ── Per-client real data (sourced from QS Proof Library & due-diligence page) ──
const CS_CLIENTS = {
  'Forrest Dombrow': { company:'Profitable by Design', before:'$0/year', after:'$500K/year', metric:'Built from zero', result:'Built his first predictable client acquisition system from scratch — scaling from zero to $500K/year through a systematic webinar-to-close funnel.', quote:null },
  'Tejas Parikh': { company:'Akshar Business Consulting', before:'$36K/year · 0 calls/month', after:'$1M/year · 10 calls/month', metric:'27× revenue in 6 months', result:'Scaled 27× in 6 months — $36K to $1M/year. Won 4 × $100K enterprise contracts targeting CFOs at mid-market companies. Named LinkedIn Top Voice in Budgeting. 270+ webinar attendees/month.', quote:'"The webinar system just works for large deals with C-Level in the enterprise."' },
  'Simon Mueller': { company:'Mantaro Brands', before:'€0 · 1 sales call/month', after:'€12M ARR in 2 years', metric:'Sold at high 8-figure valuation', result:'Built from €0 to €12M ARR in just 2 years. Secured a €20M Series A and ultimately exited at a high 8-figure valuation. 20 sales calls/month, 120+ webinar attendees/month.', quote:'"The combination of superstar coaches, cutting-edge knowledge, and an inspiring community was key to scaling from €0 to €12M in 2 years."' },
  'Philipp Von Schulthess': { company:'Oxoia', before:'$120K/year · Referrals only', after:'$1M/year', metric:'8.3× revenue · $250K from first webinar', result:'Closed a $250K contract from his very first webinar and secured a major strategic partnership. Scaled from $120K to $1M/year with no prior repeatable acquisition system.', quote:null },
  'Cedric Le Rouzo': { company:'Cinna Mon Consulting', before:'$30K/month · 40 hrs/mo on lead gen', after:'$250K/month · 3 hrs/mo to run', metric:'35× ROI in year one · $2M ARR', result:'Transformed from $30K to $250K/month in 6 months — eventually reaching $2M ARR. Lead gen time dropped 40 hrs → 3 hrs/month. Cost per sales call: $2,000 → $10. 100K calendar invites → 500 live attendees → 100 booked calls/month.', quote:null },
  'Brooks Golden': { company:'High Performing Coach', before:'$500K/month · 5% close rate', after:'$2M/month · 20% close rate', metric:'4× revenue in first month · 90% cost reduction', result:'Quadrupled revenue in the first month — $500K to $2M/month. Lead gen costs dropped 90%. Close rate jumped from 5% to 20%. 250+ live webinar attendees/month, 50 sales calls/month.', quote:'"Within the first months we already 4Xed our revenue and then we consistently improved our closing rate."' },
  'Nick Uresin': { company:'The Podcast Pros', before:'€0/year', after:'€480K/year', metric:'Full business built from scratch', result:'Built The Podcast Pros from zero to €480K/year using the webinar acquisition system as the primary growth engine from day one.', quote:null },
  'Felix Petzel': { company:'Panda Media', before:'€25K/month · 30% margins', after:'€75K/month · 90% margins', metric:'14× pipeline · 95% lower lead gen costs', result:'Tripled revenue from €25K to €75K/month while margins surged from 30% to 90% as lead gen costs fell 95%. 600+ webinar attendees/month. Sales calls grew from 3 to 40/month.', quote:'"Our costs dropped by 95%, margins surged to 90%. Their expertise exceeded expectations."' },
  'Bora Ger': { company:'Bora Ger Consulting', before:'$60K/year · 3 calls/month', after:'$360K/year · 15 calls/month', metric:'6× revenue · 4M content views', result:'Scaled 6× from $60K to $360K/year. Generated 4 million content views, 300+ live webinar attendees/month, and now receives daily inbound partnership requests and speaking invitations.', quote:'"The learning & long-term effect was exponential for me."' },
  'Jason Rotman': { company:'Elevate Financial Partners', before:'$120K/year · Sporadic leads', after:'$360K/year · 62 calls/month', metric:'3× revenue · 400+ webinar attendees/mo', result:'Tripled revenue from $120K to $360K/year. Now generates 62 qualified sales calls/month from 400+ live webinar attendees — serving high-net-worth individuals, founders, and executives.', quote:'"It was the solution I was seeking to talk to high quality leads every day...It\'s like a machine now."' },
  'Lynn Rousseau': { company:'The Conscious Leader', before:'$300K/year · 20+ years on referrals', after:'$600K/year · 44 calls/month', metric:'2× revenue · 287 registrations on first webinar', result:'After 20+ years building exclusively through referrals, launched a webinar that delivered 287 registrations on the first run. Doubled annual revenue from $300K to $600K.', quote:null },
};

function csModalOpen(card) {
  const name     = card.querySelector('.cs-card-name').textContent;
  const photo    = card.querySelector('.cs-card-photo').src;
  const stage    = card.dataset.stage;
  const industry = card.dataset.industry;
  const client   = CS_CLIENTS[name] || null;

  document.getElementById('cs-modal-photo').src = photo;
  document.getElementById('cs-modal-name').textContent = name;

  const companyEl = document.getElementById('cs-modal-company');
  companyEl.textContent = client?.company || '';
  companyEl.style.display = client?.company ? '' : 'none';

  const pills = document.getElementById('cs-modal-pills');
  pills.innerHTML = `
    <span class="cs-stage-pill ${stage}" style="margin-top:6px">${CS_STAGE_LABELS[stage]}</span>
    <span style="font-size:11px;color:#52525b;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:4px 10px;margin-top:6px;">${CS_INDUSTRY_LABELS[industry]}</span>
  `;

  const statsEl = document.getElementById('cs-modal-stats');
  if (client?.before && client?.after) {
    document.getElementById('cs-modal-before').textContent = client.before;
    document.getElementById('cs-modal-after').textContent = client.after;
    statsEl.style.display = 'flex';
  } else { statsEl.style.display = 'none'; }

  const metricEl = document.getElementById('cs-modal-metric');
  if (client?.metric) { metricEl.textContent = client.metric; metricEl.style.display = 'inline-block'; }
  else { metricEl.style.display = 'none'; }

  document.getElementById('cs-modal-result').textContent = client?.result || CS_RESULTS[stage]?.[industry] || CS_RESULTS[stage]?.other || '';

  const quoteEl = document.getElementById('cs-modal-quote');
  if (client?.quote) { quoteEl.textContent = client.quote; quoteEl.style.display = ''; }
  else { quoteEl.style.display = 'none'; }

  document.getElementById('cs-modal-overlay').classList.add('open');
}

function csModalClose() {
  document.getElementById('cs-modal-overlay').classList.remove('open');
}

// Wire up click handlers on all cs-cards (document delegation — works in all browsers)
document.addEventListener('click', function(e) {
  var card = e.target.closest && e.target.closest('.cs-card');
  if (card) csModalOpen(card);
});

switchVariant(0);

// ── Prospect branding — injects brand assets from brand_data into portal ─────
// brand_data is populated by the brand_scrape task (logo, colors, tagline, images)
function applyProspectBranding(brandData) {
  // 1. Company name labels
  const label = document.getElementById('prospect-label');
  const preparedFor = document.querySelector('.prepared-for');
  if (label) label.textContent = PROSPECT.name;
  if (preparedFor) preparedFor.textContent = 'Prepared for ' + PROSPECT.name;

  // 2. Logo/favicon in webinar top bar — use scraped logo_url, fall back to Google Favicon
  const faviconEl = document.getElementById('prospect-favicon');
  const brandDomain = brandData?.domain || PROSPECT.domain || (PROSPECT.email ? PROSPECT.email.split('@')[1] : null);
  const logoSrc = brandData?.logo_url || (brandDomain ? `https://www.google.com/s2/favicons?domain=${brandDomain}&sz=128` : null);
  if (faviconEl && logoSrc) {
    faviconEl.src = logoSrc;
    faviconEl.style.cssText = 'width:18px;height:18px;border-radius:3px;object-fit:contain;display:inline-block;vertical-align:middle;';
    faviconEl.onerror = () => {
      if (brandDomain) faviconEl.src = `https://www.google.com/s2/favicons?domain=${brandDomain}&sz=64`;
      else faviconEl.style.display = 'none';
    };
  }

  // ── Helper: check if a color is near-white/near-black/gray and thus useless ──
  const isUselessColor = (c) => {
    if (!c || typeof c !== 'string') return true;
    const hex = c.replace('#','');
    if (hex.length < 6) return true;
    const r = parseInt(hex.substr(0,2), 16), g = parseInt(hex.substr(2,2), 16), b = parseInt(hex.substr(4,2), 16);
    const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
    if (lum > 0.92 || lum < 0.08) return true; // near white or near black
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    if ((max - min) < 20) return true; // gray (no saturation)
    return false;
  };

  // 3. CSS color variables — applied to webinar UI accents
  // Use primary_color unless it's near-white/black, then try secondary, then accent, then all_colors
  let effectivePrimary = null;
  if (brandData?.primary_color && !isUselessColor(brandData.primary_color)) effectivePrimary = brandData.primary_color;
  else if (brandData?.secondary_color && !isUselessColor(brandData.secondary_color)) effectivePrimary = brandData.secondary_color;
  else if (brandData?.accent_color && !isUselessColor(brandData.accent_color)) effectivePrimary = brandData.accent_color;
  else if (brandData?.all_colors?.length) {
    effectivePrimary = brandData.all_colors.find(c => !isUselessColor(c)) || null;
  }
  let effectiveSecondary = null;
  if (effectivePrimary) {
    const candidates = [brandData?.secondary_color, brandData?.accent_color, ...(brandData?.all_colors || [])];
    effectiveSecondary = candidates.find(c => c && c !== effectivePrimary && !isUselessColor(c)) || effectivePrimary;
  }

  if (effectivePrimary) {
    document.documentElement.style.setProperty('--prospect-primary', effectivePrimary);
    document.documentElement.style.setProperty('--prospect-secondary', effectiveSecondary || effectivePrimary);
    // Alpha variants for glow effects
    const hex = effectivePrimary.replace('#','');
    const r = parseInt(hex.substr(0,2),16), g = parseInt(hex.substr(2,2),16), b = parseInt(hex.substr(4,2),16);
    document.documentElement.style.setProperty('--prospect-primary-alpha', `rgba(${r},${g},${b},0.18)`);
    document.documentElement.style.setProperty('--prospect-primary-half', `rgba(${r},${g},${b},0.5)`);
    if (effectiveSecondary && effectiveSecondary !== effectivePrimary) {
      const h2 = effectiveSecondary.replace('#','');
      const r2 = parseInt(h2.substr(0,2),16), g2 = parseInt(h2.substr(2,2),16), b2 = parseInt(h2.substr(4,2),16);
      document.documentElement.style.setProperty('--prospect-secondary-alpha', `rgba(${r2},${g2},${b2},0.12)`);
    }
    console.log('[Deal Forge] Brand colors applied: primary=' + effectivePrimary + ' secondary=' + (effectiveSecondary||'same'));
  }

  // 4. Hero image — set as slide 1 background
  const heroImg = brandData?.images?.find(img => img.type === 'hero') || brandData?.images?.[0];
  const slideEl = document.getElementById('slide-1-el');
  const overlayEl = document.getElementById('slide-1-overlay');
  if (heroImg?.url && slideEl) {
    slideEl.style.backgroundImage = `url('${heroImg.url}')`;
    slideEl.style.backgroundSize = 'cover';
    slideEl.style.backgroundPosition = 'center';
    if (overlayEl) {
      // Tint the overlay with the prospect's primary color
      if (effectivePrimary) {
        const hex = effectivePrimary.replace('#','');
        const r = parseInt(hex.substr(0,2),16), g = parseInt(hex.substr(2,2),16), b = parseInt(hex.substr(4,2),16);
        overlayEl.style.background = `linear-gradient(180deg, rgba(${r},${g},${b},0.7) 0%, rgba(0,0,0,0.65) 50%, rgba(${r},${g},${b},0.5) 100%)`;
      }
      overlayEl.style.display = 'block';
    }
    console.log('[Deal Forge] Hero image applied to webinar slide:', heroImg.url);
  }

  // 5. Logo on slide 1 — brand's real logo
  const slideLogo = document.getElementById('slide-brand-logo');
  if (slideLogo && brandData?.logo_url) {
    slideLogo.src = brandData.logo_url;
    slideLogo.style.display = 'block';
    slideLogo.onerror = () => { slideLogo.style.display = 'none'; };
  }

  // 6. Tagline on slide 1 sub-tag
  if (brandData?.tagline) {
    const slideTag = document.getElementById('slide-tag');
    if (slideTag) {
      slideTag.textContent = brandData.tagline.slice(0, 60) + (brandData.tagline.length > 60 ? '…' : '');
      slideTag.title = brandData.tagline; // full text on hover
    }
  }

  // 7. "Presented for" attribution in slide 1 footer
  const prospectAttr = document.getElementById('prospect-attribution');
  if (prospectAttr) {
    prospectAttr.textContent = `Presented for ${brandData?.company_name || PROSPECT.name}`;
    prospectAttr.style.display = 'block';
  }
}

// ── Asset button injector ─────────────────────────────────────────────────────
function showAssetButton(anchorId, url, label) {
  var existing = document.getElementById(anchorId);
  if (existing) { existing.href = url; return; }
  // Find the right container to attach asset links
  const targets = {
    'roi-asset-btn':           '.roi-section, .roi-calculator, [data-section="roi"]',
    'calendar-asset-btn':      '.cal-section, .calendar-event, [data-section="calendar"]',
    'webinar-mock-asset-btn':  '.webinar-section, .webinar-mock, [data-section="webinar"]'
  };
  const selector = targets[anchorId];
  const container = selector ? document.querySelector(selector) : null;
  const btn = document.createElement('a');
  btn.id = anchorId;
  btn.href = url;
  btn.target = '_blank';
  btn.rel = 'noopener';
  btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:8px 16px;background:#4f46e5;color:#fff;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;';
  btn.innerHTML = '↗ ' + label;
  if (container) { container.appendChild(btn); }
  else { console.log('[Deal Forge] Asset ready:', label, url); }
}

// ── Build session-compat object from new job API response ─────────────────────
function buildCompatSession(job) {
  const ext = Object.assign({}, job.extracted_data || {});
  const tasks = job.tasks || {};
  const meta = ext._meta || {};
  const existingGen = ext._generated || {};
  
  ext._generated = applyOverrides({
    webinarTitles:        (tasks.webinar_titles && tasks.webinar_titles.output) || existingGen.webinarTitles || null,
    leads:                existingGen.lead_list || tasks.lead_list?.output?.leads || [],      // Preserve rerun results
    apolloTotal:          existingGen.tam_total || tasks.lead_list?.output?.total || null,
    recommendedOutreach:  existingGen.recommendedOutreach || tasks.lead_list?.output?.recommendedOutreach || null,
    tamSource:            existingGen.tam_source || tasks.lead_list?.output?.tamSource || null,
    leadsTaskStatus:      tasks.lead_list?.status || existingGen.leadsTaskStatus || null,
    apollo_diagnostics:   existingGen.apollo_diagnostics || null
  }, ext._overrides);
  
  return {
    email:      job.prospect_email || '',
    domain:     normalizeDomain(job.prospect_website || ''),
    brand:      job.brand_data || null,
    research:   job.research_data || null,
    transcript: meta.transcript || { found: false },
    website:    meta.website    || { domain: job.prospect_website, scraped: false },
    extracted:  ext
  };
}

// ── Override precedence helper — reads rep edits over AI-generated values ─────
// Always prefer _overrides > _generated > defaults
function applyOverrides(gen, overrides) {
  if (!overrides) return gen;
  return {
    ...gen,
    apolloTotal:         overrides.tam_total         ?? gen.apolloTotal,
    recommendedOutreach: overrides.recommended_outreach ?? gen.recommendedOutreach,
    webinarTitleOverride: overrides.webinar_title    ?? null,
    roiLtv:              overrides.roi_ltv           ?? gen.roiLtv,
    roiShowRate:         overrides.roi_show_rate     ?? gen.roiShowRate,
    roiCloseRate:        overrides.roi_close_rate    ?? gen.roiCloseRate,
  };
}

// ── Edit mode helpers — declared at module scope so runPersonalization can use them ──
const IS_EDIT_MODE = new URLSearchParams(window.location.search).get('edit') === 'true';

async function saveOverride(field, value, displayEl) {
  const _jobId = new URLSearchParams(window.location.search).get('job');
  if (!_jobId) return;
  try {
    const r = await fetch('/api/jobs/' + encodeURIComponent(_jobId) + '/overrides', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: isNaN(Number(value)) ? value : Number(value) })
    });
    if (!r.ok) throw new Error('Save failed: ' + r.status);
    if (displayEl) displayEl.textContent = value;
    console.log('[Edit Mode] Saved override:', field, '=', value);
    
    // If TAM or outreach changed, we must recalculate all downstream metrics (cycle, bounds, ROI, badges)
    if ((field === 'tam_total' || field === 'recommended_outreach') && typeof window._reRunPersonalization === 'function') {
      const btn = displayEl && displayEl.nextSibling;
      if (btn && btn.tagName === 'BUTTON') {
        const oldText = btn.textContent;
        btn.textContent = '🔄';
        const freshRes = await fetch('/api/jobs/' + encodeURIComponent(_jobId));
        if (freshRes.ok) {
          const freshJob = await freshRes.json();
          const freshSession = typeof buildCompatSession === 'function' ? buildCompatSession(freshJob) : freshJob;
          window._reRunPersonalization(freshSession);
        }
        btn.textContent = oldText;
      }
    }
  } catch(e) {
    alert('Could not save override: ' + e.message);
  }
}

function addEditIcon(el, field, label) {
  if (!IS_EDIT_MODE || !el) return;
  // Prevent double-wiring if called again
  if (el.dataset.editWired) return;
  el.dataset.editWired = '1';
  el.classList.add('override-field');

  const btn = document.createElement('button');
  btn.className = 'override-edit-btn';
  btn.title = 'Edit ' + label;
  btn.style.cssText = 'background:none;border:none;cursor:pointer;color:#86efac;font-size:13px;margin-left:5px;vertical-align:middle;padding:0;opacity:0.8;';
  btn.textContent = '✏️';
  el.parentNode.insertBefore(btn, el.nextSibling);

  function activateEdit(e) {
    e.stopPropagation();
    if (el.parentNode.querySelector('.override-input')) return; // already open
    const current = el.textContent.trim();
    const input = document.createElement('input');
    input.className = 'override-input';
    input.value = current;
    input.style.width = Math.max(100, current.length * 12) + 'px';
    input.placeholder = label + '…';
    const done = () => {
      const v = input.value.trim();
      if (v && v !== current) saveOverride(field, v, el);
      if (input.parentNode) input.replaceWith(btn);
      el.style.display = '';
    };
    input.onblur = done;
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); done(); }
      if (ev.key === 'Escape') { if (input.parentNode) input.replaceWith(btn); el.style.display = ''; }
    };
    el.style.display = 'none';
    if (btn.parentNode) btn.parentNode.insertBefore(input, btn);
    setTimeout(() => { input.focus(); input.select(); }, 10);
  }

  el.addEventListener('click', activateEdit);
  btn.addEventListener('click', activateEdit);
}

// ── wireROIEditMode — makes the Monthly Funnel Breakdown numbers editable in edit mode ──
function wireROIEditMode() {
  if (!IS_EDIT_MODE) return;

  // ─ Monthly Outreach number — the main driver for all funnel calculations ─
  const fbarEl = document.getElementById('roi-fbar-monthly');
  if (fbarEl && !fbarEl.dataset.editWired) {
    fbarEl.dataset.editWired = '1';
    fbarEl.style.borderBottom = '1px dashed rgba(134,239,172,0.5)';
    fbarEl.style.cursor = 'pointer';
    fbarEl.title = 'Click to edit monthly outreach volume';
    fbarEl.addEventListener('click', function(e) {
      e.stopPropagation();
      if (fbarEl.parentNode && fbarEl.parentNode.querySelector('.override-input')) return;
      const current = Math.round(MONTHLY_INVITES);
      const input = document.createElement('input');
      input.className = 'override-input';
      input.type = 'number';
      input.value = current;
      input.style.cssText = 'width:130px;font-size:inherit;font-weight:inherit;text-align:right;';
      const done = () => {
        const v = parseInt(input.value, 10);
        if (!isNaN(v) && v > 0) {
          MONTHLY_INVITES = v;
          const vFull = v.toLocaleString();
          fbarEl.textContent = vFull;
          // Sync the locked pill on slide 0 and the funnel subtitle
          const lockedEl = document.getElementById('roi-locked-monthly');
          if (lockedEl) lockedEl.textContent = vFull;
          const subEl = document.getElementById('roi-funnel-sub');
          if (subEl) subEl.textContent = vFull + ' outreaches/month. Toggle each step conservative or aggressive to stress-test the numbers.';
          roiCalc();
          saveOverride('recommended_outreach', v, null);
        }
        if (input.parentNode) input.replaceWith(fbarEl);
        fbarEl.style.display = '';
      };
      input.onblur = done;
      input.onkeydown = ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); done(); }
        if (ev.key === 'Escape') { if (input.parentNode) input.replaceWith(fbarEl); fbarEl.style.display = ''; }
      };
      fbarEl.style.display = 'none';
      fbarEl.parentNode.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 10);
    });
  }

  // ─ LTV / Show Rate / Close Rate inputs — auto-save as overrides on change ─
  const roiInputs = [
    { id: 'ltv',        field: 'roi_ltv',        hint: 'Average Client LTV — changes save to this job' },
    { id: 'show-rate',  field: 'roi_show_rate',   hint: 'Sales Call Show Rate — changes save to this job' },
    { id: 'close-rate', field: 'roi_close_rate',  hint: 'Sales Close Rate — changes save to this job' },
  ];
  roiInputs.forEach(({ id, field, hint }) => {
    const inp = document.getElementById(id);
    if (!inp || inp.dataset.editWired) return;
    inp.dataset.editWired = '1';
    inp.title = hint;
    inp.style.borderColor = 'rgba(134,239,172,0.4)';
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v) && v > 0) saveOverride(field, v, null);
    });
  });
}

// ── Personalization from session / job data ───────────────────────────────────
(async function() {
  const params = new URLSearchParams(window.location.search);
  const jobId        = params.get('job');
  const sessionToken = params.get('session');

  // ── Edit mode — inject banner + CSS when IS_EDIT_MODE ──────────────────────
  if (IS_EDIT_MODE) {
    const banner = document.createElement('div');
    banner.id = 'edit-mode-banner';
    banner.innerHTML = '✏️ <strong>Editing Mode</strong> — Changes save instantly and only you can see this bar. <a href="' + window.location.href.replace('&edit=true','').replace('?edit=true','').replace('edit=true','') + '" target="_blank" style="color:#86efac;margin-left:12px;">Open Prospect View ↗</a>';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#166534;color:#dcfce7;font-size:13px;padding:8px 20px;text-align:center;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    document.body.prepend(banner);
    document.body.style.paddingTop = '40px';
    const style = document.createElement('style');
    style.textContent = `
      .override-edit-btn { display:inline-flex !important; }
      .override-field { border-bottom:1px dashed #86efac !important; cursor:pointer !important; }
      .override-field:hover { background:rgba(134,239,172,0.1) !important; border-radius:4px !important; }
      .override-input { background:#1e293b!important;color:#f1f5f9!important;border:1px solid #86efac!important;border-radius:6px!important;padding:4px 8px!important;font-size:inherit!important;width:auto!important;min-width:80px; }
    `;
    document.head.appendChild(style);
  }

  // ── saveOverride and addEditIcon are now module-level (defined above IIFE)

  // Nothing to personalize
  if (!jobId && !sessionToken) {
    applyProspectBranding(typeof SESSION !== "undefined" ? SESSION.brand : null);
    return;
  }

  // ── Legacy session path (backwards compat) ──────────────────────────────────
  if (!jobId && sessionToken) {
    try {
      const res = await fetch('/api/portal-data?session=' + encodeURIComponent(sessionToken));
      if (!res.ok) { applyProspectBranding(typeof SESSION !== "undefined" ? SESSION.brand : null); return; }
      const session = await res.json();
      runPersonalization(session);
    } catch(err) {
      console.warn('[Deal Forge] Legacy session load failed:', err.message);
      applyProspectBranding(typeof SESSION !== "undefined" ? SESSION.brand : null);
    }
    return;
  }

  // ── Job polling path ────────────────────────────────────────────────────────
  var extractApplied = false;
  var assetsChecked  = {};

  async function pollJob() {
    try {
      const res = await fetch('/api/jobs/' + encodeURIComponent(jobId));
      if (!res.ok) {
        setTimeout(pollJob, 5000);
        return;
      }
      const job = await res.json();
      const tasks = job.tasks || {};

      // ── Phase 1: Personalize immediately on first poll ─────────────────────
      // The brief is in job.extracted_data from the moment the job is created.
      // No need to wait for a separate extract task — the two-phase modal already
      // ran the extraction before job creation.
      if (!extractApplied) {
        extractApplied = true;
        const session = buildCompatSession(job);
        window.SESSION = session; // global — used by applyProspectBranding for brand assets
        runPersonalization(session);
      }

      // ── Phase 2: Update lead table + TAM when lead_list task settles ────────
      if (!assetsChecked['leads'] && tasks.lead_list) {
        const llStatus = tasks.lead_list.status;
        if (llStatus === 'completed') {
          assetsChecked['leads'] = true;
          const session2 = buildCompatSession(job);
          window.SESSION = session2;
          runPersonalization(session2);
          console.log('[Deal Forge] Lead list complete — personalization updated with real leads');
        } else if (llStatus === 'pending' || llStatus === 'processing') {
          // Update the loading row subtitle to show progress
          var loaderTitle = document.getElementById('lead-loader-title');
          var loaderSub   = document.getElementById('lead-loader-sub');
          if (loaderTitle) loaderTitle.textContent = llStatus === 'processing' ? 'Searching Apollo…' : 'Queued — waiting for extraction…';
          if (loaderSub)   loaderSub.textContent   = llStatus === 'processing' ? 'Validating ICP fit and filtering contacts' : 'Lead search will begin shortly';
        } else if (llStatus === 'failed' || llStatus === 'needs_input') {
          assetsChecked['leads'] = true;
          // Remove loading spinner and show error message
          var loadingRowErr = document.getElementById('leads-loading-row');
          if (loadingRowErr) {
            loadingRowErr.innerHTML = '<td colspan="8" style="text-align:center;padding:28px 0;color:#71717a;font-size:13px;">' +
              (llStatus === 'failed' ? 'Lead search failed — check Apollo API key or ICP filters' : 'Lead search needs input — check ICP fields in the brief') +
              '</td>';
          }
          console.log('[Deal Forge] Lead list ' + llStatus);
        }
      }

      // Asset URLs → inject "Open" buttons when ready (idempotent)
      if (!assetsChecked['roi'] && tasks.roi_model && tasks.roi_model.asset_url) {
        assetsChecked['roi'] = true;
        showAssetButton('roi-asset-btn', tasks.roi_model.asset_url, 'Open Interactive ROI Model');
      }
      if (!assetsChecked['cal'] && tasks.calendar_visual && tasks.calendar_visual.asset_url) {
        assetsChecked['cal'] = true;
        showAssetButton('calendar-asset-btn', tasks.calendar_visual.asset_url, 'Open Calendar Preview');
      }
      if (!assetsChecked['mock'] && tasks.webinar_mock && tasks.webinar_mock.asset_url) {
        assetsChecked['mock'] = true;
        showAssetButton('webinar-mock-asset-btn', tasks.webinar_mock.asset_url, 'Open Webinar Preview');
      }

      // Keep polling until job terminal
      if (job.status !== 'completed' && job.status !== 'failed') {
        setTimeout(pollJob, 3000);
      }
    } catch(err) {
      console.warn('[Deal Forge] Poll error:', err.message);
      setTimeout(pollJob, 5000);
    }
  }

  pollJob();
})();

// ── Populate Source Intelligence Panel ────────────────────────────────────────
function populateSourceIntelligence(session) {
  const ext   = session.extracted || {};
  const brand = session.brand     || null;
  const prospect    = ext.prospect  || {};
  const icp         = ext.icp       || {};
  const business    = Object.assign({}, ext.business || {}, ext.metrics || {});
  const transcriptFound = session.transcript?.found === true;
  const websiteScraped  = brand?.scraped === true;

  // Overall status label
  const statusEl = document.getElementById('si-overall-status');
  if (statusEl) {
    const parts = [];
    if (transcriptFound) parts.push('✅ Call data');
    else parts.push('⚠️ No transcript');
    if (websiteScraped)  parts.push('✅ Website scraped');
    else parts.push('⚠️ Website not scraped');
    statusEl.textContent = parts.join(' · ');
  }

  // Transcript badge
  const tBadge = document.getElementById('si-transcript-badge');
  if (tBadge) {
    tBadge.textContent  = transcriptFound ? 'Found' : 'No transcript';
    tBadge.className    = 'source-badge ' + (transcriptFound ? 'ok' : 'missing');
  }

  // Website badge
  const wBadge = document.getElementById('si-website-badge');
  if (wBadge) {
    wBadge.textContent = websiteScraped ? 'Scraped ✓' : 'Not scraped';
    wBadge.className   = 'source-badge ' + (websiteScraped ? 'ok' : 'missing');
  }

  // ── Left column: call data ────────────────────────────────────────────────
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '—';
  };
  set('si-call-company',        prospect.company);
  set('si-call-contact',        [prospect.name, prospect.title].filter(Boolean).join(', '));
  set('si-call-ltv',            business.ltv || business.deal_size);
  set('si-call-close',          business.close_rate);
  set('si-call-pain',           ext.angle?.pain || ext.pain);
  set('si-call-goal',           ext.angle?.desired_result || ext.desired_result);
  set('si-call-icp-titles',     Array.isArray(icp.titles) ? icp.titles.slice(0,3).join(', ') : (icp.titles || ''));
  set('si-call-icp-industries', Array.isArray(icp.industries) ? icp.industries.slice(0,3).join(', ') : (icp.industries || ''));

  // ── Right column: website data ────────────────────────────────────────────
  if (brand && brand.scraped) {
    set('si-web-company', brand.company_name);
    set('si-web-domain',  brand.domain || session.domain || '—');
    set('si-web-tagline', brand.tagline);
    // Colors as colored swatches inline
    const colorsEl = document.getElementById('si-web-colors');
    if (colorsEl) {
      const colors = [brand.primary_color, brand.secondary_color, brand.accent_color].filter(Boolean);
      if (colors.length) {
        colorsEl.innerHTML = colors.map(c =>
          `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;">
            <span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${c};border:1px solid rgba(255,255,255,0.2);"></span>
            <span style="font-size:11px;font-family:monospace;color:#71717a;">${c}</span>
          </span>`
        ).join('');
      } else { colorsEl.textContent = 'None extracted'; }
    }
    // Logo
    const logoEl = document.getElementById('si-web-logo');
    if (logoEl && brand.logo_url) {
      logoEl.innerHTML = `<img src="${brand.logo_url}" style="height:20px;border-radius:2px;vertical-align:middle;margin-right:4px;" onerror="this.remove()"> <a href="${brand.logo_url}" target="_blank" style="color:#6366f1;font-size:11px;">View</a>`;
    }
    // Images count
    set('si-web-images', brand.images?.length ? `${brand.images.length} collected` : 'None collected');
    // Website summary excerpt
    if (brand.website_summary) {
      const sumEl = document.getElementById('si-web-summary');
      if (sumEl) { sumEl.textContent = brand.website_summary.slice(0, 300) + (brand.website_summary.length > 300 ? '…' : ''); sumEl.style.display = 'block'; }
    }
  }
}

// ── scoreIcpMatch — local ICP scoring for lead table badges ────────────────────
function scoreIcpMatch(lead, session) {
  var ext      = (session && session.extracted) || {};
  var icp      = ext.icp || ext.prospect?.icp || {};
  var icpTitles    = (Array.isArray(icp.titles)     ? icp.titles     : [icp.titles    ]).filter(Boolean).map(function(t){ return t.toLowerCase(); });
  var icpIndustries= (Array.isArray(icp.industries)  ? icp.industries  : [icp.industries]).filter(Boolean).map(function(i){ return i.toLowerCase(); });
  var title    = (lead.title    || '').toLowerCase();
  var company  = (lead.company  || '').toLowerCase();
  var industry = (lead.industry || company).toLowerCase();

  var reasons = [], misses = [], score = 0;

  // Title match
  var titleHit = icpTitles.length && icpTitles.some(function(t){ return title.includes(t); });
  if (titleHit)      { score += 2; reasons.push('Title matches ICP (' + lead.title + ')'); }
  else if (icpTitles.length) { misses.push('Title not in ICP list'); }

  // Industry match
  var industryHit = icpIndustries.length && icpIndustries.some(function(i){ return industry.includes(i); });
  if (industryHit)   { score += 1; reasons.push('Industry matches ICP'); }
  else if (icpIndustries.length) { misses.push('Industry not in ICP list'); }

  // Company size check (basic)
  if (lead.company_size) { score += 1; reasons.push('Company size available (' + lead.company_size + ')'); }

  if (!reasons.length && !misses.length) {
    reasons.push('No ICP criteria to compare — included by default');
  }

  if (score >= 3) return { label: 'High',   color: '#22c55e', bg: 'rgba(34,197,94,0.12)',    reasons: reasons, misses: misses };
  if (score >= 1) return { label: 'Medium', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  reasons: reasons, misses: misses };
  return           { label: 'Low',    color: '#ef4444', bg: 'rgba(239,68,68,0.10)',     reasons: reasons, misses: misses };
}

// ── toggleLeadDetail — expand/collapse ICP detail row under a lead row ─────────
function toggleLeadDetail(row) {
  var detailRow = row.nextElementSibling;
  if (!detailRow || !detailRow.classList.contains('lead-detail-row')) return;
  var isOpen = detailRow.style.display !== 'none';
  // Close all open rows first
  document.querySelectorAll('.lead-detail-row').forEach(function(r){ r.style.display = 'none'; });
  document.querySelectorAll('.data-row').forEach(function(r){ r.classList.remove('row-expanded'); });
  if (!isOpen) {
    detailRow.style.display = 'table-row';
    row.classList.add('row-expanded');
  }
}

// ── Populate Brand Gallery Panel (edit mode only) ──────────────────────────────
function populateBrandGallery(session) {
  const brand   = session.brand || null;
  const panel   = document.getElementById('brand-gallery-panel');
  const isEdit  = new URLSearchParams(window.location.search).get('edit') === 'true';
  if (!panel || !isEdit) return;
  panel.style.display = 'block';

  const domainLabel = (brand && brand.domain) || session.domain || '';
  if (domainLabel) {
    const domainEl = document.getElementById('brand-gallery-domain');
    if (domainEl) domainEl.textContent = domainLabel;
  }

  if (!brand || !brand.scraped) return;

  // Logo
  const logoPreview = document.getElementById('brand-logo-preview');
  const logoNone    = document.getElementById('brand-logo-none');
  if (brand.logo_url && logoPreview) {
    logoPreview.src           = brand.logo_url;
    logoPreview.style.display = 'block';
    if (logoNone) logoNone.style.display = 'none';
  }

  // Favicon
  const faviconPreview = document.getElementById('brand-favicon-preview');
  if (brand.favicon_url && faviconPreview) {
    faviconPreview.src           = brand.favicon_url;
    faviconPreview.style.display = 'block';
  }

  // Colors
  const colorsList = document.getElementById('brand-colors-list');
  if (colorsList) {
    const colorDefs = [
      { color: brand.primary_color,   label: 'Primary' },
      { color: brand.secondary_color, label: 'Secondary' },
      { color: brand.accent_color,    label: 'Accent' },
    ].filter(c => c.color);
    colorsList.innerHTML = colorDefs.map(c => `
      <div class="brand-color-row">
        <span class="brand-swatch" style="background:${c.color};" title="Click to copy" onclick="navigator.clipboard.writeText('${c.color}').then(()=>this.title='Copied!')"></span>
        <span class="brand-swatch-hex" onclick="navigator.clipboard.writeText('${c.color}')" title="Click to copy">${c.color}</span>
        <span style="font-size:11px;color:#52525b;margin-left:4px;">${c.label}</span>
      </div>
    `).join('') || '<span style="font-size:11px;color:#3f3f46;">No colors extracted</span>';
  }

  // Images
  const imagesGrid = document.getElementById('brand-images-grid');
  const imagesNone = document.getElementById('brand-images-none');
  if (imagesGrid && brand.images?.length) {
    imagesGrid.innerHTML = brand.images.map((img, i) => `
      <img class="brand-image-thumb"
           src="${img.url}"
           alt="${img.alt || 'Image ' + (i+1)}"
           title="${img.type} — ${img.alt || img.url}"
           onclick="selectFeaturedImage('${img.url}')"
           onerror="this.style.display='none'">
    `).join('');
  } else if (imagesNone) {
    imagesNone.style.display = 'block';
  }
}

function selectFeaturedImage(url) {
  document.querySelectorAll('.brand-image-thumb').forEach(el => el.classList.remove('selected'));
  const clicked = [...document.querySelectorAll('.brand-image-thumb')].find(el => el.src === url);
  if (clicked) clicked.classList.add('selected');
  // Persist as override (same mechanism as other rep overrides)
  console.log('[Deal Forge] Featured image selected:', url);
  // Could wire to saveOverride() if that function exists
}

window._reRunPersonalization = runPersonalization;
function runPersonalization(session) {
  try {
    const ext = session.extracted || {};
    const overrides = ext._overrides || {};
    const prospect = ext.prospect || {};
    const icp = ext.icp || {};
    const brand = session.brand || {};
    // Brief schema stores financials under metrics; spec schema uses business — merge both
    const business = Object.assign({}, ext.business || {}, ext.metrics || {});

    // Override PROSPECT object
    if (prospect.company) PROSPECT.name = prospect.company;
    if (prospect.website) PROSPECT.domain = normalizeDomain(prospect.website);
    else if (brand.domain) PROSPECT.domain = normalizeDomain(brand.domain);
    else if (session.domain) PROSPECT.domain = normalizeDomain(session.domain);

    // Apply branding + populate intelligence panels
    applyProspectBranding(typeof SESSION !== "undefined" ? SESSION.brand : null);
    populateSourceIntelligence(session);
    populateBrandGallery(session);

    // ── Pre-fill ROI inputs ──────────────────────────────────────────────────
    // Parse LTV: "$48,000" or "48000" or "$48K"
    function parseDollar(str) {
      if (!str) return null;
      const s = str.replace(/[$,\s]/g, '');
      const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/i);
      if (!m) return null;
      let n = parseFloat(m[1]);
      if (m[2]?.toLowerCase() === 'k') n *= 1000;
      if (m[2]?.toLowerCase() === 'm') n *= 1000000;
      return Math.round(n);
    }
    function parsePercent(str) {
      if (!str) return null;
      const m = str.replace(/%/g, '').trim().match(/^(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : null;
    }

    const ltvEl = document.getElementById('ltv');
    const showRateEl = document.getElementById('show-rate');
    const closeRateEl = document.getElementById('close-rate');

    const ltv = parseDollar(business.ltv || business.deal_size);
    const showRate = parsePercent(business.show_rate);
    const closeRate = parsePercent(business.close_rate);

    if (ltv && ltvEl) { ltvEl.value = ltv; ltvEl.dispatchEvent(new Event('input')); }
    if (showRate && showRateEl) { showRateEl.value = showRate; showRateEl.dispatchEvent(new Event('input')); }
    if (closeRate && closeRateEl) { closeRateEl.value = closeRate; closeRateEl.dispatchEvent(new Event('input')); }

    // Trigger ROI recalculation if function exists
    if (typeof roiCompute === 'function') roiCompute();

    // ── Filter case studies by industry ──────────────────────────────────────
    const industry = (icp.industry || '').toLowerCase();
    const industryMap = {
      'consulting': 'consulting',
      'software': 'software',
      'saas': 'software',
      'coaching': 'coaching',
      'agency': 'agencies',
      'agencies': 'agencies',
      'ecommerce': 'software',
      'healthcare': 'consulting',
      'real_estate': 'consulting',
      'finance': 'consulting'
    };
    const filterTag = industryMap[industry];
    if (filterTag) {
      // Click the matching filter button if it exists
      const filterBtns = document.querySelectorAll('.cs-filter-btn');
      filterBtns.forEach(function(btn) {
        if (btn.textContent.trim().toLowerCase() === filterTag ||
            btn.dataset.filter === filterTag) {
          btn.click();
        }
      });
    }

    // ── Personalized headline on slide 1 ──────────────────────────────────────
    const slideTitleEl = document.getElementById('slide-title');
    const slideTagEl = document.getElementById('slide-tag');
    if (ext.personalized_title && slideTitleEl) {
      slideTitleEl.textContent = ext.personalized_title;
    }
    // Update slide tag to show company name
    if (slideTagEl && prospect.company) {
      slideTagEl.textContent = 'Live Webinar · Prepared for ' + prospect.company;
    }

    // ── Add personalization indicator in "Prepared for" nav badge ─────────────
    const preparedBadge = document.querySelector('.prepared-for');
    if (preparedBadge && prospect.company) {
      preparedBadge.innerHTML = 'Prepared for <span style="color:#e4e4e7;font-weight:700;">' + prospect.company + '</span>';
    }

    // ── Host elements (calendar event + webinar slide) ────────────────────────
    const prospectContactName = prospect.contact_name || prospect.name || '';
    const hostName = prospect.company || prospectContactName || 'Your Host';
    const hostCompany = prospect.company || '';

    const calHostName = document.getElementById('cal-host-name');
    const calHostSub  = document.getElementById('cal-host-sub');
    if (calHostName) calHostName.textContent = 'Hosted by ' + hostName;
    if (calHostSub)  calHostSub.textContent  = hostCompany + (icp.industry ? ' · ' + icp.industry + ' specialist' : '');

    const hostNameEl    = document.getElementById('host-name-el');
    const hostTitleEl   = document.getElementById('host-title-el');
    const hostInitials  = document.getElementById('host-avatar-initials');
    if (hostNameEl)   hostNameEl.textContent  = hostName;
    if (hostTitleEl)  hostTitleEl.textContent  = hostCompany;
    if (hostInitials) hostInitials.textContent = hostName.split(/\s+/).map(function(w){ return w[0]; }).slice(0,2).join('').toUpperCase();

    const seriesLabel = document.getElementById('webinar-series-label');
    if (seriesLabel) seriesLabel.textContent = hostCompany ? hostCompany + ' · Webinar' : 'Webinar Series';

    const calHostMeta = document.getElementById('cal-host-meta');
    if (calHostMeta) calHostMeta.textContent = hostName + (hostCompany ? ' · ' + hostCompany : '');

    // ── TAM stats from Apollo total ───────────────────────────────────────────
    const gen = (session.extracted || {})._generated || {};
    // parseKM is module-level — safely converts "75K", "75000", "$75,000" or bad strings like "75K80K"
    const tamTotal = parseKM(gen.tamTotal) || parseKM(gen.apolloTotal) || null;
    // monthlyRaw hoisted so calendar + ROI model can reference it
    let monthlyRaw = 30000;
    let monthlyLo = 25, monthlyHi = 35;
    if (tamTotal) {
      const tamEl = document.getElementById('tam-total-val');
      if (tamEl) {
        // Format the number for display — always safe since tamTotal is now a parsed integer
        tamEl.textContent = tamTotal >= 1000000
          ? (Math.round(tamTotal / 100000) / 10) + 'M'
          : tamTotal >= 1000
            ? (Math.round(tamTotal / 1000)) + 'K'
            : tamTotal.toLocaleString();
        // Edit mode only: show TAM source badge so rep knows if they should verify before sharing
        if (IS_EDIT_MODE && gen.tamSource === 'estimated') {
          const badge = document.createElement('span');
          badge.title = 'TAM is estimated — Apollo returned no org count. You can override this value.';
          badge.style.cssText = 'margin-left:8px;font-size:11px;font-weight:600;color:#f59e0b;background:rgba(245,158,11,0.15);padding:2px 6px;border-radius:4px;vertical-align:middle;cursor:help;';
          badge.textContent = '⚠ Estimated';
          tamEl.parentNode.appendChild(badge);
        }
      }
      // Lloyd's rep-proof outreach formula:
      // TAM > 300K → 100K/mo (QS maximum), TAM ≤ 300K → exhaust in exactly 3 months
      // Use server-computed value if available (same formula, avoids client-side drift)
      // If rep has manually overridden, that value wins — and we reflect the real math.
      const isOutreachOverride = !!gen.recommendedOutreach;
      monthlyRaw = gen.recommendedOutreach ||
        (tamTotal > 300000
          ? 100000
          : Math.max(1000, Math.round(tamTotal / 3 / 1000) * 1000));

      // Compute actual cycle months from real numbers (works for overrides too)
      const actualCycleRaw = tamTotal > 0 ? tamTotal / monthlyRaw : 3;
      // Format: round to nearest 0.5 for clean display (e.g. 1.5, 2, 3)
      const actualCycleRounded = Math.round(actualCycleRaw * 2) / 2;
      const cycleMonths = actualCycleRounded < 1
        ? '< 1 mo'
        : actualCycleRounded === 1
          ? '~1 mo'
          : '~' + (Number.isInteger(actualCycleRounded) ? actualCycleRounded : actualCycleRounded.toFixed(1)) + ' mo';
      const cycleEl = document.getElementById('tam-cycle-val');
      if (cycleEl) cycleEl.textContent = cycleMonths;
      monthlyLo = Math.round(monthlyRaw * 0.85 / 1000);
      monthlyHi = Math.min(100, Math.round(monthlyRaw * 1.15 / 1000));
      const monthlyEl = document.getElementById('tam-monthly-val');
      if (monthlyEl) monthlyEl.textContent = monthlyLo + '–' + monthlyHi + 'K' + (isOutreachOverride && IS_EDIT_MODE ? ' ✏' : '');
      // Edit mode: add override icons on TAM and outreach elements
      addEditIcon(document.getElementById('tam-total-val'), 'tam_total', 'Market Size (TAM)');
      addEditIcon(monthlyEl, 'recommended_outreach', 'Monthly Outreach Volume');

      // ── Sync MONTHLY_INVITES + update all static volume elements ─────────
      MONTHLY_INVITES = isNaN(monthlyRaw) ? 30000 : monthlyRaw;
      const volFull = Math.round(MONTHLY_INVITES).toLocaleString();
      const vol = MONTHLY_INVITES >= 1000 ? Math.round(MONTHLY_INVITES / 1000) + 'K' : volFull;
      const tamStr = tamTotal >= 1000 ? Math.round(tamTotal / 1000) + 'K' : tamTotal;

      const cycleBadge = document.getElementById('tam-cycle-badge-text');
      if (cycleBadge) {
        const overrideNote = isOutreachOverride ? ' <span style="font-size:11px;color:#71717a;font-weight:400;">(manually set)</span>' : '';
        if (actualCycleRounded < 1.1) {
          cycleBadge.innerHTML = 'At ' + vol + ' outreaches/mo' + overrideNote + ', you reach your entire market in under 1 month — <strong>run fresh webinar angles each cycle</strong> to maximize market penetration.';
        } else if (Number.isInteger(actualCycleRounded)) {
          cycleBadge.innerHTML = 'With a focused TAM of ' + tamStr + ', ' + vol + ' outreaches/mo' + overrideNote + ' exhausts your market in <strong>exactly ' + actualCycleRounded + ' month' + (actualCycleRounded > 1 ? 's' : '') + '</strong> — rotate webinar topics each cycle to stay fresh.';
        } else {
          cycleBadge.innerHTML = 'With a focused TAM of ' + tamStr + ', ' + vol + ' outreaches/mo' + overrideNote + ' exhausts your market in <strong>~' + actualCycleRounded.toFixed(1) + ' months</strong> — rotate webinar topics each cycle to stay fresh.';
        }
      }
      const roiLocked = document.getElementById('roi-locked-monthly');
      if (roiLocked) roiLocked.textContent = volFull;
      const roiFunnelSub = document.getElementById('roi-funnel-sub');
      if (roiFunnelSub) roiFunnelSub.textContent = volFull + ' outreaches/month. Toggle each step conservative or aggressive to stress-test the numbers.';
      const roiFbarMonthly = document.getElementById('roi-fbar-monthly');
      if (roiFbarMonthly) roiFbarMonthly.textContent = volFull;

      // Pre-populate ROI inputs from saved overrides (persisted rep values)
      if (gen.roiLtv)       { const el = document.getElementById('ltv');        if (el) el.value = gen.roiLtv; }
      if (gen.roiShowRate)  { const el = document.getElementById('show-rate');  if (el) el.value = gen.roiShowRate; }
      if (gen.roiCloseRate) { const el = document.getElementById('close-rate'); if (el) el.value = gen.roiCloseRate; }

      roiCalc();          // Re-run ROI model with all updated values
      wireROIEditMode();  // Wire funnel edit controls (idempotent in edit mode)
    } else if (!gen.leadsTaskStatus || gen.leadsTaskStatus === 'pending') {
      // Lead search still running — show searching state instead of static —
      var tamSearchEl = document.getElementById('tam-total-val');
      if (tamSearchEl) tamSearchEl.innerHTML = '<span style="font-size:16px;color:#52525b;letter-spacing:normal;font-weight:500;">Searching\u2026</span>';
      var tamMonthSearch = document.getElementById('tam-monthly-val');
      if (tamMonthSearch) tamMonthSearch.innerHTML = '<span style="font-size:16px;color:#52525b;letter-spacing:normal;font-weight:500;">Computing</span>';
    }

    // ── Calendar invite personalization ──────────────────────────────────────
    const calTitle = document.getElementById('cal-title');
    const calDesc = document.getElementById('cal-desc');

    if (calTitle && ext.personalized_title) {
      calTitle.textContent = ext.personalized_title;
    }

    if (calDesc) {
      const companyName = prospect.company || 'your firm';
      const icpRole = icp.role || 'decision-makers';
      const icpIndustry = icp.industry || 'your industry';
      const icpGeo = icp.geography;
      const kpis = Array.isArray(icp.kpis) ? icp.kpis.slice(0, 3) : [];
      // Brief schema uses angle.pain/result/context.goals; spec schema uses top-level keys — support both
      const pain = ext.customer_pain || ext.angle?.pain || '';
      const result = ext.result_delivered || ext.angle?.result || 'build predictable client acquisition';
      const goals = ext.goals || ext.context?.goals || 'grow revenue';
      const caseStudy = ext.case_study || null;

      let caseStudiesHTML = '';
      if (caseStudy && caseStudy.result) {
        const nums = caseStudy.numbers ? ': ' + caseStudy.numbers : '';
        caseStudiesHTML = `
          <div class="cal-desc-cases">
            <div class="cal-desc-cases-label">What clients like you achieved</div>
            <div class="cal-desc-case"><strong>${caseStudy.client_description || 'A similar firm'}</strong> — ${caseStudy.result}${nums}</div>
          </div>`;
      }

      const forLine = icpGeo
        ? `${icpIndustry} founders targeting ${icpGeo}`
        : `${icpIndustry} founders`;

      let hookText = '';
      if (pain) {
        const painLower = pain.charAt(0).toLowerCase() + pain.slice(1);
        const resultLower = result.charAt(0).toLowerCase() + result.slice(1);
        hookText = `If ${painLower}, you're not alone — and there's a proven system to fix it. In 90 minutes, we'll walk through exactly how to ${resultLower} without cold calling or depending on who you know.`;
      } else {
        hookText = `In 90 minutes, discover the exact system ${companyName} can use to build a predictable client acquisition engine targeting ${icpRole} in ${icpIndustry}.`;
      }

      calDesc.innerHTML = `
        <div class="cal-desc-cta">
          This session is prepared specifically for <strong>${companyName}</strong>. The examples, funnel math, and case studies have been selected based on your firm's profile and ICP.
        </div>
        <div class="cal-desc-hook">${hookText}</div>
        ${caseStudiesHTML}
        <div class="cal-desc-section">
          <div class="cal-desc-section-label">What You'll Walk Away With</div>
          <ul class="cal-desc-bullets">
            <li>${kpis.length >= 2 ? 'A system to reach the ' + icpRole + 's who want to improve their ' + kpis.slice(0,2).join(' and ') : 'A client acquisition system built specifically for ' + icpIndustry + ' consulting'}</li>
            <li>How to run ${Math.round(monthlyRaw/1000)}K+ automated outreaches per month — targeting ${icpRole}</li>
            <li>${kpis.length >= 3 ? 'Live funnel math showing what ' + kpis[2] + ' improvement is worth in client value for ' + companyName : 'Live funnel math modeled on ' + companyName + '\'s specific numbers'}</li>
          </ul>
        </div>
        <div class="cal-desc-meta">
          <span><strong>For:</strong> ${forLine} · looking to ${goals}</span>
          <span><strong>Host:</strong> ${prospect.company || companyName}</span>
          <span><strong>Duration:</strong> 90 min + live Q&amp;A · Join link sent on confirmation</span>
        </div>
      `;
    }

    // ── Lead list ICP parameters ──────────────────────────────────────────────
    const icpFiltersRow = document.querySelector('.tam-filters-row');
    // Use Apollo-native fields for display if present — these are the exact search
    // parameters passed to Apollo. Fall back to narrative ICP fields for briefs
    // that haven't run extract yet (first render from prefetch brief).
    const displayTitles = Array.isArray(icp.apollo_titles) && icp.apollo_titles.length
      ? icp.apollo_titles
      : (icp.role ? [icp.role] : null);
    const displayIndustries = Array.isArray(icp.apollo_industries) && icp.apollo_industries.length
      ? icp.apollo_industries
      : (icp.industry ? [icp.industry] : null);
    const displayGeos = Array.isArray(icp.apollo_geography) && icp.apollo_geography.length
      ? icp.apollo_geography
      : (icp.geography ? [icp.geography] : null);
    const displaySize = icp.company_size || null;

    if (icpFiltersRow) {
      // Store ICP data globally for filter editing
      window._icpEditData = {
        apollo_titles: displayTitles ? displayTitles.slice() : [],
        apollo_industries: displayIndustries ? displayIndustries.slice() : [],
        apollo_geography: displayGeos ? displayGeos.slice() : [],
        apollo_employee_ranges: (icp.apollo_employee_ranges || []).slice(),
        person_seniorities: (icp.person_seniorities || []).slice(),
        company_size: displaySize || ''
      };
      window._filterEditMode = false;

      if (displayTitles || displayIndustries || displaySize || displayGeos) {
        renderFilterTags();
        // Show edit button if we have a job ID
        var fEditBtn = document.getElementById('filter-edit-btn');
        if (fEditBtn && new URLSearchParams(window.location.search).get('job')) {
          fEditBtn.style.display = 'inline-flex';
        }
      } else {
        icpFiltersRow.innerHTML = '<span class="filter-tag" style="color:#52525b;background:none;border:none;">ICP parameters unavailable</span>';
      }
    }

    // ── KPI line below ICP filters ────────────────────────────────────────────
    const kpiLine = document.getElementById('tam-kpi-line');
    if (kpiLine && Array.isArray(icp.kpis) && icp.kpis.length) {
      const kpiList = icp.kpis.slice(0, 3);
      const icpRoleShort = icp.role ? icp.role.split(/[,\/]/)[0].trim() : 'decision-makers';
      let kpiText = '';
      if (kpiList.length === 1) kpiText = kpiList[0];
      else if (kpiList.length === 2) kpiText = kpiList[0] + ' and ' + kpiList[1];
      else kpiText = kpiList[0] + ', ' + kpiList[1] + ', and ' + kpiList[2];
      kpiLine.style.display = 'block';
      kpiLine.innerHTML = '→ These are the <strong>' + icpRoleShort + 's</strong> you could be helping improve their <strong>' + kpiText + '</strong>.';
    }
    renderLeadDiagnostics(gen);

    // ── Live chat personalization ─────────────────────────────────────────────
    const chatPanel = document.querySelector('.chat-messages');
    if (chatPanel) {
      const companyName = prospect.company || 'your firm';
      const icpIndustry2 = icp.industry || 'consulting';
      const icpRole2 = icp.role || 'decision-makers';
      const chatKpis = Array.isArray(icp.kpis) && icp.kpis.length ? icp.kpis : null;
      const chatVol = MONTHLY_INVITES >= 1000 ? Math.round(MONTHLY_INVITES / 1000) + 'K' : MONTHLY_INVITES.toLocaleString();
      const kpi1 = chatKpis ? chatKpis[0] : 'revenue growth';
      const kpi2 = chatKpis && chatKpis[1] ? chatKpis[1] : 'client acquisition';

      const chatMsgs = [
        { name: 'Jordan M.', text: 'We\'ve been 90% referral-based for years — this is exactly the system we needed for ' + icpIndustry2 },
        { name: 'Alicia F.', text: 'How long until we see the first qualified calls from the ' + icpRole2 + ' targeting?' },
        { name: null, support: true, text: 'Alicia — typically first calls in weeks 3–4 of the campaign. ' + hostName + ' will walk through the ramp in the funnel section' },
        { name: 'Derek O.', text: 'We\'re plateaued and manual outreach to ' + icpIndustry2 + ' firms just doesn\'t scale anymore' },
        { name: 'Simone L.', text: 'Our clients are asking about ' + kpi1 + ' — does this system target ' + icpRole2 + ' specifically on that?' },
        { name: null, support: true, text: 'Simone — yes, the targeting is built around ' + icpIndustry2 + ' decision-makers. ' + kpi1 + ' framing is part of the webinar positioning' },
        { name: 'Tyler B.', text: 'The automation piece is critical — our outreach to ' + icpRole2 + ' is completely manual right now' },
        { name: 'Priya M.', text: 'Is there a replay? Our partners want to see this but have a conflict' },
        { name: null, support: true, text: 'Yes — replay goes out within 24 hours to all registered attendees' },
        { name: 'Marcus W.', text: 'Most excited about the ROI model — want to see what ' + chatVol + ' outreaches means for ' + kpi2 + ' specifically' },
        { name: null, support: true, booking: true, text: '🎉 Nadia Caruso just booked a strategy call — excited to walk through your ' + icpIndustry2 + ' funnel with you, Nadia!' },
        { name: 'Ryan C.', text: 'We\'ve been stuck at the same revenue for two years. This feels like the system we\'ve been missing' },
        { name: null, support: true, booking: true, text: '✅ Sophie Whitfield — call confirmed! Looking forward to mapping this to Whitfield & Co., Sophie' },
        { name: 'James O.', text: chatVol + ' automated outreaches targeting ' + icpRole2 + ' specifically — didn\'t know this was possible without a massive team' },
      ];

      chatPanel.innerHTML = chatMsgs.map(function(m) {
        var cls = 'chat-msg' + (m.booking ? ' chat-booking' : '');
        var nameCls = 'chat-name' + (m.support ? ' support' : '');
        var nameText = m.support ? (companyName + ' Team') : m.name;
        return '<div class="' + cls + '"><div class="' + nameCls + '">' + nameText + '</div><div class="chat-text">' + m.text + '</div></div>';
      }).join('');
    }

    // ── Reminder emails — personalize prospect name + host ────────────────────
    const prospectFirst = (prospectContactName || '').split(' ')[0] ||
                          (session.email || '').split('@')[0] || '';
    const hostFirst = prospectContactName ? prospectContactName.split(' ')[0] :
                      (prospect.company ? prospect.company.split(' ')[0] : 'Your host');

    const e1preview = document.getElementById('email-1-preview');
    if (e1preview) e1preview.textContent =
      (prospectFirst ? 'Hey ' + prospectFirst + ' — ' : 'Hey — ') +
      'your spot is confirmed. We\'ll walk through the exact pipeline framework that took 3 of our clients from $1.2M to $2.4M+ last year. See you there.';

    const e2preview = document.getElementById('email-2-preview');
    if (e2preview) e2preview.textContent =
      'No re-registration needed — here\'s your direct join link. ' + hostFirst +
      ' opens the room at 11:55 AM for early questions before we go live at noon sharp.';

    const e3subject = document.getElementById('email-3-subject');
    if (e3subject) e3subject.textContent =
      'We go live in 60 minutes — see you there' + (prospectFirst ? ', ' + prospectFirst : '');

    const e3preview = document.getElementById('email-3-preview');
    if (e3preview) e3preview.textContent =
      'Heads up — we start in one hour. 800+ registered. ' + hostFirst +
      ' will be taking live questions at the end, so come ready with yours.';

    // ── Override variants with generated webinar titles ──────────────────────
    const generated = ext._generated || {};

    if (generated.webinarTitles?.variants?.length === 3) {
      const gtv = generated.webinarTitles.variants;
      const hostLabel = prospect.company || companyName;

      function buildGeneratedDesc(v) {
        const cta = `<div class="cal-desc-cta">
  👉 <strong>Click Yes or Maybe</strong> to reserve your spot.<br>
  Click <strong>No</strong> and we'll remove you from this invite series.
</div>`;
        const hook = `<div class="cal-desc-hook">${v.hook || ''}</div>`;
        const bullets = v.bullets?.length ? `<div class="cal-desc-section">
  <div class="cal-desc-section-label">What You'll Walk Away With</div>
  <ul class="cal-desc-bullets">${v.bullets.map(function(b){ return '<li>' + b + '</li>'; }).join('')}</ul>
</div>` : '';
        const meta = `<div class="cal-desc-meta">
  <span><strong>For:</strong> ${v.for_line || (icp.role + 's in ' + icp.industry)}</span>
  <span><strong>Host:</strong> ${hostLabel}</span>
  <span><strong>Duration:</strong> 90 min + live Q&amp;A · Join link sent on confirmation</span>
</div>`;
        return cta + hook + bullets + meta;
      }

      variants[0] = { tag: 'Curiosity-first', title: gtv[0].title, desc: buildGeneratedDesc(gtv[0]) };
      variants[1] = { tag: 'Outcome-first',   title: gtv[1].title, desc: buildGeneratedDesc(gtv[1]) };
      variants[2] = { tag: 'Mechanism-first', title: gtv[2].title, desc: buildGeneratedDesc(gtv[2]) };

      // Re-apply with generated data
      switchVariant(0);

      // Sync slide 1 title with generated variant A
      var slideTitleEl2 = document.getElementById('slide-title');
      if (slideTitleEl2) slideTitleEl2.textContent = gtv[0].title;

      console.log('[Deal Forge] Webinar titles applied — Variant A:', gtv[0].title);
    }

    // ── Replace lead table with Apollo leads ─────────────────────────────────
    if (Array.isArray(gen.leads)) {
      var tbody = document.querySelector('.lead-table tbody');
      if (tbody) {
        var loadingRow = document.getElementById('leads-loading-row');
        if (loadingRow) loadingRow.remove();
        
        if (gen.leads.length === 0) {
          // Check task status if it's explicitly failed
          if (gen.leadsTaskStatus === 'failed') {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:28px 0;color:#ef4444;font-size:13px;">Lead search failed. Please check your Apollo API key and filters.</td></tr>';
          } else if (gen.leadsTaskStatus === 'completed' || gen.leadsTaskStatus === null) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:28px 0;color:#71717a;font-size:13px;">No leads found. Please edit ICP parameters and try again.</td></tr>';
          }
        } else {
          var liSvg = '<svg width="11" height="11" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>';
          tbody.innerHTML = gen.leads.slice(0, 25).map(function(lead, idx) {
            var websiteDomain = lead.website ? lead.website.replace(/^https?:\/\//, '') : '';

          var websiteCell = lead.website
            ? '<a class="web-link" href="' + lead.website + '" target="_blank">' + websiteDomain + '</a>'
            : '<span style="color:#9ca3af">—</span>';
          var liCell = lead.linkedin_url
            ? '<a class="li-link" href="' + lead.linkedin_url + '" target="_blank">' + liSvg + ' View</a>'
            : '<span style="color:#9ca3af">—</span>';
          // ICP match scoring
          var matchResult = scoreIcpMatch(lead, window.SESSION);
          var matchBadge = '<span class="icp-badge" style="color:' + matchResult.color + ';background:' + matchResult.bg + ';">' + matchResult.label + '</span>';
          // Build why-text for expandable row
          var whyParts = matchResult.reasons || [];
          var missParts = matchResult.misses || [];
          var whyHtml = '<div class="lead-detail-inner">' +
            '<div class="match-reason">ICP Analysis for <strong>' + lead.name + '</strong> at <strong>' + lead.company + '</strong></div>' +
            '<div class="match-breakdown">' +
              whyParts.map(function(r) { return '<span class="match-tag match-hit">✓ ' + r + '</span>'; }).join('') +
              missParts.map(function(r) { return '<span class="match-tag match-miss">✗ ' + r + '</span>'; }).join('') +
            '</div>' +
          '</div>';
          var dataRow = '<tr class="data-row" onclick="toggleLeadDetail(this)">' +
            '<td style="color:#3f3f46;font-size:12px;">' + (idx + 1) + '</td>' +
            '<td class="td-match">' + matchBadge + '</td>' +
            '<td class="td-name">' + lead.name + '</td>' +
            '<td class="td-title">' + lead.title + '</td>' +
            '<td class="td-company">' + lead.company + '</td>' +
            '<td class="td-size">' + (lead.company_size || '—') + '</td>' +
            '<td>' + websiteCell + '</td>' +
            '<td>' + liCell + '</td>' +
            '</tr>';
          var detailRow = '<tr class="lead-detail-row" style="display:none;"><td colspan="8" class="lead-detail-cell">' + whyHtml + '</td></tr>';
          return dataRow + detailRow;
        }).join('');

        console.log('[Deal Forge] Lead table populated with', gen.leads.length, 'Apollo leads');
      }
    } else if (gen.leadsTaskStatus === 'completed' || (Array.isArray(gen.leads) && gen.leads.length === 0)) {
      // Task completed with 0 leads — replace spinner row with informative empty state
      var loadingRowEmpty = document.getElementById('leads-loading-row');
      if (loadingRowEmpty) {
        loadingRowEmpty.innerHTML = '<td colspan="7" style="text-align:center;padding:32px 0;color:#71717a;font-size:13px;line-height:1.8;">' +
          '<strong style="color:#52525b;">No contacts found for this ICP in Apollo.</strong><br>' +
          'TAM confirmed — Apollo has limited contact coverage for these specific titles in this geography.<br>' +
          '<span style="font-size:11px;color:#3f3f46;">The ICP Translation Agent will broaden the search on the next job submission.</span>' +
          '</td>';
      }
      console.log('[Deal Forge] Lead list completed with 0 leads — empty state shown');
    }
    // else: still pending — spinner row stays visible naturally

    // ── Render Apollo Diagnostics ─────────────────────────────────────────────
    const diagPanel = document.getElementById('lead-diagnostics-panel');
    if (diagPanel) {
      if (gen.apollo_diagnostics && gen.apollo_diagnostics.wasRelaxed) {
        diagPanel.style.display = 'block';
        diagPanel.style.padding = '12px 16px';
        diagPanel.style.background = 'rgba(245, 158, 11, 0.08)';
        diagPanel.style.border = '1px solid rgba(245, 158, 11, 0.3)';
        diagPanel.style.borderRadius = '8px';
        diagPanel.style.marginBottom = '16px';
        diagPanel.style.color = '#d97706';
        diagPanel.style.fontSize = '13px';
        
        let logsHtml = (gen.apollo_diagnostics.relaxationLog || []).map(log => 
          `<div style="margin-top:4px;">⚠️ ${escHtml(log)}</div>`
        ).join('');
        
        diagPanel.innerHTML = `
          <div style="font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"></path></svg>
            Apollo Search Relaxed
          </div>
          <div>Original filters yielded insufficient leads. The search engine automatically relaxed constraints to guarantee results:</div>
          <div style="margin-top:8px;font-family:monospace;font-size:12px;color:#b45309;line-height:1.6;">
            ${logsHtml}
          </div>
        `;
      } else {
        diagPanel.style.display = 'none';
      }
    }

    console.log('[Deal Forge] Portal personalized for:', PROSPECT.name, '| Industry:', industry,
      '| Title:', ext.personalized_title?.slice(0,50), '| LTV:', ltv,
      '| Transcript:', session.transcript?.found, '| Website:', session.website?.scraped);

  } catch(err) {
    console.warn('[Deal Forge] Session load failed, using defaults:', err.message);
    applyProspectBranding(typeof SESSION !== "undefined" ? SESSION.brand : null);
  }
}
// ── Editable ICP Filter Tags ──────────────────────────────────────────────────
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function renderFilterTags() {
  var row = document.querySelector('.tam-filters-row');
  if (!row || !window._icpEditData) return;
  var d = window._icpEditData;
  var editMode = window._filterEditMode;
  var editClass = editMode ? ' editable' : '';

  function makeTag(val, group) {
    var removeBtn = '<span class="ft-remove" onclick="removeFilter(\'' + escHtml(group) + '\',\'' + escHtml(val).replace(/'/g,"&#39;") + '\')">&times;</span>';
    return '<span class="filter-tag' + editClass + '">' + escHtml(val) + removeBtn + '</span>';
  }
  function makeAddInput(group, placeholder) {
    if (!editMode) return '';
    return '<input class="filter-add-input" style="display:inline-block" placeholder="+ ' + placeholder + '" onkeydown="if(event.key===\'Enter\'){addFilter(\'' + group + '\',this.value);this.value=\'\'}">';
  }

  var html = '';
  // Titles
  if (d.apollo_titles && d.apollo_titles.length) {
    html += '<span class="filter-group-label">Titles</span>';
    html += d.apollo_titles.map(function(v){ return makeTag(v, 'apollo_titles'); }).join('');
    html += makeAddInput('apollo_titles', 'Add title…');
    html += '<span class="filter-sep">&middot;</span>';
  } else if (editMode) {
    html += '<span class="filter-group-label">Titles</span>';
    html += makeAddInput('apollo_titles', 'Add title…');
    html += '<span class="filter-sep">&middot;</span>';
  }
  // Company Size
  if (d.company_size) {
    html += '<span class="filter-group-label">Company Size</span>';
    html += '<span class="filter-tag">' + escHtml(d.company_size) + '</span>';
    html += '<span class="filter-sep">&middot;</span>';
  }
  // Employee Ranges
  if (d.apollo_employee_ranges && d.apollo_employee_ranges.length) {
    html += '<span class="filter-group-label">Employee Ranges</span>';
    html += d.apollo_employee_ranges.map(function(v){ return makeTag(v, 'apollo_employee_ranges'); }).join('');
    html += makeAddInput('apollo_employee_ranges', 'e.g. 11,50');
    html += '<span class="filter-sep">&middot;</span>';
  }
  // Industries
  if (d.apollo_industries && d.apollo_industries.length) {
    html += '<span class="filter-group-label">Industries</span>';
    html += d.apollo_industries.map(function(v){ return makeTag(v, 'apollo_industries'); }).join('');
    html += makeAddInput('apollo_industries', 'Add industry…');
    html += '<span class="filter-sep">&middot;</span>';
  } else if (editMode) {
    html += '<span class="filter-group-label">Industries</span>';
    html += makeAddInput('apollo_industries', 'Add industry…');
    html += '<span class="filter-sep">&middot;</span>';
  }
  // Geographies
  if (d.apollo_geography && d.apollo_geography.length) {
    html += '<span class="filter-group-label">Geographies</span>';
    html += d.apollo_geography.map(function(v){ return makeTag(v, 'apollo_geography'); }).join('');
    html += makeAddInput('apollo_geography', 'Add location…');
  } else if (editMode) {
    html += '<span class="filter-group-label">Geographies</span>';
    html += makeAddInput('apollo_geography', 'Add location…');
  } else {
    html = html.replace(/<span class="filter-sep">&middot;<\/span>$/, '');
  }
  // Seniorities
  if (d.person_seniorities && d.person_seniorities.length) {
    html += '<span class="filter-sep">&middot;</span>';
    html += '<span class="filter-group-label">Seniorities</span>';
    html += d.person_seniorities.map(function(v){ return makeTag(v, 'person_seniorities'); }).join('');
    html += makeAddInput('person_seniorities', 'Add seniority…');
  } else if (editMode) {
    html += '<span class="filter-sep">&middot;</span>';
    html += '<span class="filter-group-label">Seniorities</span>';
    html += makeAddInput('person_seniorities', 'e.g. director');
  }

  row.innerHTML = html;
}

function toggleFilterEdit() {
  window._filterEditMode = !window._filterEditMode;
  var btn = document.getElementById('filter-edit-btn');
  if (btn) {
    btn.textContent = window._filterEditMode ? '✓ Done Editing' : '✏️ Edit Filters';
    btn.classList.toggle('active', window._filterEditMode);
  }
  document.getElementById('filter-actions').classList.toggle('show', window._filterEditMode);
  document.getElementById('filter-status').textContent = '';
  renderFilterTags();
}

function removeFilter(group, val) {
  if (!window._icpEditData[group]) return;
  window._icpEditData[group] = window._icpEditData[group].filter(function(v){ return v !== val; });
  renderFilterTags();
}

function addFilter(group, val) {
  val = (val || '').trim();
  if (!val) return;
  if (!window._icpEditData[group]) window._icpEditData[group] = [];
  if (window._icpEditData[group].indexOf(val) === -1) window._icpEditData[group].push(val);
  renderFilterTags();
}

function _getPortalJobId() {
  return new URLSearchParams(window.location.search).get('job');
}

function _showFilterStatus(msg, color) {
  var el = document.getElementById('filter-status');
  if (el) { el.textContent = msg; el.style.color = color || '#a1a1aa'; }
}

function saveFiltersOnly() {
  var jobId = _getPortalJobId();
  if (!jobId) { _showFilterStatus('⚠️ No job ID in URL', '#fbbf24'); return; }
  _showFilterStatus('Saving…', '#a1a1aa');
  fetch('/api/jobs/' + encodeURIComponent(jobId) + '/icp', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(window._icpEditData)
  }).then(function(r){ return r.json(); })
    .then(function(d){
      if (d.ok) _showFilterStatus('✓ Filters saved', '#4ade80');
      else _showFilterStatus('Error: ' + (d.error || 'unknown'), '#f87171');
    })
    .catch(function(e){ _showFilterStatus('Error: ' + e.message, '#f87171'); });
}

function rerunApolloSearch() {
  var jobId = _getPortalJobId();
  if (!jobId) { _showFilterStatus('⚠️ No job ID in URL', '#fbbf24'); return; }
  _showFilterStatus('Saving & starting Apollo search…', '#60a5fa');
  fetch('/api/jobs/' + encodeURIComponent(jobId) + '/icp', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(window._icpEditData)
  }).then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.ok) { _showFilterStatus('Save failed: ' + (d.error || 'unknown'), '#f87171'); return; }
      return fetch('/api/jobs/' + encodeURIComponent(jobId) + '/rerun-apollo', { method: 'POST' });
    })
    .then(function(r){ if (r) return r.json(); })
    .then(function(d){
      if (d && d.ok) _showFilterStatus('🔄 Apollo search running — refresh in a few minutes to see new leads', '#4ade80');
      else if (d) _showFilterStatus('Error: ' + (d.error || 'unknown'), '#f87171');
    })
    .catch(function(e){ _showFilterStatus('Error: ' + e.message, '#f87171'); });
}

</script>
