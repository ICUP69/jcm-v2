/**
 * JCruzz Media — review form endpoint (POST /api/review).
 *
 * The site is static HTML; this Vercel Function exists only so /reviews has somewhere to
 * POST. Vercel deploys every file in /api as a function, so nothing about how the rest
 * of the site is served changes. `.mjs` rather than `.js` because there is no
 * package.json declaring ES modules, and Vercel needs one or the other.
 *
 * Ported from the Lake & Pine review Worker. Same flow, same spam checks, same Resend
 * account — see that repo's README for the reasoning behind each decision.
 *
 * Environment variables (Vercel → Project Settings → Environment Variables):
 *   RESEND_API_KEY          required  Resend API key with sending access.
 *   TURNSTILE_SECRET_KEY    required  Secret for the Turnstile widget on /reviews.
 *   REVIEW_TO               optional  Inbox that receives reviews.
 *   REVIEW_FROM             optional  Sender. Must be on a domain verified in Resend.
 *   ALLOWED_ORIGINS         optional  Extra origins allowed to post (comma-separated).
 *   TURNSTILE_EXPECT_HOSTNAME optional  Overrides the hostname Turnstile tokens must carry.
 * Missing either required one fails closed with a 500 rather than sending unchecked mail.
 *
 * Three filters stand in front of the send, cheapest first: same-origin, honeypot, then
 * Turnstile, the only one that spends a network round trip. Lake & Pine also rate-limits
 * in code through a Cloudflare binding; Vercel has no equivalent binding, so that job
 * belongs to a Vercel Firewall rate-limit rule on /api/review instead (dashboard, no code).
 *
 * Photos: the page can attach up to three of the client's favourite shots. Vercel refuses
 * any request body over 4.5 MB before this code runs, so the page shrinks each photo in
 * the browser first. Juan already has the originals; the copy only has to show him which
 * shot they meant. The checks below repeat the page's limits, because the page is only a
 * suggestion to anything that posts here directly.
 */

import { renderEmail } from './_email.mjs';

const LIMITS = { name: 120, email: 200, review: 5000, location: 120, credit: 120 };

// Must match the <option> values on /reviews. Anything else is dropped rather than
// passed through, so the Service line in the email only ever reads one of these.
const SERVICES = new Set(['Wedding', 'Portraits', 'Real Estate', 'Branded Content']);

// Must match MAX_PHOTOS and MAX_PHOTO_BYTES in reviews/index.html. Three at this size is
// 3.9 MB, which leaves room under Vercel's 4.5 MB body limit for the text fields.
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 1_300_000;

// Identified by the file's first bytes, never by its name or declared type, which the
// sender controls. The page always sends JPEG; PNG and WebP are accepted so the rule here
// matches the one the page tells people.
const PHOTO_TYPES = [
  { ext: 'jpg', matches: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: 'png', matches: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { ext: 'webp', matches: b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' }
];

const DEFAULT_TO = 'jcruzz.media@gmail.com';
// Sent from Lake & Pine's domain because it is already verified in the shared Resend
// account. To send as jcruzzmedia.com instead, verify that domain in Resend and set
// REVIEW_FROM — no code change needed.
const DEFAULT_FROM = 'JCruzz Media Reviews <reviews@lakeandpinecollective.com>';

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Must match data-action on the widget in reviews/index.html. Pinned at verify time so
// a token minted by some other widget can't be spent here.
const TURNSTILE_ACTION = 'review';

// Cloudflare's documented dummy secrets, for local testing (see .env.example).
const TESTING_SECRETS = new Set([
  '1x0000000000000000000000000000000AA', // always passes
  '2x0000000000000000000000000000000AA', // always fails
  '3x0000000000000000000000000000000AA'  // always reports "token already spent"
]);

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    }
    try {
      return await handleReview(request);
    } catch (err) {
      console.error('Unexpected error handling a review', err);
      return json({ error: 'Could not send that right now.' }, 500);
    }
  }
};

async function handleReview(request) {
  const env = process.env;
  const url = new URL(request.url);

  // 1. Same origin. The page submits with fetch(), so a real browser always sends Origin
  // and it always names our own host. Forgeable by anything that isn't a browser, which
  // is the point: it costs nothing and drops drive-by scripted posts.
  const origin = request.headers.get('Origin');
  const originHost = origin && allowedOrigin(origin, request, url, env);
  if (!originHost) {
    return json({ error: 'Forbidden' }, 403);
  }

  let data;
  let files;
  try {
    ({ data, files } = await readSubmission(request));
  } catch (_) {
    return json({ error: 'Could not read that submission.' }, 400);
  }
  if (!data || typeof data !== 'object') {
    return json({ error: 'Could not read that submission.' }, 400);
  }

  // 2. Honeypot. Answer as though it worked — telling a bot it was caught only helps it.
  if (str(data.website)) {
    return json({ ok: true }, 200);
  }

  const name = str(data.name).slice(0, LIMITS.name);
  const email = str(data.email).slice(0, LIMITS.email);
  const review = str(data.review).slice(0, LIMITS.review);
  const rating = Number.parseInt(str(data.rating), 10);
  const service = SERVICES.has(str(data.service)) ? str(data.service) : '';
  const location = str(data.location).slice(0, LIMITS.location);
  const credit = str(data.credit).slice(0, LIMITS.credit);
  const consent = str(data.consent) === 'yes';

  // The rating is the only required field. Everything else is optional by design — a
  // bare five stars is still worth having, and asking for less gets more of them. The
  // email template carries the fallbacks for whatever didn't arrive.
  const invalid = [];
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) invalid.push('rating');
  // Not required, but if they typed one it should be usable — it becomes reply_to.
  if (email && !email.includes('@')) invalid.push('email');
  const photos = await readPhotos(files);
  if (!photos) invalid.push('photos');
  if (invalid.length) {
    return json({ error: `Missing or invalid: ${invalid.join(', ')}` }, 400);
  }

  // 3. Turnstile. Last, because it is the only check that costs a round trip — no point
  // spending one on a submission the free checks above already rejected.
  const verdict = await verifyTurnstile(request, env, originHost, str(data['cf-turnstile-response']));
  if (!verdict.ok) {
    return json({ error: verdict.error }, verdict.status);
  }

  const key = env.RESEND_API_KEY;
  if (!key) {
    console.error('RESEND_API_KEY is not set');
    return json({ error: 'Email is not configured.' }, 500);
  }

  // Resend takes text and html together; clients pick whichever they render.
  const mail = renderEmail({
    name, email, review, rating, service, location, credit, consent, photos: photos.length
  });

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      // Longer than the Turnstile call's: with photos this uploads up to ~5 MB of base64.
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        from: env.REVIEW_FROM || DEFAULT_FROM,
        to: [env.REVIEW_TO || DEFAULT_TO],
        // So hitting reply in the inbox goes to the client, not to the sender address.
        // Omitted entirely when no address was given — Resend rejects an empty reply_to,
        // which would turn "they skipped an optional field" into a failed submission.
        ...(email ? { reply_to: email } : {}),
        ...mail,
        // Named by position, not by whatever the upload called itself.
        ...(photos.length ? {
          attachments: photos.map((p, i) => ({
            filename: `photo-${i + 1}.${p.ext}`,
            content: Buffer.from(p.bytes).toString('base64')
          }))
        } : {})
      })
    });
  } catch (err) {
    console.error('Could not reach Resend', err);
    return json({ error: 'Could not send that right now.' }, 502);
  }

  if (!res.ok) {
    console.error('Resend rejected the send', res.status, await res.text());
    return json({ error: 'Could not send that right now.' }, 502);
  }

  return json({ ok: true }, 200);
}

/**
 * The page posts multipart form data, the only way to carry the photos without inflating
 * them by a third as base64. JSON is still read because that's what the page sent before
 * photos existed, so a copy someone loaded before a deploy still submits.
 * Text fields come back as `data`, uploads under "photos" as `files`.
 */
async function readSubmission(request) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('multipart/form-data')) {
    return { data: await request.json(), files: [] };
  }

  const form = await request.formData();
  const data = {};
  const files = [];
  for (const [key, value] of form) {
    if (key === 'photos') {
      files.push(value);
    } else if (typeof value === 'string' && !(key in data)) {
      data[key] = value;
    }
  }
  return { data, files };
}

/**
 * The uploads as [{ ext, bytes }], or null if any one breaks a rule. One bad photo fails
 * the whole submission rather than being dropped, so nobody is told it worked while part
 * of what they sent quietly went missing. The page enforces the same rules first, so a
 * real visitor only lands here if something has gone wrong.
 */
async function readPhotos(files) {
  if (files.length > MAX_PHOTOS) return null;

  const photos = [];
  for (const file of files) {
    if (typeof file === 'string' || file.size === 0 || file.size > MAX_PHOTO_BYTES) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = PHOTO_TYPES.find(t => t.matches(bytes));
    if (!type) return null;
    photos.push({ ext: type.ext, bytes });
  }
  return photos;
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * Returns the posting page's hostname when the post came from our own page, else null.
 *
 * Compared by host rather than by full origin: behind Vercel's proxy, request.url is not
 * guaranteed to carry the public https scheme, and a scheme mismatch would reject every
 * genuine submission. ALLOWED_ORIGINS is an override for a page served from a hostname
 * the function doesn't see itself as.
 */
function allowedOrigin(origin, request, url, env) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_) {
    return null;
  }

  const ownHosts = [url.host, request.headers.get('x-forwarded-host'), request.headers.get('host')]
    .filter(Boolean);
  if (ownHosts.includes(parsed.host)) return parsed.hostname;

  const extra = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  return extra.includes(origin) ? parsed.hostname : null;
}

async function verifyTurnstile(request, env, originHost, token) {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Fails closed, like a missing Resend key. Spam protection that switches itself off
    // when its config goes missing is the one failure mode worth refusing outright.
    console.error('TURNSTILE_SECRET_KEY is not set');
    return { ok: false, status: 500, error: 'Spam protection is not configured.' };
  }

  if (!token || token.length > 2048) {
    return { ok: false, status: 403, error: HUMAN_CHECK_FAILED };
  }

  let result;
  try {
    const res = await fetch(TURNSTILE_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ secret, response: token, remoteip: clientIp(request) })
    });
    if (!res.ok) throw new Error(`siteverify returned ${res.status}`);
    result = await res.json();
  } catch (err) {
    // Reaching Cloudflare failed, which is not the submitter's fault — 502, not 403,
    // so the page can tell them to try again rather than accusing them of being a bot.
    console.error('Turnstile verification could not complete', err);
    return { ok: false, status: 502, error: 'Could not check that right now. Please try again.' };
  }

  // Cloudflare's testing secrets answer with hostname "example.com" and no action field,
  // so pinning either would reject every local submission. Decided from the configured
  // secret rather than from the response, so what comes back over the network can't
  // influence it. Costs nothing in production: a testing secret there passes everything.
  const testing = TESTING_SECRETS.has(secret);
  if (testing) {
    console.warn('Turnstile is using a testing secret — action and hostname are not pinned');
  }

  const expectedHostname = env.TURNSTILE_EXPECT_HOSTNAME || originHost;
  const ok = result.success && (testing || (
    result.action === TURNSTILE_ACTION &&
    result.hostname === expectedHostname
  ));

  if (!ok) {
    // error-codes is logged because the likely configuration mistakes — a wrong secret,
    // or the dummy sitekey left in the page against a live secret — look exactly like a
    // genuine bot from the outside otherwise.
    console.error('Turnstile rejected a submission', JSON.stringify({
      success: result.success,
      action: result.action,
      hostname: result.hostname,
      expectedHostname,
      codes: result['error-codes']
    }));
    return { ok: false, status: 403, error: HUMAN_CHECK_FAILED };
  }

  return { ok: true };
}

const HUMAN_CHECK_FAILED =
  'We could not confirm that submission. Please reload the page and try once more.';

// Vercel overwrites x-forwarded-for with the real client address, so it can't be spoofed
// from outside; x-real-ip carries the same value on its own.
function clientIp(request) {
  return request.headers.get('x-real-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function json(payload, status, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}
