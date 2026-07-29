# Cómo funcionan las APIs por dentro

Notas de ingeniería inversa de las tres cadenas: qué endpoint devuelve qué, qué hace falta para que respondan y con qué se topa uno por el camino. Todo lo de aquí sale de leer el tráfico que generan sus propias webs públicas.

> Nada de esto es documentación oficial ni promete estabilidad: son APIs internas y pueden cambiar sin aviso.

## API de Cinemark

Base `https://bff.cinemark-peru.com/api`. **Requiere la cabecera `country: PE`**; sin ella responde 500 con `Country undefined not implemented`.

| Endpoint | Devuelve |
|---|---|
| `GET /cinema/movies` | cartelera con `corporateId`, `slug`, `title`, `posterUrl` |
| `GET /cinema/theaters?limit=…` | 15 sedes con ciudad, dirección y coordenadas |
| `GET /cinema/showtimes?movieCorporateId=…&theater=…` | funciones de esa película en esa sede, **con `occupation.availableSeats` y `capacity`** |

Sin cookies ni token. La respuesta se cachea en el CDN, así que conviene un `_t=<timestamp>` para datos frescos.

## API de Cinépolis

| Endpoint | Método | Devuelve |
|---|---|---|
| `/manejadores/CiudadesComplejos.ashx?EsVIP=false` | GET | ciudades y sus complejos |
| `/Cartelera.aspx/GetNowPlayingByCity` | POST `{claveCiudad, esVIP}` | cartelera completa de la ciudad |

Es un ScriptService de ASP.NET: la respuesta viene envuelta en `{"d": "<json como string>"}`. Las fechas llegan como `/Date(1785343500000)/`. Una ciudad son ~163 KB con todos sus cines, días, películas y funciones — de ahí que una película cueste una sola petición cacheada.

## API interna de Cineplanet (reverse-engineered)

Base `https://www.cineplanet.com.pe/api/v1-web`.

| Endpoint | Devuelve |
|---|---|
| `GET /bootstrap-data` | payload cifrado; **su valor real es la cookie `channel-token` que emite** |
| `GET /cache/cinemascache` | 43 sedes: `ID`, `name`, `city`, `address`, lat/lng |
| `GET /cache/moviescache` | 112 películas: `id`, `title`, `movieDetailsUrl` (slug), poster, y `cinemas[].dates[].sessions[]` con ids `"{cinemaId}-{sessionId}"` |
| `GET /cache/sessioncache` | ~3.5k funciones: `id`, `showtime`, `screenName`, `formats`, `languages` |
| `GET /sessionavailable/cinema/{cinemaId}/session/{sessionId}` | `{ "available-seats": 43, "seatsTotal": 210 }` |
| `GET /seatplan/cinema/{cinemaId}/session/{sessionId}` | plano completo: filas y butacas con su estado |
| `GET /gettickets/cinema/{c}/session/{s}/usersessionid/{usid}` | tipos de entrada con `PriceInCents` |

El `usersessionid` de `gettickets` **no necesita ser real**: cualquier hex de 32 caracteres devuelve la tarifa. En el sitio sale de un `POST /get-order`, pero el endpoint no lo valida.

Estados de butaca en `seatplan` (`Seats[].Status`):

| Status | Significado |
|---|---|
| `0` | libre |
| `1` | ocupada |
| `3` | libre, espacio para silla de ruedas |
| `5` | hueco no vendible (no cuenta en `seatsTotal`) |

Verificado: `0` + `3` = `available-seats`, y `0+1+3` = `seatsTotal`. Las filas llegan de atrás hacia adelante, por eso `seatplan()` las invierte antes de servirlas.

### El 403

`cache/moviescache` y `sessionavailable/...` responden **403 Forbidden** a pelo. Requieren:

1. Header `Referer` de `cineplanet.com.pe`.
2. Cookie `channel-token`, obtenida pidiendo primero `/peliculas` y luego `/bootstrap-data`.

`cinemascache` y `sessioncache` no la piden. `providers/cineplanet.js` hace ese warmup y lo reintenta si el token caduca (TTL 20 min).

## Límites del origen (importante)

Detrás de `cineplanet.com.pe` hay un WAF de Azure que **corta por IP ante mucho volumen**. Cuando salta, responde 403 con un HTML de `The request is blocked` a *todo* lo que venga de esa IP — incluido tu navegador, no solo el scraper. Se levanta solo tras unos minutos.

El cliente lo trata como un estado, no como un error suelto:

- Detecta la firma del WAF (`looksBlocked`) y la distingue de un 403 por token vencido.
- Entra en enfriamiento exponencial (30 s → 15 min máx) y durante ese rato **corta en seco sin pegarle al origen**.
- El server responde `503` con `Retry-After` y `{ blocked: true }`; el front muestra el aviso y programa el reintento.

Medidas para no provocarlo:

| Ajuste | Defecto | Env |
|---|---|---|
| Peticiones por segundo (global) | 6 | `RPS` |
| Peticiones en paralelo | 6 | `CONCURRENCY` |
| Caché de asientos | 45 s | `SEAT_TTL_MS` |
| Reintentos por petición | 4 | `MAX_TRIES` |

### Cómo se emiten las peticiones

Todo el tráfico saliente pasa por **una sola cola** (`Queue` en `lib/net.js`), no por peticiones sueltas. Abrir cinco sedes a la vez no multiplica la concurrencia: solo alarga la cola.

- **Prioridad** — `0` acción directa del usuario (abrir el plano de butacas, precios) · `1` lote de una sede · `9` barrida completa. Lo urgente adelanta a lo que espera.
- **Cancelación** — cerrar una sede, cambiar de película o cerrar la pestaña aborta el `fetch`; el server propaga el `AbortSignal` y la cola **descarta las tareas antes de gastar la petición**.
- **Deduplicación** — si dos vistas piden la misma función a la vez, comparten una única petición en vuelo (`seatInflight`).
- **Ritmo** — `gate()` espacia las salidas a `RPS` por segundo, por encima del límite de concurrencia.

`GET /api/stats` muestra el estado: `{ rps, concurrency, queued, running, seatsCached, blockedFor, blockStreak }`.

Y sobre todo: **en Cineplanet la ocupación se pide por sede, no de golpe**. `/api/availability` no consulta asientos (0 peticiones al origen); el front pide los de cada sede al abrirla, ~20 en vez de 925. `?seats=all` recupera el comportamiento antiguo, pero es justo lo que dispara el bloqueo.

### Renovación de sesión

El token vence y el origen empieza a responder 403. La renovación es **single-flight con generaciones**: si 20 peticiones reciben 403 a la vez, se renueva una sola vez y las demás reutilizan el token nuevo en lugar de lanzar 20 warmups que se pisan entre sí (`renew(gen)` compara la generación con la que la petición salió). Si el catálogo falla al refrescarse, se sirve la copia vencida antes que romper la respuesta.