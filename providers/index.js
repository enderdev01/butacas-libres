// Registro de cadenas. Añadir una es escribir un módulo con esta misma forma
// (`moviesList`, `availability`, `seatsFew`, `health`, `capabilities`) y listarlo aquí.

const cineplanet = require('./cineplanet');
const cinemark = require('./cinemark');
const cinepolis = require('./cinepolis');

const list = [cineplanet, cinemark, cinepolis];
const byId = new Map(list.map((p) => [p.id, p]));

/** Datos públicos de cada cadena, sin tocar la red. */
const catalog = () =>
  list.map((p) => ({
    id: p.id,
    name: p.name,
    site: p.site,
    color: p.color,
    capabilities: { occupancy: true, ...p.capabilities }, // salvo que diga lo contrario
    refreshWait: p.refreshWait ?? 120, // segundos entre actualizaciones manuales
    blocked: p.isBlockedNow(),
  }));

function get(id) {
  const p = byId.get(id);
  if (!p) throw Object.assign(new Error(`Cadena desconocida: ${id}`), { status: 404 });
  return p;
}

/** Un GET barato por cadena para saber cuáles están respondiendo ahora. */
async function health() {
  const results = await Promise.all(
    list.map(async (p) => {
      const t = Date.now();
      try {
        await p.health();
        return { id: p.id, ok: true, ms: Date.now() - t };
      } catch (err) {
        return {
          id: p.id,
          ok: false,
          ms: Date.now() - t,
          blocked: !!err.blocked,
          retryAfter: err.retryAfter ?? null,
          error: String(err.message || err),
        };
      }
    })
  );
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

module.exports = { list, get, catalog, health };
