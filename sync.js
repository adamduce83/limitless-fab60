// Fab 60 â Simpro sync script
// Pulls fabrication/gate job data from Simpro, calculates milestones, writes fab60-data.json
// Runs via GitHub Actions on schedule

const fs = require('fs');
const https = require('https');

// --- Config ---
const API_BASE = 'https://dar.simprosuite.com/api/v1.0/companies/0';
const API_TOKEN = process.env.SIMPRO_API_TOKEN;
const JOB_LIST_FILE = 'fab-jobs.json';
const OUTPUT_FILE = 'fab60-data.json';

// --- Milestone offsets (calendar days from Day 0) ---
const MILESTONE_OFFSETS = { CC1: 10, CC2: 26, CC3: 41, DUE: 60 };
const BUFFER_DAYS = 19; // gap between internal target (41) and promise (60)

// --- Stage mapping from Simpro status strings ---
const STATUS_TO_STAGE = {
  'Pending':            1,
  'Pending Approval':   1,
  'Approved':           2,
  'Progress':           4,
  'In Progress':        4,
  'Partial':            4,
  'Pre-Completion':     9,
  'Complete':          11,
  'Invoiced':          11
};

// --- API helper ---
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path.startsWith('http') ? path : API_BASE + '/' + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': 'Bearer ' + API_TOKEN,
        'Accept': 'application/json'
      }
    };
    https.get(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('API ' + res.statusCode + ' on ' + url.pathname));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// --- Get job detail ---
async function getJobDetail(jobId) {
  try {
    return await apiGet('jobs/' + jobId);
  } catch(e) {
    console.warn('  WARN: job ' + jobId + ': ' + e.message);
    return null;
  }
}

// --- Get first paid invoice date (Day 0) ---
async function getFirstPaidInvoiceDate(jobId) {
  try {
    const invoices = await apiGet('jobs/' + jobId + '/invoices/');
    if (!Array.isArray(invoices) || invoices.length === 0) return null;

    let earliest = null;
    for (const inv of invoices) {
      // Simpro API returns DateIssued, Status.Name, Total.Paid but NOT a DatePaid field
      // Use DateIssued when invoice status indicates payment received
      const statusName = inv.Status ? (typeof inv.Status === 'string' ? inv.Status : inv.Status.Name || '') : '';
      const isPaid = statusName.toLowerCase().includes('paid') || (inv.Total && inv.Total.Paid > 0);
      
      if (isPaid && inv.DateIssued) {
        const d = inv.DateIssued.slice(0, 10);
        if (!earliest || d < earliest) earliest = d;
      }
    }
    console.log('  Invoice result for ' + jobId + ': ' + (earliest || 'no paid invoice found'));
    return earliest;
  } catch(e) {
    console.warn('  WARN: invoices for ' + jobId + ': ' + e.message);
    return null;
  }
}

// --- Date helpers ---
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// --- Date engine ---
function calculateMilestones(convertedDate, totalPausedDays) {
  const milestones = {};
  for (const [code, offset] of Object.entries(MILESTONE_OFFSETS)) {
    milestones[code] = {
      target: addDays(convertedDate, offset + totalPausedDays),
      actual: null
    };
  }
  return milestones;
}

function calculateHealth(stage, milestones, isPaused, isExcluded) {
  if (stage >= 11) return 'COMPLETE';
  if (isPaused) return 'PAUSED';
  if (isExcluded) return 'ON_TRACK';

  const today = new Date().toISOString().slice(0, 10);
  const dueTarget = milestones.DUE ? milestones.DUE.target : null;
  if (dueTarget && today > dueTarget) return 'OVERDUE';

  // Buffer remaining = 19 - slip
  // Slip = how far behind the internal target (CC3) we are
  const cc3Target = milestones.CC3 ? milestones.CC3.target : null;
  if (!cc3Target) return 'ON_TRACK';

  // If today is past CC3 target and CC3 not done, calculate slip
  const cc3Actual = milestones.CC3 ? milestones.CC3.actual : null;
  let slip = 0;
  if (!cc3Actual && today > cc3Target) {
    slip = daysBetween(cc3Target, today);
  }
  // Also check CC2 if CC3 hasn't started
  if (stage <= 7) {
    const cc2Target = milestones.CC2 ? milestones.CC2.target : null;
    const cc2Actual = milestones.CC2 ? milestones.CC2.actual : null;
    if (cc2Target && !cc2Actual && today > cc2Target) {
      slip = Math.max(slip, daysBetween(cc2Target, today));
    }
  }
  if (stage <= 2) {
    const cc1Target = milestones.CC1 ? milestones.CC1.target : null;
    const cc1Actual = milestones.CC1 ? milestones.CC1.actual : null;
    if (cc1Target && !cc1Actual && today > cc1Target) {
      slip = Math.max(slip, daysBetween(cc1Target, today));
    }
  }

  const bufferRemaining = BUFFER_DAYS - slip;
  if (bufferRemaining >= 10) return 'ON_TRACK';
  if (bufferRemaining >= 1) return 'WATCH';
  return 'AT_RISK';
}

// --- Resolve stage ---
function resolveStage(detail, jobConfig) {
  // Manual override wins
  if (jobConfig && jobConfig.stage) return jobConfig.stage;

  const statusName = detail.Status
    ? (typeof detail.Status === 'string' ? detail.Status : detail.Status.Name || '')
    : '';
  return STATUS_TO_STAGE[statusName] || 1;
}

// --- Process one job ---
async function processJob(jobId, jobConfig) {
  const detail = await getJobDetail(jobId);
  if (!detail) return null;

  // Customer first name only (safety)
  const custName = detail.Customer
    ? (detail.Customer.CompanyName || detail.Customer.GivenName || '')
    : '';
  const firstName = custName.split(' ')[0] || '';

  // Site suburb
  const site = detail.Site || {};
  const suburb = site.City || site.Suburb || '';

  // Description
  const description = jobConfig.description || detail.Name || '';

  // Category and material from config
  const category = jobConfig.category || null;

  // Day 0 = first deposit invoice paid date
  let convertedDate = jobConfig.convertedDate || null;
  if (!convertedDate) {
    convertedDate = await getFirstPaidInvoiceDate(jobId);
  }

  // Stage
  const stage = resolveStage(detail, jobConfig);

  // Pauses (manual tracking in fab-jobs.json)
  const pauses = jobConfig.pauses || [];
  const today = new Date().toISOString().slice(0, 10);
  let totalPausedDays = 0;
  let isPaused = false;
  for (const p of pauses) {
    if (p.endedOn) {
      totalPausedDays += daysBetween(p.startedOn, p.endedOn);
    } else {
      totalPausedDays += daysBetween(p.startedOn, today);
      isPaused = true;
    }
  }

  // Milestones
  let milestones = {
    CC1: { target: null, actual: null },
    CC2: { target: null, actual: null },
    CC3: { target: null, actual: null },
    DUE: { target: null, actual: null }
  };
  if (convertedDate) {
    milestones = calculateMilestones(convertedDate, totalPausedDays);
  }

  // Apply manual actual dates
  if (jobConfig.actuals) {
    for (const [code, date] of Object.entries(jobConfig.actuals)) {
      if (milestones[code]) milestones[code].actual = date;
    }
  }

  // Health
  const isExcluded = jobConfig.isExcluded || false;
  const health = convertedDate
    ? calculateHealth(stage, milestones, isPaused, isExcluded)
    : 'ON_TRACK';

  // Days calculations
  const dueTarget = milestones.DUE ? milestones.DUE.target : null;
  const daysToDue = dueTarget ? daysBetween(today, dueTarget) : null;
  const cc3Target = milestones.CC3 ? milestones.CC3.target : null;
  const daysToInstall = cc3Target ? daysBetween(today, cc3Target) : null;

  let bufferRemaining = BUFFER_DAYS;
  if (cc3Target) {
    const cc3Actual = milestones.CC3 ? milestones.CC3.actual : null;
    if (!cc3Actual && today > cc3Target) {
      bufferRemaining = BUFFER_DAYS - daysBetween(cc3Target, today);
    }
  }

  return {
    jobNumber: String(jobId),
    customerFirstName: firstName,
    suburb,
    description,
    category,
    convertedDate,
    stage,
    milestones,
    totalPausedDays,
    isPaused,
    isExcluded,
    health,
    daysToDue,
    daysToInstall,
    bufferRemaining,
    lastUpdated: today
  };
}

// --- Main ---
async function main() {
  if (!API_TOKEN) {
    console.error('SIMPRO_API_TOKEN not set');
    process.exit(1);
  }

  let jobList;
  try {
    jobList = JSON.parse(fs.readFileSync(JOB_LIST_FILE, 'utf8'));
  } catch(e) {
    console.error('Cannot read ' + JOB_LIST_FILE + ':', e.message);
    process.exit(1);
  }

  const entries = jobList.jobs || jobList;
  const jobs = [];

  for (const entry of entries) {
    const jobId = typeof entry === 'object' ? entry.id : entry;
    const jobConfig = typeof entry === 'object' ? entry : {};
    console.log('Processing job ' + jobId + '...');

    const result = await processJob(jobId, jobConfig);
    if (result) {
      jobs.push(result);
      console.log('  -> ' + result.customerFirstName + ' | stage ' + result.stage + ' | ' + result.health);
    }
  }

  const output = {
    lastUpdated: new Date().toISOString(),
    totalJobs: jobs.length,
    jobs
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log('\nDone: ' + jobs.length + ' jobs -> ' + OUTPUT_FILE);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
