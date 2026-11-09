/**
 * Review notification email — shared by api/review.mjs and scripts/preview-email.mjs.
 *
 * The leading underscore matters: Vercel turns every file in /api into its own endpoint
 * except ones starting with "_", so this stays a plain module the function imports.
 *
 * Lives in its own module so the preview renders the exact template that gets sent;
 * a preview that can drift from the real thing is worse than no preview.
 *
 * Written for Juan, not for whoever maintains the site: it reports a review in readable
 * form and stops there.
 *
 * A review carrying a link is flagged rather than blocked. Link spam is the one shape
 * that reliably isn't a real client review, but dropping a genuine review costs more
 * than an odd email, so the judgement stays with a human.
 *
 * Email is not the web. Three constraints shape everything below:
 *   1. Web fonts do not load. Gmail strips the <link>, Outlook ignores it, so Playfair
 *      falls back to Georgia and Jost to the system sans.
 *   2. Styles are inline. Several clients drop <style> blocks entirely.
 *   3. Layout is tables. Desktop Outlook renders with Word's engine, which has no
 *      meaningful flexbox or grid support.
 */

const C = {
  page: '#EFEFEF',
  paper: '#FFFFFF',
  quiet: '#F7F7F7',
  ink: '#141414',
  mid: '#4A4A4A',
  soft: '#6B6B6B',
  emptyStar: '#C4C4C4',
  rule: 'rgba(0,0,0,0.10)',
  onInk: '#A8A8A8',
  flag: '#8C3B2E',
  flagBg: '#F6E4DF'
};

const ANON = 'Anonymous';
const NO_REVIEW = 'Rating only — they left stars but no written review.';

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export function renderEmail(f) {
  // The rating is the only field the form requires, so everything here has to read
  // sensibly when it's the only thing that arrived.
  const display = f.credit || f.name || ANON;
  // Same shape as the testimonial cards on the homepage: "Wedding · Lake Tahoe".
  const detail = [f.service, f.location].filter(Boolean).join(' · ');
  const suspect = hasLink(f.review);
  const ctx = { display, detail, suspect };

  return {
    subject: `${suspect ? '[possible spam] ' : ''}New review — ${f.name || ANON} (${f.rating}/5)`,
    text: text(f, ctx),
    html: html(f, ctx)
  };
}

/**
 * Genuine reviews essentially never carry a URL; SEO spam essentially always does.
 * Scans the review body only — the submitter's email address is a different field and
 * would match every time.
 */
export function hasLink(review) {
  const v = String(review || '');
  return /https?:\/\//i.test(v) ||
    /\bwww\./i.test(v) ||
    /\[url[=\]]/i.test(v) ||
    /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|info|biz|xyz|top|shop|site|online|ru|cn|io)\b/i.test(v);
}

/* ---------------------------------------------------------------- plain text */
/* Kept alongside the HTML, not replaced by it: Resend sends both and the client picks. */
function text(f, { display, detail, suspect }) {
  const stars = '★'.repeat(f.rating) + '☆'.repeat(5 - f.rating);
  return [
    ...(suspect ? ['!! This review contains a link, which real ones rarely do. Read it before publishing.', ''] : []),
    `${stars}  (${f.rating}/5)`,
    '',
    f.review || NO_REVIEW,
    '',
    '—'.repeat(48),
    `From:     ${fromLine(f) || '(not given)'}`,
    `Credit:   ${display}`,
    `Service:  ${detail || '(not given)'}`,
    `Publish:  ${f.consent ? 'YES — they ticked the consent box' : 'NO — do not put this on the site'}`,
    '—'.repeat(48)
  ].join('\n');
}

/* ---------------------------------------------------------------------- html */
function html(f, { display, detail, suspect }) {
  const stars =
    `<span style="color:${C.ink};">${'★'.repeat(f.rating)}</span>` +
    `<span style="color:${C.emptyStar};">${'☆'.repeat(5 - f.rating)}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(`New review — ${f.name || ANON}`)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:28px 12px;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;table-layout:fixed;background:${C.paper};border:1px solid ${C.rule};">

    <tr><td style="background:${C.ink};padding:26px 32px;">
      <div style="font-family:${SANS};font-size:10px;letter-spacing:0.32em;text-transform:uppercase;color:${C.onInk};">New Review</div>
      <div style="font-family:${SANS};font-size:15px;font-weight:300;letter-spacing:0.35em;color:#FFFFFF;padding-top:8px;">JCRUZZ MEDIA</div>
    </td></tr>

    ${suspect ? `<tr><td style="background:${C.flagBg};padding:13px 32px;border-bottom:1px solid ${C.rule};">
      <div style="font-family:${SANS};font-size:12px;line-height:1.5;color:${C.flag};">
        <strong>Contains a link.</strong> Real reviews rarely do &mdash; worth reading before this goes on the site.
      </div>
    </td></tr>` : ''}

    <tr><td style="background:${C.quiet};padding:30px 32px;border-bottom:1px solid ${C.rule};">
      <div style="font-size:20px;line-height:1;letter-spacing:3px;">${stars}</div>
      <div style="font-family:${SERIF};font-size:18px;line-height:1.6;color:${C.ink};padding-top:18px;${f.review ? '' : 'opacity:0.55;'}">
        ${f.review ? `&ldquo;${escapeHtml(f.review)}&rdquo;` : escapeHtml(NO_REVIEW)}
      </div>
    </td></tr>

    <tr><td style="padding:26px 32px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${row('From', escapeHtml(fromLine(f)) || notGiven())}
        ${row('Credit', escapeHtml(display))}
        ${row('Service', escapeHtml(detail) || notGiven())}
        ${row('Publish', consentBadge(f.consent), true)}
      </table>
    </td></tr>

    <tr><td style="background:${C.quiet};padding:16px 32px;border-top:1px solid ${C.rule};">
      <div style="font-family:${SANS};font-size:11px;line-height:1.5;color:${C.soft};">
        Sent by the review form at jcruzzmedia.com/reviews${f.email ? ` · reply to reach ${escapeHtml(f.name || 'them')}` : ' · no email given, so there is nobody to reply to'}
      </div>
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>`;
}

/** "Name <email>", or whichever half turned up, or "" if neither did. */
function fromLine(f) {
  const name = String(f.name || '').trim();
  const email = String(f.email || '').trim();
  if (name && email) return `${name} <${email}>`;
  return name || email;
}

function notGiven() {
  return '<span style="opacity:0.5;">not given</span>';
}

function row(label, value, last) {
  return `<tr>
    <td style="font-family:${SANS};font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${C.soft};padding:9px 14px 9px 0;white-space:nowrap;vertical-align:top;border-bottom:${last ? 'none' : `1px solid ${C.rule}`};">${label}</td>
    <td style="font-family:${SANS};font-size:14px;color:${C.ink};padding:9px 0;vertical-align:top;border-bottom:${last ? 'none' : `1px solid ${C.rule}`};">${value}</td>
  </tr>`;
}

function consentBadge(consent) {
  return consent
    ? `<span style="display:inline-block;background:${C.ink};color:#FFFFFF;font-family:${SANS};font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;padding:5px 11px;">Yes &mdash; OK to publish</span>`
    : `<span style="display:inline-block;border:1px solid ${C.rule};color:${C.soft};font-family:${SANS};font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;padding:5px 11px;">No &mdash; do not publish</span>`;
}

/* --------------------------------------------------------------------- utils */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
