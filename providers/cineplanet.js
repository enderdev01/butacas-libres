// Cineplanet Perú.
//
// Dos particularidades frente a Cinemark:
//  1. Exige la cookie `channel-token`, que solo se emite tras pedir
//     /bootstrap-data con un Referer del propio sitio.
//  2. La ocupación no viene en la parrilla: hay una petición por función
//     (`sessionavailable`). Por eso el cliente la pide por sede, no de golpe.

const { randomUUID } = require('node:crypto');
const { createClient, memo } = require('../lib/net');

const SITE = 'https://www.cineplanet.com.pe';
const BASE = `${SITE}/api/v1-web`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// --- sesión ------------------------------------------------------------

let cookie = null;
let cookieAt = 0;
let cookieGen = 0;  // sube en cada renovación; descarta 403 de tokens ya reemplazados
let warming = null; // single-flight: una sola renovación aunque fallen N peticiones
const COOKIE_TTL = 20 * 60 * 1000;

function headers() {
  const h = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'es-PE,es;q=0.9',
    Referer: `${SITE}/peliculas`,
    Origin: SITE,
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

function collectCookies(res) {
  const set = res.headers.getSetCookie?.() ?? [];
  if (!set.length) return;
  const jar = new Map(
    (cookie ? cookie.split('; ') : []).map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i), c.slice(i + 1)];
    })
  );
  for (const line of set) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
  cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

const looksBlocked = (res, body) =>
  res.status === 403 && /request is blocked|Service unavailable/i.test(body ?? '');

/**
 * Consigue una cookie válida. Concurrente-seguro: si ya hay una renovación en
 * curso, todas las llamadas esperan a esa misma en vez de lanzar N warmups.
 */
function warmup({ force = false, gen } = {}) {
  if (gen != null && cookieGen > gen) return Promise.resolve(cookieGen); // otro ya renovó
  if (!force && cookie && Date.now() - cookieAt < COOKIE_TTL) return Promise.resolve(cookieGen);
  if (warming) return warming;

  warming = (async () => {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        cookie = null;
        const home = await fetch(`${SITE}/peliculas`, { headers: headers() });
        collectCookies(home);
        const html = await home.text();
        if (looksBlocked(home, html)) throw client.markBlocked();
        const boot = await fetch(`${BASE}/bootstrap-data`, { headers: headers() });
        collectCookies(boot);
        const body = await boot.text();
        if (looksBlocked(boot, body)) throw client.markBlocked();
        if (!cookie) throw new Error('el origen no emitió cookies');
        cookieAt = Date.now();
        return ++cookieGen;
      } catch (err) {
        if (err.blocked) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 400 * 2 ** i));
      }
    }
    cookie = null;
    cookieAt = 0;
    throw new Error(`no se pudo renovar la sesión: ${lastErr?.message ?? lastErr}`);
  })().finally(() => {
    warming = null;
  });

  return warming;
}

const client = createClient({
  chain: 'Cineplanet',
  base: BASE,
  headers,
  isBlocked: looksBlocked,
  renew: warmup,
  rps: Number(process.env.CINEPLANET_RPS) || Number(process.env.RPS) || 6,
  concurrency: Number(process.env.CINEPLANET_CONCURRENCY) || Number(process.env.CONCURRENCY) || 6,
});

const api = (path, opts) => client.get(`/${path}`, opts);

// --- catálogo ----------------------------------------------------------

const CATALOG_TTL = 10 * 60 * 1000;

const getMovies = memo(CATALOG_TTL, async () => (await api('cache/moviescache')).movies ?? []);
const getCinemas = memo(CATALOG_TTL, async () => (await api('cache/cinemascache')).cinemas ?? []);
const getSessionIndex = memo(CATALOG_TTL, async () => {
  const d = await api('cache/sessioncache');
  return new Map((d.sessions ?? []).map((s) => [s.id, s]));
});

// --- ocupación ---------------------------------------------------------

const seatCache = new Map();
const seatInflight = new Map();
const SEAT_TTL = Number(process.env.SEAT_TTL_MS) || 45 * 1000;

function seatsFor(id, opts = {}) {
  const hit = seatCache.get(id);
  if (hit && Date.now() - hit.at < SEAT_TTL) return Promise.resolve(hit.data);

  const running = seatInflight.get(id); // dos vistas, una sola petición
  if (running) return running;

  const [cinemaId, sessionId] = id.split('-');
  const p = api(`sessionavailable/cinema/${cinemaId}/session/${sessionId}`, opts)
    .then((raw) => {
      const total = raw.seatsTotal ?? 0;
      const free = raw['available-seats'] ?? 0;
      const data = { free, total, taken: Math.max(total - free, 0) };
      seatCache.set(id, { at: Date.now(), data });
      return data;
    })
    .catch((err) => {
      if (err.aborted || err.blocked) throw err; // no se cachea lo que ni se intentó
      const data = { free: null, total: null, taken: null, error: String(err.message || err) };
      seatCache.set(id, { at: Date.now(), data });
      return data;
    })
    .finally(() => seatInflight.delete(id));

  seatInflight.set(id, p);
  return p;
}

async function seatsFew(ids, { signal, priority = 1 } = {}) {
  const list = [...new Set(ids)].slice(0, 80);
  const data = await Promise.all(list.map((id) => seatsFor(id, { signal, priority })));
  return Object.fromEntries(list.map((id, i) => [id, data[i]]));
}

const dayOf = (iso) => String(iso).slice(0, 10);

async function moviesList() {
  const movies = await getMovies();
  return movies
    .filter((m) => !m.isComingSoon && (m.cinemas?.length ?? 0) > 0)
    .map((m) => ({
      id: m.id,
      slug: m.movieDetailsUrl,
      title: m.title,
      poster: m.posterUrl,
      dates: [
        ...new Set((m.cinemas ?? []).flatMap((c) => (c.dates ?? []).map((d) => dayOf(d.date)))),
      ].sort(),
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

/**
 * Parrilla de una película. Por defecto NO consulta asientos: son ~925
 * peticiones y es justo lo que dispara el bloqueo. El cliente los pide por sede.
 */
async function availability(slug, date, { withSeats = false } = {}) {
  const [movies, cinemas, sessions] = await Promise.all([
    getMovies(),
    getCinemas(),
    getSessionIndex(),
  ]);

  const movie = movies.find((m) => m.movieDetailsUrl === slug || m.id === slug);
  if (!movie) throw Object.assign(new Error(`Película no encontrada: ${slug}`), { status: 404 });

  const allDates = [
    ...new Set((movie.cinemas ?? []).flatMap((c) => (c.dates ?? []).map((d) => dayOf(d.date)))),
  ].sort();
  const target = date || allDates[0];
  const cinemaById = new Map(cinemas.map((c) => [c.ID, c]));

  const rows = [];
  for (const mc of movie.cinemas ?? []) {
    for (const d of mc.dates ?? []) {
      if (dayOf(d.date) !== target) continue;
      for (const sid of d.sessions ?? []) {
        const meta = sessions.get(sid);
        const cine = cinemaById.get(mc.cinemaId);
        rows.push({
          id: sid,
          cinemaId: mc.cinemaId,
          cinemaName: cine?.name ?? mc.cinemaId,
          city: cine?.city ?? '',
          address: cine?.address ?? '',
          showtime: meta?.showtime ?? null,
          day: target,
          screen: meta?.screenName ?? '',
          formats: meta?.formats ?? (d.formats ? d.formats.split(',') : []),
          languages: meta?.languages ?? [],
        });
      }
    }
  }

  if (withSeats) {
    // Prioridad baja: una barrida completa no debe adelantar a lo que el
    // usuario mira ahora mismo.
    const seats = await Promise.all(rows.map((r) => seatsFor(r.id, { priority: 9 })));
    rows.forEach((r, i) => Object.assign(r, seats[i]));
  } else {
    for (const r of rows) {
      const hit = seatCache.get(r.id);
      if (hit && Date.now() - hit.at < SEAT_TTL) Object.assign(r, hit.data);
      else Object.assign(r, { free: null, total: null, taken: null });
    }
  }

  rows.sort(
    (a, b) =>
      a.cinemaName.localeCompare(b.cinemaName, 'es') ||
      String(a.showtime).localeCompare(String(b.showtime))
  );

  const counted = rows.filter((r) => r.total > 0);
  return {
    chain: 'cineplanet',
    movie: { id: movie.id, slug: movie.movieDetailsUrl, title: movie.title, poster: movie.posterUrl },
    date: target,
    dates: allDates,
    updatedAt: new Date().toISOString(),
    totals: {
      sessions: rows.length,
      seats: counted.reduce((a, r) => a + r.total, 0),
      free: counted.reduce((a, r) => a + r.free, 0),
    },
    sessions: rows,
  };
}

// --- plano de butacas y precios ---------------------------------------

// 0 libre · 1 ocupada · 3 libre (silla de ruedas) · 5 hueco no vendible.
// Verificado: 0+3 = available-seats y 0+1+3 = seatsTotal.
const SEAT_STATUS = { 0: 'free', 1: 'taken', 3: 'wheelchair', 5: 'blocked' };

// Abrir y cerrar el mismo modal no debe repetir la petición.
const detailCache = new Map(); // clave -> { at, data }
const detailInflight = new Map();
const DETAIL_TTL = Number(process.env.DETAIL_TTL_MS) || 30 * 1000;

function cached(key, fn) {
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return Promise.resolve(hit.data);

  const running = detailInflight.get(key); // dos modales a la vez, una sola petición
  if (running) return running;

  const p = fn()
    .then((data) => {
      detailCache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => detailInflight.delete(key));

  detailInflight.set(key, p);
  return p;
}

const seatplan = (cinemaId, sessionId, opts) =>
  cached(`plan:${cinemaId}-${sessionId}`, () => seatplanNow(cinemaId, sessionId, opts));

const tickets = (cinemaId, sessionId, opts) =>
  cached(`tk:${cinemaId}-${sessionId}`, () => ticketsNow(cinemaId, sessionId, opts));

async function seatplanNow(cinemaId, sessionId, { signal } = {}) {
  const raw = await api(`seatplan/cinema/${cinemaId}/session/${sessionId}`, { signal, priority: 0 });
  const layout = raw.SeatLayoutData;
  if (!layout) throw Object.assign(new Error('Sin plano para esa función'), { status: 404 });

  const rows = [];
  let free = 0, taken = 0, sellable = 0;

  for (const area of layout.Areas ?? []) {
    for (const r of area.Rows ?? []) {
      const seats = (r.Seats ?? [])
        .map((s) => {
          const status = SEAT_STATUS[s.Status] ?? 'blocked';
          if (status !== 'blocked') {
            sellable++;
            if (status === 'taken') taken++;
            else free++;
          }
          return { id: s.Id, col: s.Position?.ColumnIndex ?? 0, status };
        })
        .sort((a, b) => a.col - b.col);
      if (!seats.length) continue;
      rows.push({ name: r.PhysicalName ?? '', index: r.Seats?.[0]?.Position?.RowIndex ?? rows.length, seats });
    }
  }

  // La API entrega las filas de atrás hacia adelante; se invierten para dibujar
  // la pantalla arriba, como en la web.
  rows.sort((a, b) => b.index - a.index);
  const columns = Math.max(0, ...rows.flatMap((r) => r.seats.map((s) => s.col))) + 1;

  return { cinemaId, sessionId, columns, rows, stats: { free, taken, total: sellable }, updatedAt: new Date().toISOString() };
}

/** Tipos de entrada y precios. El usersessionid no necesita ser real. */
async function ticketsNow(cinemaId, sessionId, { signal } = {}) {
  const usid = randomUUID().replace(/-/g, '');
  const raw = await api(
    `gettickets/cinema/${cinemaId}/session/${sessionId}/usersessionid/${usid}`,
    { signal, priority: 0 }
  );
  const list = (raw.Tickets ?? [])
    .map((t) => ({
      code: t.TicketTypeCode,
      name: t.Description,
      price: (t.PriceInCents ?? 0) / 100,
      fee: (t.TotalTicketFeeAmountInCents ?? 0) / 100,
      surcharge: (t.SurchargeAmount ?? 0) / 100,
      membersOnly: !!t.availableForLoyaltyMembersOnly,
    }))
    .filter((t) => t.price > 0)
    .sort((a, b) => b.price - a.price);
  return { cinemaId, sessionId, currency: 'PEN', tickets: list };
}

/** Comprueba que el origen responde, con la petición más barata que hay. */
async function health() {
  await api('cache/cinemascache', { priority: 0 });
  return true;
}

module.exports = {
  id: 'cineplanet',
  name: 'Cineplanet',
  site: SITE,
  color: '#0a2a6b',
  // Necesita pedir la ocupación función por función, de ahí la carga por sede.
  capabilities: { lazySeats: true, seatplan: true, tickets: true },
  // La cadena más cara y la única que ya nos bloqueó: refrescar una sede abierta
  // son ~20 peticiones. Dos minutos entre actualizaciones manuales.
  refreshWait: Number(process.env.CINEPLANET_REFRESH_WAIT) || 120,
  moviesList,
  availability,
  seatsFew,
  seatplan,
  tickets,
  getCinemas,
  health,
  stats: client.stats,
  isBlockedNow: client.isBlockedNow,
};
