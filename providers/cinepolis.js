// Cinépolis Perú — solo horarios.
//
// Su cartelera pública (Cartelera.aspx/GetNowPlayingByCity) da cines, días,
// películas y funciones, pero NO la ocupación. Los asientos viven en
// sls-api-compra.cinepolis.com/api/seats, que está detrás de Cloudflare y exige
// un token de reCAPTCHA Enterprise por petición. Son medidas anti-bot
// deliberadas y no se intentan sortear: esta cadena se expone sin ocupación.

const { createClient, memo } = require('../lib/net');

const SITE = 'https://cinepolis.com.pe';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const client = createClient({
  chain: 'Cinépolis',
  base: SITE,
  rps: Number(process.env.CINEPOLIS_RPS) || 3,
  concurrency: Number(process.env.CINEPOLIS_CONCURRENCY) || 3,
  headers: () => ({
    'User-Agent': UA,
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'es-PE,es;q=0.9',
    'Content-Type': 'application/json; charset=utf-8',
    Referer: `${SITE}/cartelera.aspx`,
    Origin: SITE,
  }),
  isBlocked: (res, body) =>
    res.status === 403 && /Cloudflare|Attention Required|Access denied/i.test(body ?? ''),
});

// El endpoint de cartelera es un ScriptService de ASP.NET: POST con JSON.
async function post(path, body, opts = {}) {
  const res = await fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: client.headers(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  const j = await res.json();
  return typeof j.d === 'string' ? JSON.parse(j.d) : j.d;
}

const CATALOG_TTL = 10 * 60 * 1000;

/** `/Date(1785343500000)/` -> ISO */
const msDate = (s) => {
  const m = String(s ?? '').match(/\d+/);
  return m ? new Date(Number(m[0])).toISOString() : null;
};
const limaDay = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) : null;

const getCities = memo(CATALOG_TTL, async () => {
  const data = await client.get('/manejadores/CiudadesComplejos.ashx?EsVIP=false', { priority: 1 });
  return (data ?? []).map((c) => ({ key: c.Clave, name: c.Nombre }));
});

/** Cartelera completa de una ciudad, cacheada aparte (una por ciudad). */
const cityCache = new Map();
const cityInflight = new Map();

function getCity(key, opts = {}) {
  const hit = cityCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL) return Promise.resolve(hit.data);
  const running = cityInflight.get(key);
  if (running) return running;

  const p = post('/Cartelera.aspx/GetNowPlayingByCity', { claveCiudad: key, esVIP: false }, opts)
    .then((d) => {
      cityCache.set(key, { at: Date.now(), data: d });
      return d;
    })
    .finally(() => cityInflight.delete(key));

  cityInflight.set(key, p);
  return p;
}

async function allCities(opts) {
  const cities = await getCities();
  const data = await Promise.all(
    cities.map((c) => getCity(c.key, opts).catch((err) => {
      if (err.blocked) throw err;
      return null;
    }))
  );
  return data.filter(Boolean);
}

/** Aplana toda la cartelera a funciones sueltas. */
function flatten(payloads) {
  const rows = [];
  for (const d of payloads) {
    for (const cine of d.Cinemas ?? []) {
      for (const dia of cine.Dates ?? []) {
        for (const movie of dia.Movies ?? []) {
          for (const fmt of movie.Formats ?? []) {
            for (const s of fmt.Showtimes ?? []) {
              const iso = msDate(s.TimeFilter);
              rows.push({
                id: `${s.VistaCinemaId || cine.VistaId}-${s.ShowtimeId}`,
                movieKey: movie.Key,
                movieTitle: movie.Title,
                poster: movie.Poster,
                cinemaId: String(s.VistaCinemaId || cine.VistaId),
                cinemaName: cine.Name,
                city: String(cine.CityName ?? '').replace(/,\s*Perú$/, ''),
                address: '',
                showtime: iso,
                day: limaDay(iso),
                screen: '',
                formats: [fmt.Name].filter(Boolean),
                languages: [fmt.Language].filter(Boolean),
                free: null,
                total: null,
                taken: null,
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

const getAll = memo(CATALOG_TTL, async () => flatten(await allCities()));

async function moviesList() {
  const rows = await getAll();
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.movieKey)) {
      byKey.set(r.movieKey, { id: r.movieKey, slug: r.movieKey, title: r.movieTitle, poster: r.poster, dates: new Set() });
    }
    byKey.get(r.movieKey).dates.add(r.day);
  }
  return [...byKey.values()]
    .map((m) => ({ ...m, dates: [...m.dates].filter(Boolean).sort() }))
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

async function availability(slug, date) {
  const rows = (await getAll()).filter((r) => r.movieKey === slug);
  if (!rows.length) throw Object.assign(new Error(`Película no encontrada: ${slug}`), { status: 404 });

  const allDates = [...new Set(rows.map((r) => r.day))].filter(Boolean).sort();
  const target = date || allDates[0];
  const sessions = rows
    .filter((r) => r.day === target)
    .sort(
      (a, b) =>
        a.cinemaName.localeCompare(b.cinemaName, 'es') ||
        String(a.showtime).localeCompare(String(b.showtime))
    );

  return {
    chain: 'cinepolis',
    movie: { id: slug, slug, title: rows[0].movieTitle, poster: rows[0].poster },
    date: target,
    dates: allDates,
    updatedAt: new Date().toISOString(),
    totals: { sessions: sessions.length, seats: 0, free: 0 },
    sessions,
  };
}

/** No hay ocupación pública en esta cadena. */
async function seatsFew() {
  return {};
}

async function health() {
  await client.get('/manejadores/CiudadesComplejos.ashx?EsVIP=false', { priority: 0 });
  return true;
}

module.exports = {
  id: 'cinepolis',
  name: 'Cinépolis',
  site: SITE,
  color: '#0a3a8f',
  // La ocupación está tras Cloudflare + reCAPTCHA: aquí solo horarios.
  capabilities: { lazySeats: false, seatplan: false, tickets: false, occupancy: false },
  // Sin ocupación no hay nada que cambie de un minuto a otro: la cartelera es
  // prácticamente estática, así que refrescar seguido no aporta nada.
  refreshWait: Number(process.env.CINEPOLIS_REFRESH_WAIT) || 300,
  moviesList,
  availability,
  seatsFew,
  health,
  stats: client.stats,
  isBlockedNow: client.isBlockedNow,
};
