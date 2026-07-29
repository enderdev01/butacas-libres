# Cómo contribuir

## Flujo de ramas

```
main ......... producción. Solo recibe merges desde develop.
develop ...... rama de integración y base de todo el trabajo.
  └── feat/… fix/… docs/…   tu rama, siempre partiendo de develop
```

Ni `main` ni `develop` aceptan commits directos: ambas están protegidas y todo entra por pull request.

## Pasos

```bash
git clone https://github.com/anthoniriv/butacas-libres.git
cd butacas-libres

git switch develop
git pull

git switch -c feat/mi-cambio     # fix/… docs/… chore/… según el caso
# … trabajas …

git push -u origin feat/mi-cambio
gh pr create --base develop      # el PR va SIEMPRE contra develop
```

`develop` es la rama por defecto del repositorio, así que los PR ya apuntan ahí salvo que lo cambies a mano.

Si no tienes permiso de escritura, haz un fork y abre el PR desde tu fork hacia `develop`.

## Qué pide el repositorio antes de mergear

- Una aprobación en el PR.
- Las conversaciones del review resueltas.
- Nada de force-push ni borrado sobre `main` y `develop`.

El merge lo hace el mantenedor ([@anthoniriv](https://github.com/anthoniriv)). El paso de `develop` a `main` también.

## Estilo

El proyecto no usa dependencias ni build. Al escribir código:

- Sigue el estilo de los archivos vecinos: comentarios en español, y solo donde expliquen *por qué*, no *qué*.
- Nada de librerías nuevas sin una razón fuerte. Node 18+ y su `fetch` bastan.

## Al tocar un proveedor

Cada cadena vive en `providers/` con la misma interfaz. Si añades una:

1. Exporta `id`, `name`, `color`, `capabilities`, `refreshWait`, `moviesList()`, `availability()`, `seatsFew()` y `health()`.
2. Usa `createClient()` de `lib/net.js` — te da cola, límite de tasa y detección de bloqueo.
3. Regístrala en `providers/index.js`.
4. Documenta sus endpoints en [`docs/apis.md`](docs/apis.md).

**Límite importante:** este proyecto lee webs ajenas. No se aceptan cambios que suban el ritmo de peticiones sin justificación, que añadan refresco automático, ni que intenten sortear captchas, Cloudflare o cualquier otra medida anti-bot. Si una cadena bloquea el acceso, la respuesta es pedir menos, no disfrazarse.
