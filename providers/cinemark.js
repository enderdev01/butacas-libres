// Cinemark Perú. Su BFF es mucho más directo que el de Cineplanet: un GET de
// showtimes por cine ya devuelve la ocupación de cada función, sin pedir butaca
// por butaca. Una película entera son ~15 peticiones (una por sede).
//
// Único requisito: la cabecera `country`. Sin ella responde 500 con
// "Country undefined not implemented".

const { createClient, memo } = require('../lib/net');

const BASE = 'https://bff.cinemark-peru.com/api';
const SITE = 'https://www.cinemark-peru.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const client = createClient({
  chain: 'Cinemark',
  base: BASE,
  rps: Number(process.env.CINEMARK_RPS) || 5,
  concurrency: Number(process.env.CINEMARK_CONCURRENCY) || 5,
  headers: () => ({
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'es-PE,es;q=0.9',
    Referer: `${SITE}/`,
    Origin: SITE,
    country: 'PE',
  }),
  isBlocked: (res, body) => res.status === 403 && /blocked|Service unavailable|Access Denied/i.test(body),
});

const CATALOG_TTL = 10 * 60 * 1000;
const SHOWTIME_TTL = Number(process.env.SEAT_TTL_MS) || 45 * 1000;

const getMovies = memo(CATALOG_TTL, async () => (await client.get('/cinema/movies')).data ?? []);
const getTheaters = memo(CATALOG_TTL, async () =>
  (await client.get('/cinema/theaters?limit=9007199254740991')).data ?? []
);

// showtimes por cine, cacheado aparte: es el dato que cambia.
const showCache = new Map(); // `${corporateId}-${theaterId}` -> { at, rows }
const showInflight = new Map();

function getShowtimes(corporateId, theaterId, opts = {}) {
  const key = `${corporateId}-${theaterId}`;
  const hit = showCache.get(key);
  if (hit && Date.now() - hit.at < SHOWTIME_TTL) return Promise.resolve(hit.rows);
  const running = showInflight.get(key);
  if (running) return running;

  const p = client
    .get(`/cinema/showtimes?movieCorporateId=${corporateId}&theater=${theaterId}&_t=${Date.now()}`, opts)
    .then((res) => {
      const rows = res.data ?? [];
      showCache.set(key, { at: Date.now(), rows });
      return rows;
    })
    .finally(() => showInflight.delete(key));

  showInflight.set(key, p);
  return p;
}

const dayOf = (iso) => String(iso).slice(0, 10);

/** Fecha local de Lima (el BFF entrega los horarios en UTC). */
const limaDay = (iso) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

const limaHour = (iso) => new Date(iso).toISOString();

async function moviesList() {
  const movies = await getMovies();
  return movies
    .filter((m) => m.status !== 'COMING_SOON')
    .map((m) => ({
      id: m.corporateId,
      slug: m.slug,
      title: m.title,
      poster: m.posterUrl,
      dates: [], // Cinemark no publica las fechas sin consultar showtimes
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

/**
 * Todas las funciones de una película con su ocupación. Consulta los ~15 cines
 * en paralelo (la cola los espacia) y cada respuesta ya trae los asientos.
 */
async function availability(slug, date, { signal } = {}) {
  const [movies, theaters] = await Promise.all([getMovies(), getTheaters()]);
  const movie = movies.find((m) => m.slug === slug || m.corporateId === slug);
  if (!movie) throw Object.assign(new Error(`Película no encontrada: ${slug}`), { status: 404 });

  const byId = new Map(theaters.map((t) => [String(t.id), t]));
  const lotes = await Promise.all(
    theaters.map((t) =>
      getShowtimes(movie.corporateId, t.id, { signal, priority: 1 }).catch((err) => {
        if (err.blocked || err.aborted) throw err;
        return [];
      })
    )
  );

  const all = lotes.flat().map((s) => {
    const cine = byId.get(String(s.theaterId));
    const free = s.occupation?.availableSeats ?? null;
    const total = s.occupation?.capacity ?? null;
    return {
      id: `${s.theaterId}-${s.sessionId}`,
      cinemaId: String(s.theaterId),
      cinemaName: cine?.name ?? `Cine ${s.theaterId}`,
      city: cine?.city ?? '',
      address: cine?.address ?? '',
      showtime: s.sessionDateTime,
      day: s.sessionDisplayDate || limaDay(s.sessionDateTime),
      screen: s.theaterRoom ? `SALA ${s.theaterRoom}` : '',
      formats: (s.formats ?? []).map((f) => f.shortName || f.name),
      languages: [s.language?.name].filter(Boolean),
      free,
      total,
      taken: free != null && total != null ? Math.max(total - free, 0) : null,
    };
  });

  const allDates = [...new Set(all.map((s) => s.day))].sort();
  const target = date || allDates[0];
  const rows = all.filter((s) => s.day === target);
  rows.sort(
    (a, b) =>
      a.cinemaName.localeCompare(b.cinemaName, 'es') ||
      String(a.showtime).localeCompare(String(b.showtime))
  );

  const counted = rows.filter((r) => r.total > 0);
  return {
    chain: 'cinemark',
    movie: { id: movie.corporateId, slug: movie.slug, title: movie.title, poster: movie.posterUrl },
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

/** Refresca la ocupación de una sede concreta. */
async function seatsFew(ids, { signal } = {}) {
  const out = {};
  const porCine = new Map();
  for (const id of ids) {
    const [theaterId] = id.split('-');
    if (!porCine.has(theaterId)) porCine.set(theaterId, []);
    porCine.get(theaterId).push(id);
  }
  // Basta un showtimes por cine para refrescar todas sus funciones.
  const movies = await getMovies();
  await Promise.all(
    [...porCine.keys()].map(async (theaterId) => {
      for (const m of movies) {
        const key = `${m.corporateId}-${theaterId}`;
        if (!showCache.has(key)) continue;
        showCache.delete(key);
        const rows = await getShowtimes(m.corporateId, theaterId, { signal, priority: 1 });
        for (const s of rows) {
          const id = `${s.theaterId}-${s.sessionId}`;
          if (!ids.includes(id)) continue;
          const free = s.occupation?.availableSeats ?? null;
          const total = s.occupation?.capacity ?? null;
          out[id] = { free, total, taken: free != null && total != null ? Math.max(total - free, 0) : null };
        }
      }
    })
  );
  return out;
}

/** Comprueba que el origen responde, sin traerse medio catálogo. */
async function health() {
  await client.get('/cinema/theaters?limit=1', { priority: 0 });
  return true;
}

module.exports = {
  id: 'cinemark',
  name: 'Cinemark',
  site: SITE,
  color: '#e11d2a',
  // Su API ya devuelve la ocupación junto a la parrilla: no hay carga diferida.
  capabilities: { lazySeats: false, seatplan: false, tickets: false },
  // Una película entera son ~15 peticiones baratas, pero tampoco hace falta más.
  refreshWait: Number(process.env.CINEMARK_REFRESH_WAIT) || 60,
  moviesList,
  availability,
  seatsFew,
  health,
  stats: client.stats,
  isBlockedNow: client.isBlockedNow,
};
