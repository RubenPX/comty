# Protobuf de la API cliente → servidor de Comty

## Alcance

El contrato se genera **solo** desde `packages/server/services/*/routes` y `ws_routes`.
Incluye parámetros de ruta, cuerpos y consultas observados o declarados, cabeceras utilizadas,
subida binaria/multipart, respuestas inferidas y los DTOs transitivamente necesarios.

No incluye IPC del SFU, API local de escritorio, wrapper web, rutas internas de Linebridge,
proxy externo Spectrum ni esquemas completos de persistencia. Leer modelos y tipos compartidos
para resolver una respuesta no significa exportar toda la base de datos.

El archivo describe el contrato. **No transforma el servidor existente en un servidor gRPC.**
Los `rpc` de WebSocket son una representación documental petición/respuesta, no un nuevo streaming
bidireccional. SSE, redirecciones y respuestas binarias requieren adaptación de transporte.

## Archivos

- `comty.proto`: contrato proto3, paquete `comty.v1`.
- `comty.tags.json`: numeración persistente de campos. Conservar y versionar junto al contrato.
- `comty.coverage.json`: inventario de rutas/eventos, tipos no resueltos y archivos analizados.
- `comty.pb`: descriptor compilado con sus imports, generado por el validador.

Generador: `../../scripts/generate-proto.ts` y `../../scripts/proto-analysis.ts`.
La entrada Python `../../scripts/generate_proto.py` invoca el mismo generador con Bun.

## Cómo interpretar el coverage

El bloque `counts` de `comty.coverage.json` resume el alcance del análisis y del contrato generado. Cada contador mide una cosa distinta: operaciones, definiciones protobuf, archivos o casos de inferencia. Los valores siguientes corresponden a esta entrega y pueden cambiar al regenerar.

| Campo | Valor | Qué significa |
|---|---:|---|
| `apiHttp` | **180** | Operaciones HTTP encontradas en las rutas del servidor. Se cuenta cada combinación **método + ruta**: `GET /auth` y `POST /auth` serían dos operaciones. |
| `ws` | **37** | Eventos WebSocket que el servidor recibe, como `channel:send`. No es el número de conexiones ni necesariamente todos los eventos que emite el servidor. |
| `messages` | **530** | Definiciones `message` generadas en el `.proto`: peticiones, respuestas, objetos anidados y contenedores auxiliares. No son mensajes enviados durante la ejecución. |
| `services` | **18** | Bloques `service` del `.proto`: **13 de HTTP y 5 de WebSocket**. No significa que existan 18 servidores independientes. |
| `sourceFiles` | **584** | Archivos fuente incluidos como entradas del análisis estático del servidor y de los tipos compartidos. No todos producen una definición protobuf. |
| `unresolved` | **399** | Casos de inferencia donde no se pudo determinar un tipo concreto, por ejemplo `any`, uniones heterogéneas u objetos dinámicos. Se conservan mediante `Value`/`Struct`. Incluye intentos intermedios y elimina registros idénticos. |

**`unresolved` no equivale a 399 endpoints incompletos ni permite calcular un porcentaje usando `messages`: cuentan cosas distintas.** La cobertura de operaciones es **180 + 37 = 217**; la precisión del tipado es otra medida.

## Regenerar y comprobar

Desde `packages/server`, con las dependencias del workspace instaladas:

```sh
bun run build:proto
bun run check:proto
bun run test:proto
bun run typecheck:proto
```

`check:proto` es de solo lectura y falla si el contrato, la cobertura o el manifiesto no están
actualizados. El generador no arranca servicios, no ejecuta handlers ni conecta a bases de datos.

Opciones:

```sh
bun scripts/generate-proto.ts --out docs/proto/comty.proto
bun scripts/generate-proto.ts --out /ruta/export.proto --tags docs/proto/comty.tags.json
```

Al exportar a otra ruta, utilizar el manifiesto existente si se necesita mantener compatibilidad.
Los campos nuevos reciben números nuevos; los eliminados quedan `reserved`. Un cambio de tipo o
de cardinalidad incompatible falla: hay que versionar explícitamente el contrato, no borrar el
manifiesto de una versión publicada para silenciar el error.

## Compilar y validar

El generador requiere Bun y TypeScript 5.9.3 (dependencia de desarrollo). La validación es opcional:

```sh
python3 -m venv .venv-proto
.venv-proto/bin/python -m pip install -r scripts/proto-requirements.txt
.venv-proto/bin/python scripts/validate_proto.py
```

El validador compila con `protoc`, compara **cada** operación con el inventario, comprueba los
números del manifiesto y realiza pruebas locales de serialización binaria, presencia de campos
y valores JSON dinámicos. Sus datos son fixtures locales, no respuestas simuladas del servidor.

Con un `protoc` instalado también se puede generar código para el lenguaje elegido:

```sh
protoc -I docs/proto --csharp_out=/ruta/salida docs/proto/comty.proto
```

Los únicos imports protobuf son los tipos estándar de Google; no se necesita `google/api/annotations.proto`.

## Extracción y fidelidad

La estructura de rutas replica el loader de Linebridge: solo `get|post|put|delete|patch|options|head`
en archivos `.js` o `.ts`; `[param]` se convierte en `:param` y `[$]` en `*`.
Los eventos WS usan nombres con `:`, por ejemplo `channel:message:update`.
Los `.spec.js` no son handlers HTTP. `update.js` tampoco es un verbo reconocido.

Se usa el AST y el TypeChecker de TypeScript, incluyendo casts, tipos contextuales y funciones
locales/importadas que reciben el objeto de petición. Se preservan arrays, maps, objetos anidados,
fechas y claves JSON originales. Las opciones `http_method`, `http_path`, `ws_event` y `source_file`
quedan dentro de los descriptores para que un adaptador pueda leerlas.

**Cobertura de operaciones no equivale a tipado exhaustivo.** Muchos handlers JS/TS declaran `any`
o construyen JSON dinámico. Esos valores se conservan como `google.protobuf.Value`/`Struct` y se
señalan en el informe. Las claves observadas no se presentan como esquemas de validación completos;
`_unmodeled` permite conservar las no observadas. Las uniones heterogéneas también pueden quedar
como `Value`. Los números TS se representan como `double` sin inventar restricciones enteras.

El inventario incluye los handlers HTTP del servidor con restricciones de permisos. Documentar
un RPC no lo convierte en público ni elimina sus middlewares de autenticación/autorización.

## Verificación de esta entrega

- 180 operaciones HTTP y 37 eventos WS: 217 RPCs.
- 18 servicios protobuf (13 HTTP y 5 grupos WS).
- 530 mensajes alcanzables desde peticiones/respuestas.
- 7 tests Bun y 1 test de la entrada Python aprobados.
- TypeScript, compilación protobuf, comparación del descriptor y round-trips aprobados.
- No se ha levantado el servidor ni probado el funcionamiento real de cada endpoint.

Los tests Bun están separados de Vitest para no introducir un import `bun:test` en su suite Node.
