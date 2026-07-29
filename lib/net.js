// Capa de red compartida por los proveedores: una cola por origen, límite de
// tasa, reintentos y detección de bloqueo. Cada cadena tiene su propio estado,
// así que un bloqueo en Cineplanet no afecta a Cinemark.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AbortError extends Error {
  constructor() {
    super('cancelado');
    this.name = 'AbortError';
    this.aborted = true;
  }
}

class BlockedError extends Error {
  constructor(chain, ms) {
    super(`${chain} bloqueó temporalmente las peticiones desde esta IP. Espera ${Math.ceil(ms / 1000)}s.`);
    this.status = 503;
    this.retryAfter = Math.ceil(ms / 1000);
    this.blocked = true;
  }
}

/**
 * Cola única de salida. Todo el tráfico hacia un origen pasa por aquí, así que
 * abrir cinco sedes a la vez no multiplica la concurrencia: solo alarga la cola.
 * Las tareas canceladas se descartan ANTES de gastar una petición.
 */
class Queue {
  constructor(concurrency) {
    this.limit = concurrency;
    this.running = 0;
    this.tasks = [];
  }

  /** @param {{priority?: number, signal?: AbortSignal}} opts prioridad menor = antes */
  push(fn, { priority = 5, signal } = {}) {
    return new Promise((resolve, reject) => {
      this.tasks.push({ fn, priority, signal, resolve, reject, seq: Queue.seq++ });
      this.tasks.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.#drain();
    });
  }

  #drain() {
    while (this.running < this.limit && this.tasks.length) {
      const task = this.tasks.shift();
      if (task.signal?.aborted) {
        task.reject(new AbortError()); // lo que ya no interesa no llega a pedirse
        continue;
      }
      this.running++;
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.running--;
          this.#drain();
        });
    }
  }
}
Queue.seq = 0;

/** Caché con TTL y single-flight que sirve la copia vencida si el refresco falla. */
function memo(ttlMs, fn) {
  let value = null;
  let at = 0;
  let inflight = null;
  return async (...args) => {
    if (value && Date.now() - at < ttlMs) return value;
    if (inflight) return inflight;
    inflight = fn(...args)
      .then((v) => {
        value = v;
        at = Date.now();
        return v;
      })
      .catch((err) => {
        if (value) return value; // mejor un dato viejo que tumbar la respuesta
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/**
 * Cliente HTTP por origen.
 * @param {object} cfg
 * @param {string} cfg.chain nombre de la cadena, para los mensajes de error
 * @param {string} cfg.base URL base a la que se le cuelgan las rutas
 * @param {() => object} cfg.headers cabeceras de cada petición
 * @param {(res: Response, body: string) => boolean} [cfg.isBlocked] firma del WAF
 * @param {() => Promise<any>} [cfg.renew] renovación de sesión ante 401/403
 */
function createClient({ chain, base, headers, isBlocked, renew, rps, concurrency, maxTries = 4 }) {
  const queue = new Queue(concurrency);
  let slot = 0;
  let blockedUntil = 0;
  let blockStreak = 0;

  async function gate() {
    const now = Date.now();
    slot = Math.max(now, slot) + 1000 / rps;
    if (slot - now > 0) await sleep(slot - now);
  }

  function noteBlocked() {
    blockStreak = Math.min(blockStreak + 1, 6);
    const cool = Math.min(30000 * 2 ** (blockStreak - 1), 15 * 60 * 1000);
    blockedUntil = Date.now() + cool;
    return cool;
  }

  function assertNotBlocked() {
    const left = blockedUntil - Date.now();
    if (left > 0) throw new BlockedError(chain, left);
  }

  async function request(path, { signal } = {}) {
    assertNotBlocked();
    let gen = renew ? await renew() : 0;

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const last = attempt === maxTries;
      if (signal?.aborted) throw new AbortError();
      let res;
      try {
        await gate();
        res = await fetch(`${base}${path}`, { headers: headers(), signal });
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw new AbortError();
        if (last) throw new Error(`${path} -> ${err.message}`);
        await sleep(300 * 2 ** attempt);
        continue;
      }

      if (res.ok) {
        blockStreak = 0;
        blockedUntil = 0;
        return res.json();
      }
      const body = await res.text();

      if (isBlocked?.(res, body)) throw new BlockedError(chain, noteBlocked());

      if (res.status === 401 || res.status === 403) {
        if (last) throw new Error(`${path} -> HTTP ${res.status} tras ${maxTries} intentos`);
        if (renew) gen = await renew({ force: true, gen });
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (last) throw new Error(`${path} -> HTTP ${res.status}`);
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new Error(`${path} -> HTTP ${res.status}`);
    }
  }

  return {
    /** Encola un GET. `priority` 0 = acción directa del usuario. */
    get: (path, opts = {}) => queue.push(() => request(path, opts), opts),
    /** Para bloqueos detectados fuera de `get` (p. ej. durante el warmup). */
    markBlocked: () => new BlockedError(chain, noteBlocked()),
    /** Cabeceras del origen, para peticiones que no encajan en `get` (POST). */
    headers,
    stats: () => ({
      rps,
      concurrency: queue.limit,
      queued: queue.tasks.length,
      running: queue.running,
      blockedFor: Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000)),
      blockStreak,
    }),
    isBlockedNow: () => blockedUntil > Date.now(),
  };
}

module.exports = { createClient, Queue, memo, sleep, AbortError, BlockedError };
