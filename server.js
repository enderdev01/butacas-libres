const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const providers = require('./providers');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Si el navegador cancela (cierra la pestaña, cambia de película), lo que aún
  // no salió de la cola se descarta en vez de gastarse contra el origen.
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const signal = ac.signal;

  const chain = () => providers.get(url.searchParams.get('chain') || 'cineplanet');

  try {
    if (url.pathname === '/api/chains') return json(res, 200, providers.catalog());
    if (url.pathname === '/api/health') return json(res, 200, await providers.health());

    if (url.pathname === '/api/movies') return json(res, 200, await chain().moviesList());
    if (url.pathname === '/api/cinemas') {
      const p = chain();
      return json(res, 200, p.getCinemas ? await p.getCinemas() : []);
    }

    if (url.pathname === '/api/availability') {
      const slug = url.searchParams.get('movie');
      if (!slug) return json(res, 400, { error: 'falta ?movie=<slug>' });
      const opts = { signal, withSeats: url.searchParams.get('seats') === 'all' };
      return json(res, 200, await chain().availability(slug, url.searchParams.get('date') || undefined, opts));
    }

    if (url.pathname === '/api/seats') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      if (!ids.length) return json(res, 400, { error: 'falta ?ids=<cinemaId-sessionId>,…' });
      return json(res, 200, { seats: await chain().seatsFew(ids, { signal }), updatedAt: new Date().toISOString() });
    }

    if (url.pathname === '/api/seatplan' || url.pathname === '/api/tickets') {
      const p = chain();
      const quiere = url.pathname === '/api/seatplan' ? 'seatplan' : 'tickets';
      if (!p.capabilities[quiere]) return json(res, 501, { error: `${p.name} no expone ${quiere}` });
      const id = url.searchParams.get('session') || '';
      const [cinemaId, sessionId] = id.includes('-') ? id.split('-') : [url.searchParams.get('cinema'), id];
      if (!cinemaId || !sessionId) return json(res, 400, { error: 'falta ?session=<cinemaId>-<sessionId>' });
      return json(res, 200, await p[quiere](cinemaId, sessionId, { signal }));
    }

    if (url.pathname === '/api/stats') {
      return json(res, 200, Object.fromEntries(providers.list.map((p) => [p.id, p.stats()])));
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    if (err.aborted || ac.signal.aborted) return res.destroy(); // el cliente ya no está
    if (err.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    if (err.blocked) {
      res.setHeader('Retry-After', String(err.retryAfter));
      return json(res, 503, { error: err.message, blocked: true, retryAfter: err.retryAfter });
    }
    console.error(err);
    json(res, err.status ?? 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
