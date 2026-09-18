# @timbrix/mcp

[![npm version](https://img.shields.io/npm/v/@timbrix/mcp.svg)](https://www.npmjs.com/package/@timbrix/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

MCP (Model Context Protocol) server for Timbrix — lets AI agents (Claude, Cursor, ChatGPT, etc.) stamp, cancel, and query CFDI 4.0 invoices directly, through the same REST API `@timbrix/sdk` uses.

> **Full guide:** see [docs.timbrix.mx/ai-agents](https://docs.timbrix.mx/ai-agents) for setup, the complete tool reference, LangChain (TS/Python) examples, error handling, and authentication best practices for agents.
>
> This repository mirrors `packages/mcp` from the [Timbrix platform monorepo](https://github.com/Timbrix/timbrix-platform), synced automatically on every release. It's kept public and standalone so the source, examples, and issue tracker for `@timbrix/mcp` are easy to find and browse independently — open issues and PRs here.
>
> Listed in the [Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=timbrix) as `mx.timbrix/mcp`.

## v1 tools

| Tool                         | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `timbrix_crear_cfdi_ingreso` | Stamp a CFDI 4.0 Ingreso invoice                   |
| `timbrix_cancelar_cfdi`      | Cancel a stamped CFDI by UUID and motivo           |
| `timbrix_consultar_saldo`    | Get CFDI usage/quota for the current billing month |
| `timbrix_listar_cfdi`        | List invoices with page/type/status filters        |

> `timbrix_crear_emisor` (registering a new RFC issuer + CSD) is not available in v1 — organization creation and CSD upload require an authenticated owner session today, not an API key. See the Timbrix dashboard or `@timbrix/cli` to onboard a new organization.

## Installation

No install step is required to try it — `npx @timbrix/mcp` always runs the
latest published version. To install it globally instead:

```bash
npm install -g @timbrix/mcp
TIMBRIX_API_KEY=sk_... timbrix-mcp
```

### Claude Desktop (local, `npx`)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "timbrix": {
      "command": "npx",
      "args": ["@timbrix/mcp"],
      "env": {
        "TIMBRIX_API_KEY": "sk_..."
      }
    }
  }
}
```

### Claude Desktop (hosted, no install)

Point at `https://mcp.timbrix.mx/mcp` instead — same config file, no local process:

```json
{
  "mcpServers": {
    "timbrix": {
      "url": "https://mcp.timbrix.mx/mcp",
      "headers": {
        "Authorization": "Bearer sk_..."
      }
    }
  }
}
```

Any MCP client that supports a `url` + custom `headers` remote server config (Cursor included) works the same way.

## Environment variables

| Variable            | Required                                  | Description                                                                            |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `TIMBRIX_API_KEY`   | only for `stdio` (default)                | API key created in the Timbrix dashboard, scoped to one organization                   |
| `TIMBRIX_API_URL`   | no                                        | Overrides the API base URL (default `https://api.timbrix.mx`)                          |
| `MCP_TRANSPORT`     | no                                        | `stdio` (default, for local agents) or `http` (for hosted use)                         |
| `PORT`              | no                                        | HTTP transport port when `MCP_TRANSPORT=http` (default `8787`)                         |
| `MCP_HTTP_HOST`     | no                                        | HTTP transport bind address (default `127.0.0.1`, loopback only) — see below           |
| `MCP_ALLOWED_HOSTS` | only when `MCP_HTTP_HOST` is non-loopback | Comma-separated hostnames this server is publicly reachable as (Host-header allowlist) |

## Running the HTTP transport

```bash
MCP_TRANSPORT=http PORT=8787 npx @timbrix/mcp
```

Endpoints:

| Endpoint      | Purpose                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `POST /mcp`   | Streamable HTTP — `initialize`, then every subsequent JSON-RPC request |
| `GET /mcp`    | SSE stream for server-to-client messages on an established session     |
| `DELETE /mcp` | Explicitly terminate a session                                         |
| `GET /health` | Health check (`{ "status": "ok" }`)                                    |

### Sessions

The endpoint is **stateful**, as the MCP spec requires. A client's first
`POST /mcp` carries an `initialize` request and no session header; the server
creates one MCP server instance for it and returns an `Mcp-Session-Id`. Every
later request (starting with `notifications/initialized`) must send that header
back and is routed to the same instance — an unknown or missing session ID is
rejected rather than silently given a fresh, uninitialized server.

A session lives until one of:

- the client sends `DELETE /mcp` with its `Mcp-Session-Id`, or
- it goes **30 minutes** without a request, at which point the idle sweep evicts
  it (clients that crash, close, or lose the network never send `DELETE`, so
  without this they would leak).

After eviction, requests on that session ID get `404 Session not found`; a client
recovers by re-running `initialize`.

### Security: bind address, Host validation, and authentication

**In `http` mode, each session authenticates independently** via the
`Authorization: Bearer <api-key>` or `X-API-Key` header sent with the
client's `initialize` request — there is no single, process-wide API key.
The key is never validated by this package itself; it's forwarded to the
Timbrix API on every call, exactly as `stdio` mode already does, so the
Timbrix API's own key validation is the source of truth. An `initialize`
request with neither header is rejected with `401` before any session is
created.

- The server binds to `127.0.0.1` by default — reachable only from the
  same machine. Host-header (DNS-rebinding) validation is applied on this
  default, so a malicious web page cannot point a hostname it controls at
  your loopback server and drive it through the victim's browser.
- Set `MCP_HTTP_HOST` (e.g. `MCP_HTTP_HOST=0.0.0.0`) to expose it further —
  this also requires `MCP_ALLOWED_HOSTS`, since Host-header validation
  still applies on a non-loopback bind (the server refuses to start without
  it, rather than skipping validation altogether).
- New-session creation is rate-limited per IP (30/minute by default) to
  protect the process from unbounded session creation; requests on an
  already-established session are never affected by this limit.
- `GET /health` is exempt from Host validation, so infrastructure health
  probes (which send their own Host header, e.g. Railway's
  `healthcheck.railway.app`) don't need to be added to
  `MCP_ALLOWED_HOSTS`.
- Once a session is established, its `Mcp-Session-Id` header alone
  authorizes further requests on it — the API key isn't re-checked per
  request — so treat a session ID as sensitive as the credential that
  created it for the rest of that session's life.

For local, single-user agents, `stdio` (the default) still needs no port
at all and is the simplest option.

## Development

```bash
pnpm install
pnpm dev   # watch build
pnpm test  # vitest
pnpm build # tsup
```

## License

MIT © Timbrix — see [LICENSE](./LICENSE).
