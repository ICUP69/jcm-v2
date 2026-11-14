/**
 * Render the review notification email to local files so it can be eyeballed without
 * sending anything.
 *
 *   node scripts/preview-email.mjs           # writes to ./.email-preview/
 *   node scripts/preview-email.mjs --open    # …and opens the index (macOS)
 *
 * Imports the same renderEmail() the function uses, so what you see is what goes out.
 * Output is gitignored.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';

import { renderEmail } from '../api/_email.mjs';

const CASES = {
  'five-star-wedding': {
    name: 'Catherine Reyes',
    email: 'catherine@example.com',
    review: 'Juan was incredible from start to finish. He made everyone comfortable, caught moments we didn’t even know happened, and the highlight film had our whole family in tears.',
    rating: 5,
    service: 'Wedding',
    location: 'Lake Tahoe',
    credit: 'Catherine R.',
    consent: true
  },
  // Every optional field empty, plus characters that must be escaped rather than
  // rendered as markup inside the quote, and the no-consent badge.
  'three-star-no-consent': {
    name: 'Sam & Jo',
    email: 'sam@example.com',
    review: 'Good <em>but</em> the turnaround & communication were slow. Photos themselves were lovely though.',
    rating: 3,
    service: '',
    location: '',
    credit: '',
    consent: false
  },
  // The floor: the rating is the only required field, so every fallback shows at once.
  'rating-only': {
    name: '',
    email: '',
    review: '',
    rating: 4,
    service: '',
    location: '',
    credit: '',
    consent: false
  },
  // Flagged, not blocked: sent like any other review, but with the banner.
  'link-spam': {
    name: 'Premier SEO Services',
    email: 'contact@example.net',
    review: 'Great photographer! Visit https://cheap-backlinks.top or www.rank-faster.xyz for the best rates on SEO.',
    rating: 5,
    service: '',
    location: '',
    credit: '',
    consent: true
  },
  'real-estate': {
    name: 'Jordan Whitfield-Alvarez',
    email: 'jordan@example.com',
    review: 'We listed on a Thursday and had three offers by Sunday. The twilight exteriors and the walkthrough video made the place look exactly as good as it feels in person, which is rarer than it should be. Booking him for every listing from here on.',
    rating: 5,
    service: 'Real Estate',
    location: 'Reno',
    credit: 'Jordan W.',
    consent: true
  }
};

const dir = new URL('../.email-preview/', import.meta.url);
await mkdir(dir, { recursive: true });

const index = [];
for (const [slug, fields] of Object.entries(CASES)) {
  const { subject, html, text } = renderEmail(fields);
  await writeFile(new URL(`./${slug}.html`, dir), html);
  await writeFile(new URL(`./${slug}.txt`, dir), `Subject: ${subject}\n\n${text}\n`);
  index.push({ slug, subject });
  console.log(`${slug.padEnd(24)} ${subject}`);
}

const list = index
  .map(i => `<li><a href="${i.slug}.html">${i.slug}</a> &mdash; <code>${i.subject.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code> &nbsp;<a href="${i.slug}.txt">text</a></li>`)
  .join('\n');
await writeFile(new URL('./index.html', dir), `<!DOCTYPE html>
<meta charset="utf-8"><title>Email preview</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px}
code{background:#eee;padding:2px 5px}li{margin:10px 0}</style>
<h1>Review email preview</h1>
<p>Rendered by <code>scripts/preview-email.mjs</code> from the same template the function sends.</p>
<ul>\n${list}\n</ul>`);

console.log(`\nWrote ${index.length} previews to .email-preview/`);

if (process.argv.includes('--open')) {
  execFile('open', [new URL('./index.html', dir).pathname]);
}
