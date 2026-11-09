/**
 * Local preview of the site with the review endpoint working — no Vercel CLI or login.
 *
 *   cp .env.example .env.local      # once, then fill it in
 *   node --env-file-if-exists=.env.local scripts/dev.mjs
 *   open http://localhost:3000/reviews
 *
 * Serves the repo's static files the way Vercel does and hands /api/review to the real
 * function in api/review.mjs, so a submission here runs exactly the code that deploys.
 * Only that one route is wired up; it is a test harness, not a Vercel emulator.
 *
 * Kept out of the deployment by .vercelignore.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import review from '../api/review.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/review') return await runFunction(req, res, url);
    return await serveStatic(res, url);
  } catch (err) {
    console.error(err);
    res.writeHead(500).end('Internal error');
  }
});

async function runFunction(req, res, url) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  // Vercel supplies the client address in x-real-ip; mimic it so the function's
  // Turnstile call carries one locally too.
  headers.set('x-real-ip', req.socket.remoteAddress || '');

  const response = await review.fetch(new Request(url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
  }));

  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  console.log(`${req.method} ${url.pathname} → ${response.status}`);
}

async function serveStatic(res, url) {
  // Resolve inside ROOT only, and never hand out the function source or local tooling.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || rel.split(sep)[0] === 'api' || rel.startsWith('.')) {
    return res.writeHead(404).end('Not found');
  }

  let info = await stat(file).catch(() => null);
  if (info && info.isDirectory()) {
    file = join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info || !info.isFile()) return res.writeHead(404).end('Not found');

  res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
  res.end(await readFile(file));
}

server.listen(PORT, () => {
  const missing = ['RESEND_API_KEY', 'TURNSTILE_SECRET_KEY'].filter(k => !process.env[k]);
  console.log(`Serving on http://localhost:${PORT}  (form: http://localhost:${PORT}/reviews)`);
  if (missing.length) {
    console.warn(`Not set: ${missing.join(', ')} — submissions will fail closed. See .env.example.`);
  }
  if (!process.env.REVIEW_TO) {
    console.warn('REVIEW_TO is not set, so test reviews will go to jcruzz.media@gmail.com.');
  }
});
