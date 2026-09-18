# @timbrix/mcp

## 0.5.0

### Minor Changes

- 7b838d0: Update packages with 3 changes

  ## Features
  - **mcp**: add readOnlyHint/destructiveHint annotations to all tools
  - **mcp**: add server.json for the Official MCP Registry (domain auth)

## 0.4.0

### Minor Changes

- 6c91f38: Update packages with 10 changes

  ## Features
  - **mcp**: make TIMBRIX_API_KEY optional in HTTP transport mode
  - **mcp**: rate-limit new HTTP session creation
  - **mcp**: authenticate each HTTP session with its own API key
  - **mcp**: require an explicit Host allowlist on non-loopback binds

  ## Bug Fixes
  - **mcp**: address final review findings for TIM-136 remote server

## 0.3.4

### Patch Changes

- ec6f36d: harden @timbrix/sdk v1: typed errors, test suite, full README

  ## Features
  - **sdk**: normalize every failed request into a typed `TimbrixApiError` (code/suggestion/message, 429 retry-after hint) instead of ky's generic `HTTPError`
  - **sdk**: add a vitest test suite (92 tests, ~99% line coverage) covering every resource and the client's auth/error handling
  - **sdk**: rewrite the README with a <5-minute quickstart and full API reference for every resource

  ## Bug Fixes
  - **mcp**: rely on the SDK's own error normalization instead of re-parsing `HTTPError` bodies by hand, so `TimbrixApiError.statusCode` is no longer lost when relayed through `TimbrixApiClient`

- 737ae97: improve npm discoverability and document global install

  ## Bug Fixes
  - **mcp**: add "facturación"/"méxico"/"anthropic" keywords for npm search discoverability, and document `npm install -g @timbrix/mcp` in the README (previously only `npx` via Claude Desktop config was shown)

- Updated dependencies [784a712]
- Updated dependencies [7d731a2]
- Updated dependencies [ec6f36d]
  - @timbrix/sdk@2.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [646b436]
  - @timbrix/sdk@2.3.0

## 0.3.2

### Patch Changes

- Updated dependencies [0ecc1f4]
  - @timbrix/sdk@2.2.0

## 0.3.1

### Patch Changes

- Updated dependencies [61cc43f]
- Updated dependencies [6ad7229]
  - @timbrix/sdk@2.1.0

## 0.3.0

### Minor Changes

- 96e2b0d: Removed the `TIMBRIX_ORGANIZATION_ID` environment variable — it is no longer read and is no longer required. The organization is now resolved automatically from `TIMBRIX_API_KEY` via the new API-key-only routes added in this release. If you previously set `TIMBRIX_ORGANIZATION_ID`, it is now silently ignored and can be removed from your environment.

  **Requires the API to have deployed the corresponding org-agnostic routes (TIM-114)** — publishing this version before that API change is live will cause every MCP tool call to 404. Coordinate the release order: API first, then this package.

### Patch Changes

- Updated dependencies [96e2b0d]
  - @timbrix/sdk@2.0.0

## 0.2.0

### Minor Changes

- a4884f6: @timbrix/mcp v1: MCP server para timbrar, cancelar, listar y consultar saldo de CFDI desde agentes de IA

  ## Features
  - **@timbrix/mcp**: nuevo paquete — MCP server con las tools `timbrix_crear_cfdi_ingreso`, `timbrix_cancelar_cfdi`, `timbrix_consultar_saldo`, `timbrix_listar_cfdi`, transportes stdio (default) y Streamable HTTP.
  - **@timbrix/sdk**: `InvoicesResource.usage()` y `.cancel()` nuevos, respaldando el endpoint `GET organizations/:id/usage`.

  ## Fixes
  - **@timbrix/sdk**: corrige un bug urgente en `client.ts` — usaba la opción `prefixUrl` de `ky`, renombrada a `baseUrl` en `ky@2`. Esto rompía **toda** petición HTTP real a través del cliente `Timbrix` (CLI incluido), no solo el MCP nuevo — bug preexistente en la versión publicada actualmente en npm.
  - **@timbrix/sdk**: normaliza el `baseUrl` con un slash final — sin esto, `ky@2` reemplaza el último segmento de ruta de un `baseUrl` con sufijo (ej. `.../v1`) en vez de extenderlo, enrutando mal las peticiones en silencio.

### Patch Changes

- Updated dependencies [a4884f6]
  - @timbrix/sdk@1.5.0
