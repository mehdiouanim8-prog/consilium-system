const TIME_ZONE = 'Africa/Casablanca';
const ADMIN_EMAIL = 'consilium.consultinghq@gmail.com';
const SLOT_MINUTES = 45;
const OPEN_MINUTE = 9 * 60;
const CLOSE_MINUTE = 19 * 60;
const DAILY_LIMIT = 9;
const SESSION_COOKIE = '__Host-consilium_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_REQUEST_BYTES = 32 * 1024;
const ALLOWED_OBJECTIVES = new Set([
  'Business growth', 'Sales and revenue', 'Guidance and strategic advisory',
  'Startup development', 'Acquisition or exit', 'High-ROI opportunities',
  'New opportunities', 'Connections and network',
  'Market research and intelligence', 'Planning and execution',
  'Investment evaluation', 'International expansion', 'Partnerships', 'Other objective'
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (error) {
        if (error instanceof HttpError) {
          return jsonResponse(request, env, {
            ok: false,
            code: error.code,
            message: error.message
          }, error.status);
        }
        console.error('Consilium API request failed:', safeErrorName(error), error && error.code ? `code=${String(error.code).slice(0, 10)}` : '', error && error.routine ? `routine=${String(error.routine).slice(0, 60)}` : '');
        return jsonResponse(request, env, {
          ok: false,
          code: 'INTERNAL_ERROR',
          message: 'The service could not complete this request. Please try again.'
        }, 500);
      }
    }

    if (!env.ASSETS) {
      return new Response('Static asset binding is not configured.', { status: 500 });
    }
    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Frame-Options', 'DENY');
    if (url.pathname.toLowerCase().endsWith('admindashboardconsilium.html')) {
      headers.set('Cache-Control', 'no-store');
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
    } else if (url.pathname === '/') {
      headers.set('Cache-Control', 'no-store');
    }
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers
    });
  }
};

async function handleApi(request, env, ctx, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (method === 'OPTIONS') {
    return preflightResponse(request, env);
  }

  if (path === '/api/health' && method === 'GET') {
    await env.DB.prepare('SELECT 1 AS ready').first();
    return jsonResponse(request, env, {
      ok: true,
      service: 'consilium-system',
      database: 'connected',
      timezone: TIME_ZONE,
      appointmentDurationMinutes: SLOT_MINUTES,
      dailyRequestLimit: DAILY_LIMIT
    });
  }

  if (path === '/api/availability' && method === 'GET') {
    await enforceRateLimit(request, env, 'availability', 100, 60);
    return handleAvailability(request, env, url);
  }

  if (path === '/api/applications' && method === 'POST') {
    assertAllowedOrigin(request, env, false);
    await enforceRateLimit(request, env, 'application-submit', 6, 60 * 60);
    return handleApplicationSubmission(request, env);
  }

  if (path === '/api/webhooks/resend' && method === 'POST') {
    return handleResendWebhook(request, env);
  }

  if (path === '/api/admin/login' && method === 'POST') {
    assertAllowedOrigin(request, env, true);
    await enforceRateLimit(request, env, 'admin-login', 8, 15 * 60);
    return handleAdminLogin(request, env);
  }

  if (path === '/api/admin/logout' && method === 'POST') {
    assertAllowedOrigin(request, env, true);
    return handleAdminLogout(request, env);
  }

  if (path === '/api/admin/me' && method === 'GET') {
    const session = await requireAdmin(request, env);
    return jsonResponse(request, env, {
      ok: true,
      authenticated: true,
      expiresAt: session.expires_at
    });
  }

  if (path.startsWith('/api/admin/')) {
    // Browsers do not send an Origin header on same-origin GET requests, so it is only
    // mandatory for state-changing methods (CSRF protection). If an Origin is present
    // it must always be the site itself or an allowed origin.
    assertAllowedOrigin(request, env, method !== 'GET' && method !== 'HEAD');
    const session = await requireAdmin(request, env);
    await touchSession(env, session.session_hash);
    return handleAdminRoutes(request, env, url, path, method, session);
  }

  throw new HttpError(404, 'NOT_FOUND', 'The requested endpoint does not exist.');
}

function allowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || 'https://consilium-bhl.pages.dev');
  return new Set(configured.split(',').map((value) => value.trim()).filter(Boolean));
}

function corsHeaders(request, env) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  });
  const origin = request.headers.get('Origin');
  const ownOrigin = new URL(request.url).origin;
  if (origin && (origin === ownOrigin || allowedOrigins(env).has(origin))) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return headers;
}

function jsonResponse(request, env, payload, status = 200, extraHeaders = {}) {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(payload), { status, headers });
}

function preflightResponse(request, env) {
  const origin = request.headers.get('Origin');
  const ownOrigin = new URL(request.url).origin;
  if (origin && origin !== ownOrigin && !allowedOrigins(env).has(origin)) {
    return new Response(null, { status: 403, headers: { 'Vary': 'Origin' } });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function assertAllowedOrigin(request, env, required) {
  const origin = request.headers.get('Origin');
  if (!origin) {
    if (required) throw new HttpError(403, 'ORIGIN_REQUIRED', 'This administrative request must come from the Consilium dashboard.');
    return;
  }
  const ownOrigin = new URL(request.url).origin;
  if (origin !== ownOrigin && !allowedOrigins(env).has(origin)) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed to access the Consilium system.');
  }
}

async function handleAvailability(request, env, url) {
  const date = url.searchParams.get('date');
  const month = url.searchParams.get('month');
  if (date && month) throw new HttpError(400, 'INVALID_QUERY', 'Request either a date or a month, not both.');

  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'INVALID_MONTH', 'The requested month is invalid.');
    const [year, monthNumber] = month.split('-').map(Number);
    if (monthNumber < 1 || monthNumber > 12) throw new HttpError(400, 'INVALID_MONTH', 'The requested month is invalid.');
    const first = `${year}-${pad(monthNumber)}-01`;
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const last = `${year}-${pad(monthNumber)}-${pad(lastDay)}`;
    const result = await env.DB.prepare(
      `SELECT appointment_date, appointment_start, appointment_end
       FROM applications
       WHERE appointment_date >= ? AND appointment_date <= ?
         AND status IN ('PENDING', 'ACCEPTED')`
    ).bind(first, last).all();
    const byDate = new Map();
    for (const row of result.results || []) {
      if (!byDate.has(row.appointment_date)) byDate.set(row.appointment_date, []);
      byDate.get(row.appointment_date).push(row);
    }
    const availableDates = {};
    const today = localNowParts();
    for (let day = 1; day <= lastDay; day += 1) {
      const key = `${year}-${pad(monthNumber)}-${pad(day)}`;
      const slots = computeAvailableSlots(key, byDate.get(key) || [], today);
      availableDates[key] = slots.length;
    }
    return jsonResponse(request, env, {
      ok: true,
      month,
      timezone: TIME_ZONE,
      appointmentDurationMinutes: SLOT_MINUTES,
      dailyRequestLimit: DAILY_LIMIT,
      availableDates
    });
  }

  if (!date || !isValidDateKey(date)) {
    throw new HttpError(400, 'INVALID_DATE', 'Select a valid appointment date.');
  }
  const result = await env.DB.prepare(
    `SELECT appointment_date, appointment_start, appointment_end
     FROM applications
     WHERE appointment_date = ? AND status IN ('PENDING', 'ACCEPTED')`
  ).bind(date).all();
  const bookings = result.results || [];
  const dailyLimitReached = bookings.length >= DAILY_LIMIT;
  const slots = dailyLimitReached ? [] : computeAvailableSlots(date, bookings, localNowParts());
  return jsonResponse(request, env, {
    ok: true,
    date,
    timezone: TIME_ZONE,
    appointmentDurationMinutes: SLOT_MINUTES,
    dailyLimit: DAILY_LIMIT,
    activeRequests: bookings.length,
    dailyLimitReached,
    slots
  });
}

function computeAvailableSlots(date, bookings, now) {
  if (!isValidDateKey(date) || date < now.date) return [];
  if (bookings.length >= DAILY_LIMIT) return [];
  const occupied = bookings.map((booking) => ({
    start: timeToMinutes(booking.appointment_start),
    end: timeToMinutes(booking.appointment_end)
  }));
  const slots = [];
  for (let start = OPEN_MINUTE; start + SLOT_MINUTES <= CLOSE_MINUTE; start += SLOT_MINUTES) {
    const end = start + SLOT_MINUTES;
    const startTime = minutesToTime(start);
    if (date === now.date && start <= now.minuteOfDay) continue;
    const overlaps = occupied.some((period) => start < period.end && end > period.start);
    if (!overlaps) slots.push(startTime);
  }
  return slots;
}

async function handleApplicationSubmission(request, env) {
  const body = await readJson(request);
  const application = validateApplication(body);

  if (application.honeypot) {
    throw new HttpError(400, 'INVALID_SUBMISSION', 'We could not process this application. Please refresh the page and try again.');
  }

  const existing = await env.DB.prepare(
    `SELECT id, reference, status FROM applications WHERE idempotency_key = ?`
  ).bind(application.idempotencyKey).first();
  if (existing) {
    return jsonResponse(request, env, {
      ok: true,
      reference: existing.reference,
      status: existing.status,
      replayed: true
    });
  }

  const id = crypto.randomUUID();
  const reference = await makeReference(env);
  const now = new Date().toISOString();
  const answers = {
    name: application.fullName,
    email: application.email,
    phone: application.phone,
    country: application.country,
    city: application.city,
    reference_url: application.referenceUrl,
    applicant_type: application.applicantType,
    industry_market: application.industryMarket,
    objectives: application.objectives,
    working_toward: application.workingToward,
    additional_context: application.additionalContext,
    ability_to_accept_change: application.abilityToAcceptChange,
    appointment_date: application.appointmentDate,
    appointment_time: application.appointmentStart,
    applicant_timezone: application.applicantTimezone,
    site_language: application.siteLanguage
  };

  try {
    await env.DB.prepare(
      `INSERT INTO applications (
        id, reference, idempotency_key, full_name, email, email_normalized, phone,
        country, city, reference_url, applicant_type, industry_market, objectives_json,
        working_toward, additional_context, ability_to_accept_change,
        appointment_date, appointment_start, appointment_end, appointment_timezone,
        applicant_timezone, status, answers_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?
      )`
    ).bind(
      id,
      reference,
      application.idempotencyKey,
      application.fullName,
      application.email,
      application.email.toLowerCase(),
      application.phone,
      application.country,
      application.city,
      application.referenceUrl,
      application.applicantType,
      application.industryMarket,
      JSON.stringify(application.objectives),
      application.workingToward,
      application.additionalContext,
      application.abilityToAcceptChange,
      application.appointmentDate,
      application.appointmentStart,
      application.appointmentEnd,
      TIME_ZONE,
      application.applicantTimezone,
      JSON.stringify(answers),
      now,
      now
    ).run();
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (message.includes('DAILY_LIMIT_REACHED')) {
      throw new HttpError(409, 'DAILY_LIMIT_REACHED', 'This date has reached the maximum of nine active appointment requests. Please choose another date.');
    }
    if (message.includes('APPOINTMENT_CONFLICT') || message.includes('idx_applications_active_exact_slot')) {
      throw new HttpError(409, 'APPOINTMENT_CONFLICT', 'That appointment time has just been reserved. Please select another available time.');
    }
    if (message.includes('applications.idempotency_key') || message.includes('applications_idempotency_key_key')) {
      const replay = await env.DB.prepare(
        `SELECT reference, status FROM applications WHERE idempotency_key = ?`
      ).bind(application.idempotencyKey).first();
      if (replay) {
        return jsonResponse(request, env, { ok: true, reference: replay.reference, status: replay.status, replayed: true });
      }
    }
    throw error;
  }

  // Persistence has succeeded. Notifications are deliberately best-effort and cannot
  // roll back or reject a stored application.
  const saved = await getApplicationById(env, id);
  await Promise.all([
    sendApplicationNotification(env, saved, 'APPLICATION_ADMIN'),
    sendApplicationNotification(env, saved, 'APPLICATION_APPLICANT')
  ]);
  const emailSummary = await updateEmailSummary(env, id);

  return jsonResponse(request, env, {
    ok: true,
    reference,
    status: 'PENDING',
    emailNotificationStatus: emailSummary
  }, 201);
}

function validateApplication(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'The application data is invalid.');
  }
  const honeypot = cleanText(body.website, 300);
  const fullName = requiredText(body.name, 'Full name', 2, 180);
  const email = requiredText(body.email, 'Email address', 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  const phone = requiredText(body.phone, 'Phone number', 7, 40);
  const country = requiredText(body.country, 'Country', 2, 100);
  const city = requiredText(body.city, 'City', 1, 120);
  const referenceUrl = optionalText(body.reference_url, 500);
  if (referenceUrl) {
    let parsed;
    try { parsed = new URL(referenceUrl); } catch (_error) { throw new HttpError(400, 'INVALID_REFERENCE_URL', 'Enter a valid website or reference URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'INVALID_REFERENCE_URL', 'The reference URL must use HTTP or HTTPS.');
  }
  const applicantType = requiredText(body.applicant_type, 'Applicant type', 2, 160);
  const industryMarket = optionalText(body.industry_market, 200);
  const workingToward = requiredText(body.working_toward, 'Your objectives', 5, 8000);
  const additionalContext = optionalText(body.additional_context, 8000);
  const siteLanguage = ['en', 'fr', 'ar'].includes(cleanText(body.site_language, 5)) ? cleanText(body.site_language, 5) : 'en';
  const ability = Number(body.ability_to_accept_change);
  if (!Number.isInteger(ability) || ability < 1 || ability > 10) {
    throw new HttpError(400, 'INVALID_CHANGE_RATING', 'Select an ability-to-accept-change rating from 1 to 10.');
  }

  const rawObjectives = Array.isArray(body.objectives) ? body.objectives : [];
  if (rawObjectives.length > 30) throw new HttpError(400, 'INVALID_OBJECTIVES', 'Too many objectives were selected.');
  const objectives = [...new Set(rawObjectives.map((value) => cleanText(value, 120)).filter(Boolean))];
  if (objectives.some((value) => !ALLOWED_OBJECTIVES.has(value))) {
    throw new HttpError(400, 'INVALID_OBJECTIVES', 'One or more selected objectives are not valid.');
  }

  const appointmentDate = cleanText(body.appointment_date, 10);
  const appointmentStart = cleanText(body.appointment_time, 5);
  if (!isValidDateKey(appointmentDate)) throw new HttpError(400, 'INVALID_APPOINTMENT_DATE', 'Select a valid appointment date.');
  const startMinutes = timeToMinutes(appointmentStart);
  if (startMinutes === null || startMinutes < OPEN_MINUTE || startMinutes + SLOT_MINUTES > CLOSE_MINUTE || (startMinutes - OPEN_MINUTE) % SLOT_MINUTES !== 0) {
    throw new HttpError(400, 'INVALID_APPOINTMENT_TIME', 'Select one of the available 45-minute appointment times between 09:00 and 19:00.');
  }
  const localNow = localNowParts();
  if (appointmentDate < localNow.date || (appointmentDate === localNow.date && startMinutes <= localNow.minuteOfDay)) {
    throw new HttpError(400, 'APPOINTMENT_IN_PAST', 'The selected appointment time has already passed. Please select a future time.');
  }

  const applicantTimezone = validTimezone(optionalText(body.applicant_timezone, 80));
  const idempotencyKey = cleanText(body.submission_nonce, 100);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
    throw new HttpError(400, 'INVALID_SUBMISSION_KEY', 'Refresh the application page and try submitting again.');
  }

  return {
    honeypot,
    fullName,
    email,
    phone,
    country,
    city,
    referenceUrl,
    applicantType,
    industryMarket,
    objectives,
    workingToward,
    additionalContext,
    abilityToAcceptChange: ability,
    appointmentDate,
    appointmentStart,
    appointmentEnd: minutesToTime(startMinutes + SLOT_MINUTES),
    applicantTimezone,
    siteLanguage,
    idempotencyKey
  };
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim().slice(0, maxLength);
}

function requiredText(value, label, minLength, maxLength) {
  const text = cleanText(value, maxLength);
  if (text.length < minLength) throw new HttpError(400, 'MISSING_FIELD', `${label} is required.`);
  return text;
}

function optionalText(value, maxLength) {
  return cleanText(value, maxLength);
}

function validTimezone(value) {
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch (_error) {
    return 'UTC';
  }
}

async function readJson(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'JSON_REQUIRED', 'Submit the application using the JSON API.');
  }
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_REQUEST_BYTES) throw new HttpError(413, 'REQUEST_TOO_LARGE', 'The submitted application is too large.');
  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) throw new HttpError(413, 'REQUEST_TOO_LARGE', 'The submitted application is too large.');
  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw new HttpError(400, 'INVALID_JSON', 'The submitted application data is not valid JSON.');
  }
}

async function makeReference(env) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    const reference = `CNS-${localNowParts().date.slice(0, 4)}-${suffix}`;
    const exists = await env.DB.prepare('SELECT 1 FROM applications WHERE reference = ?').bind(reference).first();
    if (!exists) return reference;
  }
  throw new HttpError(503, 'REFERENCE_GENERATION_FAILED', 'A reference number could not be generated. Please try again.');
}

async function getApplicationById(env, id) {
  const row = await env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'APPLICATION_NOT_FOUND', 'The application could not be found.');
  return hydrateApplication(row);
}

function hydrateApplication(row) {
  let objectives = [];
  let answers = {};
  try { objectives = JSON.parse(row.objectives_json || '[]'); } catch (_error) { objectives = []; }
  try { answers = JSON.parse(row.answers_json || '{}'); } catch (_error) { answers = {}; }
  return Object.assign({}, row, { objectives, answers });
}

async function enforceRateLimit(request, env, scope, maxRequests, windowSeconds) {
  const ip = clientIp(request);
  const key = await sha256Hex(`${scope}:${ip}`);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  await env.DB.prepare(
    `INSERT INTO api_rate_limits (rate_key, window_start, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT(rate_key, window_start)
     DO UPDATE SET request_count = api_rate_limits.request_count + 1`
  ).bind(key, windowStart).run();
  const row = await env.DB.prepare(
    'SELECT request_count FROM api_rate_limits WHERE rate_key = ? AND window_start = ?'
  ).bind(key, windowStart).first();
  if (Number(row && row.request_count) > maxRequests) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.');
  }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function clientIp(request) {
  // Railway's edge proxy sets X-Real-IP / X-Forwarded-For to the connecting client.
  const real = (request.headers.get('X-Real-IP') || '').trim();
  if (real) return real;
  const forwarded = (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim();
  return forwarded || 'unknown-client';
}

function localNowParts() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const values = {};
  for (const part of parts) values[part.type] = part.value;
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute)
  };
}

function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function timeToMinutes(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

async function handleAdminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    throw new HttpError(503, 'ADMIN_NOT_CONFIGURED', 'Administrator access has not been configured. Set the ADMIN_PASSWORD environment variable first.');
  }
  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || password.length > 256 || !constantTimeEqual(password, env.ADMIN_PASSWORD)) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'The administrator password is incorrect.');
  }

  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes, (value) => value.toString(16).padStart(2, '0')).join('');
  const sessionHash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  const ip = clientIp(request);
  const ipHash = await sha256Hex(`admin-session:${ip}`);

  await env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now.toISOString()).run();
  await env.DB.prepare(
    `INSERT INTO admin_sessions (session_hash, created_at, expires_at, last_seen_at, ip_hash)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(sessionHash, now.toISOString(), expires.toISOString(), now.toISOString(), ipHash).run();

  const cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
  return jsonResponse(request, env, { ok: true, authenticated: true, expiresAt: expires.toISOString() }, 200, { 'Set-Cookie': cookie });
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % (a.length || 1)] || 0) ^ (b[index % (b.length || 1)] || 0);
  }
  return difference === 0;
}

function cookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

async function requireAdmin(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    throw new HttpError(401, 'NOT_AUTHENTICATED', 'Administrator sign-in is required.');
  }
  const sessionHash = await sha256Hex(token);
  const session = await env.DB.prepare(
    'SELECT session_hash, expires_at FROM admin_sessions WHERE session_hash = ? AND expires_at > ?'
  ).bind(sessionHash, new Date().toISOString()).first();
  if (!session) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE session_hash = ?').bind(sessionHash).run();
    throw new HttpError(401, 'SESSION_EXPIRED', 'Your administrator session has expired. Please sign in again.');
  }
  return session;
}

async function touchSession(env, sessionHash) {
  await env.DB.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE session_hash = ?')
    .bind(new Date().toISOString(), sessionHash).run();
}

async function handleAdminLogout(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token && /^[a-f0-9]{64}$/i.test(token)) {
    const hash = await sha256Hex(token);
    await env.DB.prepare('DELETE FROM admin_sessions WHERE session_hash = ?').bind(hash).run();
  }
  const cookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  return jsonResponse(request, env, { ok: true }, 200, { 'Set-Cookie': cookie });
}

async function handleAdminRoutes(request, env, url, path, method, session) {
  if (path === '/api/admin/applications' && method === 'GET') {
    await enforceRateLimit(request, env, 'admin-read', 180, 60);
    return listApplications(request, env, url);
  }

  const match = path.match(/^\/api\/admin\/applications\/([^/]+)(?:\/(accept|decline|notes|notifications\/retry))?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2] || '';
    if (!action && method === 'GET') return getApplicationDetail(request, env, id);
    if (action === 'accept' && method === 'POST') return changeApplicationStatus(request, env, id, 'ACCEPTED', session);
    if (action === 'decline' && method === 'POST') return changeApplicationStatus(request, env, id, 'DECLINED', session);
    if (action === 'notes' && method === 'POST') return updateApplicationNotes(request, env, id, session);
    if (action === 'notifications/retry' && method === 'POST') return retryApplicationNotifications(request, env, id, session);
  }

  throw new HttpError(404, 'NOT_FOUND', 'The requested administrative endpoint does not exist.');
}

async function listApplications(request, env, url) {
  const status = (url.searchParams.get('status') || 'ALL').toUpperCase();
  if (!['ALL', 'PENDING', 'ACCEPTED', 'DECLINED'].includes(status)) {
    throw new HttpError(400, 'INVALID_STATUS', 'The selected application status filter is invalid.');
  }
  const limit = clampInteger(url.searchParams.get('limit'), 1, 100, 50);
  const offset = clampInteger(url.searchParams.get('offset'), 0, 100000, 0);
  const query = cleanText(url.searchParams.get('q'), 120);
  const conditions = [];
  const values = [];
  if (status !== 'ALL') {
    conditions.push('status = ?');
    values.push(status);
  }
  if (query) {
    conditions.push('(position(lower(?) in lower(full_name)) > 0 OR position(lower(?) in lower(email)) > 0 OR position(lower(?) in lower(reference)) > 0 OR position(lower(?) in lower(city)) > 0)');
    values.push(query, query, query, query);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM applications ${where}`).bind(...values).first();
  const applications = await env.DB.prepare(
    `SELECT id, reference, full_name, email, status, appointment_date, appointment_start,
            appointment_end, applicant_type, industry_market, created_at,
            admin_email_status, applicant_email_status, email_notification_status
     FROM applications ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(...values, limit, offset).all();
  const countResult = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count FROM applications GROUP BY status`
  ).all();
  const counts = { PENDING: 0, ACCEPTED: 0, DECLINED: 0 };
  for (const row of countResult.results || []) counts[row.status] = Number(row.count);
  return jsonResponse(request, env, {
    ok: true,
    applications: applications.results || [],
    total: Number(countRow && countRow.total) || 0,
    counts,
    limit,
    offset
  });
}

function clampInteger(value, min, max, fallback) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

async function getApplicationDetail(request, env, id) {
  const row = await env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'APPLICATION_NOT_FOUND', 'The application could not be found.');
  const notifications = await env.DB.prepare(
    `SELECT id, event_type, recipient, status, attempt_count, provider_message_id, last_error,
            created_at, updated_at
     FROM email_notifications WHERE application_id = ? ORDER BY created_at ASC`
  ).bind(id).all();
  return jsonResponse(request, env, {
    ok: true,
    application: Object.assign(hydrateApplication(row), { notifications: notifications.results || [] })
  });
}

async function changeApplicationStatus(request, env, id, newStatus, session) {
  const body = await readJson(request);
  void body;
  const existing = await getApplicationById(env, id);
  if (existing.status !== 'PENDING') {
    throw new HttpError(409, 'INVALID_STATUS_TRANSITION', 'Only pending applications can be accepted or declined.');
  }
  const now = new Date().toISOString();
  try {
    const result = await env.DB.prepare(
      `UPDATE applications SET status = ?, updated_at = ?
       WHERE id = ? AND status = 'PENDING'`
    ).bind(newStatus, now, id).run();
    if (!result.meta || Number(result.meta.changes) !== 1) {
      throw new HttpError(409, 'APPLICATION_ALREADY_REVIEWED', 'This application has already been reviewed. Refresh the dashboard.');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = String(error && error.message ? error.message : error);
    if (message.includes('APPOINTMENT_CONFLICT') || message.includes('DAILY_LIMIT_REACHED')) {
      throw new HttpError(409, 'APPOINTMENT_CONFLICT', 'The requested appointment can no longer be accepted because the slot is not available.');
    }
    throw error;
  }

  const updated = await getApplicationById(env, id);
  await sendApplicationNotification(env, updated, newStatus === 'ACCEPTED' ? 'ACCEPTED_APPLICANT' : 'DECLINED_APPLICANT');
  await updateEmailSummary(env, id);
  await writeAudit(env, newStatus, id, { reference: updated.reference }, session.session_hash);
  return jsonResponse(request, env, { ok: true, application: { id, reference: updated.reference, status: newStatus } });
}

async function updateApplicationNotes(request, env, id, session) {
  const body = await readJson(request);
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 10000) : '';
  const result = await env.DB.prepare(
    'UPDATE applications SET admin_notes = ?, updated_at = ? WHERE id = ?'
  ).bind(notes, new Date().toISOString(), id).run();
  if (!result.meta || Number(result.meta.changes) !== 1) throw new HttpError(404, 'APPLICATION_NOT_FOUND', 'The application could not be found.');
  await writeAudit(env, 'NOTES_UPDATED', id, { length: notes.length }, session.session_hash);
  return jsonResponse(request, env, { ok: true });
}

async function retryApplicationNotifications(request, env, id, session) {
  const body = await readJson(request);
  void body;
  const application = await getApplicationById(env, id);
  const failed = await env.DB.prepare(
    `SELECT event_type FROM email_notifications
     WHERE application_id = ? AND status = 'FAILED'`
  ).bind(id).all();
  const rows = failed.results || [];
  for (const row of rows) {
    await sendApplicationNotification(env, application, row.event_type);
  }
  const summary = await updateEmailSummary(env, id);
  await writeAudit(env, 'EMAIL_RETRY', id, { retried: rows.length }, session.session_hash);
  return jsonResponse(request, env, { ok: true, retried: rows.length, emailNotificationStatus: summary });
}

async function writeAudit(env, action, applicationId, details, actorHash) {
  const ipHash = actorHash || 'admin-session';
  await env.DB.prepare(
    `INSERT INTO admin_audit_log (id, action, application_id, actor, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), action, applicationId, ipHash.slice(0, 12), JSON.stringify(details || {}), new Date().toISOString()).run();
}

// Email delivery. Brevo (works with one verified sender address, no domain needed) or Resend
// (needs a verified domain). Both use HTTPS APIs, which Railway allows on every plan.
export function emailProvider(env) {
  if (env.BREVO_API_KEY && env.BREVO_FROM_EMAIL) return 'brevo';
  if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) return 'resend';
  return '';
}

function parseSender(value, fallbackName) {
  const text = String(value || '').trim();
  const match = text.match(/^(.*)<([^<>]+)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, '') || fallbackName || 'Consilium', email: match[2].trim() };
  }
  return { name: fallbackName || 'Consilium', email: text };
}

// Sends one email and returns the provider's message id. Throws on any failure.
async function deliverEmail(env, message, reference, eventType) {
  const provider = emailProvider(env);
  let response;
  if (provider === 'brevo') {
    response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: parseSender(env.BREVO_FROM_EMAIL, env.BREVO_FROM_NAME),
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text
      }),
      signal: AbortSignal.timeout(12000)
    });
  } else if (provider === 'resend') {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: [
          { name: 'application_reference', value: reference },
          { name: 'notification_type', value: eventType.toLowerCase() }
        ]
      }),
      signal: AbortSignal.timeout(12000)
    });
  } else {
    throw new Error('Email delivery is not configured.');
  }
  const responseText = await response.text();
  let result = {};
  try { result = responseText ? JSON.parse(responseText) : {}; } catch (_error) { result = {}; }
  const messageId = provider === 'brevo' ? result.messageId : result.id;
  if (!response.ok || !messageId) {
    const detail = result && result.message ? result.message : `${provider === 'brevo' ? 'Brevo' : 'Resend'} returned HTTP ${response.status}.`;
    throw new Error(String(detail).slice(0, 800));
  }
  return String(messageId);
}

async function sendApplicationNotification(env, application, eventType) {
  const config = notificationContent(application, eventType);
  if (!config) return 'FAILED';
  const now = new Date().toISOString();
  const notificationId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO email_notifications (
       id, application_id, event_type, recipient, status, attempt_count, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'PENDING', 1, '', ?, ?)
     ON CONFLICT(application_id, event_type)
     DO UPDATE SET status = 'PENDING', attempt_count = email_notifications.attempt_count + 1,
                   last_error = '', updated_at = excluded.updated_at`
  ).bind(notificationId, application.id, eventType, config.to, now, now).run();

  if (!emailProvider(env)) {
    const message = 'Email delivery is not configured. Set BREVO_API_KEY and BREVO_FROM_EMAIL (or RESEND_API_KEY and RESEND_FROM_EMAIL).';
    await markNotificationFailed(env, application.id, eventType, message);
    await updateEmailSummary(env, application.id);
    return 'FAILED';
  }

  try {
    const providerMessageId = await deliverEmail(env, config, application.reference, eventType);
    await env.DB.prepare(
      `UPDATE email_notifications
       SET status = 'SENT', provider_message_id = ?, last_error = '', updated_at = ?
       WHERE application_id = ? AND event_type = ?`
    ).bind(providerMessageId, new Date().toISOString(), application.id, eventType).run();

    // A webhook may arrive very quickly, before the send response was saved.
    const latestEvent = await env.DB.prepare(
      `SELECT event_type FROM resend_webhook_events WHERE email_id = ? ORDER BY received_at DESC LIMIT 1`
    ).bind(providerMessageId).first();
    if (latestEvent) {
      const status = mapResendEventStatus(latestEvent.event_type);
      if (status) {
        await env.DB.prepare(
          `UPDATE email_notifications SET status = ?, updated_at = ?
           WHERE application_id = ? AND event_type = ?`
        ).bind(status, new Date().toISOString(), application.id, eventType).run();
      }
    }
    await updateEmailSummary(env, application.id);
    return 'SENT';
  } catch (error) {
    await markNotificationFailed(env, application.id, eventType, String(error && error.message ? error.message : 'Email provider request failed.').slice(0, 1000));
    await updateEmailSummary(env, application.id);
    return 'FAILED';
  }
}

// Re-sends notifications that FAILED (used by the background job in index.js).
// Never throws for a single bad row; a failure here can never affect stored applications.
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_MIN_AGE_MS = 2 * 60 * 1000;
const RETRY_BATCH_SIZE = 20;

export async function retryFailedNotifications(env) {
  if (!emailProvider(env)) return 0;
  const cutoff = new Date(Date.now() - RETRY_MIN_AGE_MS).toISOString();
  const pending = await env.DB.prepare(
    `SELECT application_id, event_type FROM email_notifications
     WHERE status = 'FAILED' AND attempt_count < ? AND updated_at < ?
     ORDER BY updated_at ASC LIMIT ?`
  ).bind(RETRY_MAX_ATTEMPTS, cutoff, RETRY_BATCH_SIZE).all();
  const rows = pending.results || [];
  const touched = new Set();
  let retried = 0;
  for (const row of rows) {
    try {
      const application = await getApplicationById(env, row.application_id);
      await sendApplicationNotification(env, application, row.event_type);
      touched.add(row.application_id);
      retried += 1;
    } catch (error) {
      console.error('Email retry skipped:', safeErrorName(error));
    }
  }
  for (const id of touched) {
    try { await updateEmailSummary(env, id); } catch (_error) { /* best effort */ }
  }
  return retried;
}

function notificationContent(application, eventType) {
  const name = application.full_name;
  const reference = application.reference;
  const appointment = `${application.appointment_date} at ${application.appointment_start}–${application.appointment_end} (${TIME_ZONE})`;
  const lang = application.answers && ['en', 'fr', 'ar'].includes(application.answers.site_language)
    ? application.answers.site_language : 'en';

  const applicantCopy = {
    en: {
      receivedSubject: 'Your Consilium Application — Received',
      receivedTitle: 'Application received',
      receivedBody: `We have successfully received your application. Your information is currently under review, and our team will get back to you shortly.`,
      requested: 'Your requested appointment',
      pending: 'Your requested appointment time is not confirmed until you receive a separate confirmation from Consilium.',
      reference: 'Your application reference is',
      acceptedSubject: `Your Consilium appointment request has been accepted — ${reference}`,
      acceptedBody: 'Consilium has accepted your application and appointment request.',
      scheduled: 'Your appointment is scheduled for',
      declinedSubject: `Update on your Consilium application — ${reference}`,
      declinedBody: 'Thank you for your interest in Consilium. After reviewing your application, we are unable to proceed with it at this time. The appointment request has been declined and the requested time has been released.',
      hello: 'Hello', thanks: 'Thank you for applying to Consilium.', appreciation: 'We appreciate the time you took to apply.'
    },
    fr: {
      receivedSubject: 'Votre candidature Consilium — Reçue',
      receivedTitle: 'Candidature reçue',
      receivedBody: 'Nous avons bien reçu votre candidature. Vos informations sont actuellement examinées et notre équipe vous répondra prochainement.',
      requested: 'Votre rendez-vous demandé',
      pending: 'L’horaire demandé n’est pas confirmé tant que vous n’avez pas reçu une confirmation distincte de Consilium.',
      reference: 'Votre référence de candidature est',
      acceptedSubject: `Votre demande de rendez-vous Consilium a été acceptée — ${reference}`,
      acceptedBody: 'Consilium a accepté votre candidature et votre demande de rendez-vous.',
      scheduled: 'Votre rendez-vous est prévu le',
      declinedSubject: `Mise à jour de votre candidature Consilium — ${reference}`,
      declinedBody: 'Merci pour votre intérêt pour Consilium. Après examen de votre candidature, nous ne sommes pas en mesure de poursuivre celle-ci pour le moment. La demande de rendez-vous a été refusée et le créneau demandé a été libéré.',
      hello: 'Bonjour', thanks: 'Merci d’avoir candidaté auprès de Consilium.', appreciation: 'Nous vous remercions du temps consacré à votre candidature.'
    },
    ar: {
      receivedSubject: 'طلب Consilium — تم الاستلام',
      receivedTitle: 'تم استلام الطلب',
      receivedBody: 'تم استلام طلبك بنجاح. طلبك قيد المراجعة حالياً وسيتواصل معك فريقنا قريباً.',
      requested: 'الموعد المطلوب',
      pending: 'لا يتم تأكيد الوقت المطلوب حتى تتلقى تأكيداً منفصلاً من Consilium.',
      reference: 'مرجع طلبك هو',
      acceptedSubject: `تم قبول طلب موعد Consilium — ${reference}`,
      acceptedBody: 'قبلت Consilium طلبك وطلب الموعد.',
      scheduled: 'موعدك مقرر في',
      declinedSubject: `تحديث بشأن طلب Consilium — ${reference}`,
      declinedBody: 'شكراً لاهتمامك بـ Consilium. بعد مراجعة طلبك، لا يمكننا المضي فيه في الوقت الحالي. تم رفض طلب الموعد وتحرير الوقت المطلوب.',
      hello: 'مرحباً', thanks: 'شكراً لتقديم طلبك إلى Consilium.', appreciation: 'نقدّر الوقت الذي خصصته لتقديم طلبك.'
    }
  }[lang];

  if (eventType === 'APPLICATION_ADMIN') {
    const fields = [
      ['Application reference', reference], ['Applicant name', name], ['Email', application.email], ['Phone', application.phone],
      ['Country', application.country], ['City', application.city], ['Reference page', application.reference_url || 'Not provided'],
      ['Applicant type', application.applicant_type], ['Industry or market', application.industry_market || 'Not provided'],
      ['Objectives', (application.objectives || []).join(', ') || 'Not selected'],
      ['Working towards / how Consilium could help', application.working_toward], ['Additional context', application.additional_context || 'Not provided'],
      ['Ability to accept change', String(application.ability_to_accept_change) + '/10'], ['Requested appointment', appointment],
      ['Applicant timezone', application.applicant_timezone || 'Unknown'], ['Application status', application.status], ['Submitted at (UTC)', application.created_at]
    ];
    const htmlTable = `<table cellpadding="7" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px">${fields.map(([label, value]) => `<tr><th align="left" valign="top" style="border:1px solid #ddd;background:#f5f5f5">${escapeHtml(label)}</th><td style="border:1px solid #ddd;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`).join('')}</table>`;
    const textDetails = fields.map(([label, value]) => `${label}: ${value}`).join('\n');
    return {to:ADMIN_EMAIL,subject:`New Consilium Application — ${reference}`,html:`<h2>New Consilium application received</h2><p>A new application is awaiting review.</p>${htmlTable}`,text:`A new Consilium application is awaiting review.\n\n${textDetails}`};
  }
  if (eventType === 'APPLICATION_APPLICANT') {
    return {to:application.email,subject:applicantCopy.receivedSubject,html:`<p>${applicantCopy.hello} ${escapeHtml(name)},</p><p>${applicantCopy.thanks}</p><p>${applicantCopy.receivedBody}</p><p>${applicantCopy.requested}: <strong>${escapeHtml(appointment)}</strong>.</p><p>${applicantCopy.pending}</p><p>${applicantCopy.reference} <strong>${escapeHtml(reference)}</strong>.</p><p>${applicantCopy.appreciation}</p><p>Consilium<br>Strategy · Intelligence · Execution</p>`,text:`${applicantCopy.hello} ${name},\n\n${applicantCopy.thanks}\n\n${applicantCopy.receivedBody}\n\n${applicantCopy.requested}: ${appointment}.\n\n${applicantCopy.pending}\n\n${applicantCopy.reference} ${reference}.\n\n${applicantCopy.appreciation}\n\nConsilium\nStrategy · Intelligence · Execution`};
  }
  if (eventType === 'ACCEPTED_APPLICANT') {
    return {to:application.email,subject:applicantCopy.acceptedSubject,html:`<p>${applicantCopy.hello} ${escapeHtml(name)},</p><p>${applicantCopy.acceptedBody}</p><p>${applicantCopy.scheduled}: <strong>${escapeHtml(appointment)}</strong>.</p><p>${applicantCopy.reference} <strong>${escapeHtml(reference)}</strong>.</p><p>Consilium<br>Strategy · Intelligence · Execution</p>`,text:`${applicantCopy.hello} ${name},\n\n${applicantCopy.acceptedBody}\n\n${applicantCopy.scheduled}: ${appointment}.\n\n${applicantCopy.reference} ${reference}.\n\nConsilium\nStrategy · Intelligence · Execution`};
  }
  if (eventType === 'DECLINED_APPLICANT') {
    return {to:application.email,subject:applicantCopy.declinedSubject,html:`<p>${applicantCopy.hello} ${escapeHtml(name)},</p><p>${applicantCopy.declinedBody}</p><p>${applicantCopy.reference} <strong>${escapeHtml(reference)}</strong>.</p><p>${applicantCopy.appreciation}</p><p>Consilium<br>Strategy · Intelligence · Execution</p>`,text:`${applicantCopy.hello} ${name},\n\n${applicantCopy.declinedBody}\n\n${applicantCopy.reference} ${reference}.\n\n${applicantCopy.appreciation}\n\nConsilium\nStrategy · Intelligence · Execution`};
  }
  return null;
}
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function markNotificationFailed(env, applicationId, eventType, message) {
  await env.DB.prepare(
    `UPDATE email_notifications
     SET status = 'FAILED', last_error = ?, updated_at = ?
     WHERE application_id = ? AND event_type = ?`
  ).bind(message, new Date().toISOString(), applicationId, eventType).run();
}

async function updateEmailSummary(env, applicationId) {
  const result = await env.DB.prepare(
    'SELECT event_type, status, last_error FROM email_notifications WHERE application_id = ?'
  ).bind(applicationId).all();
  const rows = result.results || [];
  const statuses = rows.map((row) => row.status);
  let summary = 'PENDING';
  if (statuses.length && statuses.every((status) => status === 'DELIVERED')) summary = 'DELIVERED';
  else if (statuses.length && statuses.every((status) => ['SENT', 'DELIVERED', 'DELIVERY_DELAYED'].includes(status))) summary = 'SENT';
  else if (statuses.some((status) => ['FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED'].includes(status))) {
    summary = statuses.some((status) => ['SENT', 'DELIVERED', 'DELIVERY_DELAYED'].includes(status)) ? 'PARTIAL' : 'FAILED';
  }
  const errors = rows.filter((row) => row.last_error).map((row) => `${row.event_type}: ${row.last_error}`).join('\n').slice(0, 4000);
  const adminStatus = rows.find((row) => row.event_type === 'APPLICATION_ADMIN')?.status || 'PENDING';
  const applicantStatus = rows.find((row) => ['APPLICATION_APPLICANT', 'ACCEPTED_APPLICANT', 'DECLINED_APPLICANT'].includes(row.event_type))?.status || 'PENDING';
  await env.DB.prepare(
    `UPDATE applications SET email_notification_status = ?, email_notification_error = ?,
       admin_email_status = ?, applicant_email_status = ?, updated_at = updated_at WHERE id = ?`
  ).bind(summary, errors, adminStatus, applicantStatus, applicationId).run();
  return summary;
}

async function handleResendWebhook(request, env) {
  if (!env.RESEND_WEBHOOK_SECRET) {
    throw new HttpError(503, 'WEBHOOK_NOT_CONFIGURED', 'The email delivery webhook is not configured.');
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_REQUEST_BYTES) throw new HttpError(413, 'WEBHOOK_TOO_LARGE', 'The webhook payload is too large.');
  const verified = await verifyResendSignature(request.headers, rawBody, env.RESEND_WEBHOOK_SECRET);
  if (!verified) throw new HttpError(400, 'INVALID_WEBHOOK_SIGNATURE', 'The email provider signature could not be verified.');

  let event;
  try { event = JSON.parse(rawBody); } catch (_error) { throw new HttpError(400, 'INVALID_WEBHOOK_BODY', 'The email provider payload is invalid.'); }
  const eventId = request.headers.get('svix-id') || '';
  const eventType = cleanText(event.type, 80);
  const emailId = cleanText(event.data && event.data.email_id, 120);
  if (!eventId || !eventType) throw new HttpError(400, 'INVALID_WEBHOOK_BODY', 'The email provider payload is incomplete.');

  const inserted = await env.DB.prepare(
    `INSERT INTO resend_webhook_events (event_id, email_id, event_type, event_json, received_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING`
  ).bind(eventId, emailId, eventType, rawBody.slice(0, 30000), new Date().toISOString()).run();
  if (!inserted.meta || Number(inserted.meta.changes) === 0) {
    return jsonResponse(request, env, { ok: true, duplicate: true });
  }

  const status = mapResendEventStatus(eventType);
  if (emailId && status) {
    const notificationRows = await env.DB.prepare(
      'SELECT application_id FROM email_notifications WHERE provider_message_id = ?'
    ).bind(emailId).all();
    await env.DB.prepare(
      `UPDATE email_notifications SET status = ?, updated_at = ?
       WHERE provider_message_id = ?`
    ).bind(status, new Date().toISOString(), emailId).run();
    for (const row of notificationRows.results || []) {
      await updateEmailSummary(env, row.application_id);
    }
  }
  return jsonResponse(request, env, { ok: true });
}

function mapResendEventStatus(eventType) {
  const map = {
    'email.sent': 'SENT',
    'email.delivered': 'DELIVERED',
    'email.delivery_delayed': 'DELIVERY_DELAYED',
    'email.failed': 'FAILED',
    'email.bounced': 'BOUNCED',
    'email.complained': 'COMPLAINED',
    'email.suppressed': 'SUPPRESSED'
  };
  return map[eventType] || null;
}

async function verifyResendSignature(headers, rawBody, secret) {
  const id = headers.get('svix-id') || '';
  const timestamp = headers.get('svix-timestamp') || '';
  const signatureHeader = headers.get('svix-signature') || '';
  const timestampNumber = Number(timestamp);
  if (!id || !timestamp || !signatureHeader || !Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;

  const encodedSecret = String(secret).replace(/^whsec_/, '');
  let rawKey;
  try {
    const decoded = atob(encodedSecret);
    rawKey = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch (_error) {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signed)));
  const candidates = signatureHeader.split(' ').map((value) => value.trim()).filter(Boolean);
  return candidates.some((candidate) => {
    const parts = candidate.split(',');
    return parts.length === 2 && parts[0] === 'v1' && constantTimeEqual(parts[1], expected);
  });
}

function safeErrorName(error) {
  if (!error) return 'UnknownError';
  const name = typeof error.name === 'string' ? error.name : 'Error';
  return name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50) || 'Error';
}
