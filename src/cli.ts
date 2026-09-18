import { TimbrixApiClient } from "./client/timbrix-api.client"
import { createServer } from "./index"
import { startStdioTransport } from "./transport/stdio"
import { startHttpTransport, isLoopbackHost } from "./transport/http"

/**
 * Production API origin, used when `TIMBRIX_API_URL` is unset. The
 * default lives here rather than in `@timbrix/sdk` on purpose: the SDK's
 * own `baseUrl` default (`http://localhost:3001`) is what `@timbrix/cli`
 * and local-dev workflows fall back to, so changing it would be a
 * breaking change for every other consumer. `@timbrix/mcp` is the package
 * whose README/spec promise "defaults to production", so it supplies its
 * own default explicitly.
 */
const DEFAULT_API_URL = "https://api.timbrix.mx"

/** Loopback-only by default — see `startHttpTransport`'s `host` option. */
const DEFAULT_HTTP_HOST = "127.0.0.1"

function readEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required environment variable: ${name}`)
    process.exit(1)
  }
  return value
}

/** Parses a comma-separated `MCP_ALLOWED_HOSTS` into the list
 * `startHttpTransport` expects, trimming whitespace, lowercasing (the
 * SDK's Host-header validation compares against a hostname the WHATWG URL
 * parser has already lowercased, so an un-lowercased entry like
 * `MCP.Timbrix.MX` could never match any real request), and dropping
 * empty entries. Returns `undefined` when unset, so `startHttpTransport`
 * falls through to its own "required on non-loopback bind" check rather
 * than this file inventing a default. */
function readAllowedHosts(): string[] | undefined {
  const raw = process.env.MCP_ALLOWED_HOSTS
  if (!raw) {
    return undefined
  }
  const hosts = raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0)
  return hosts.length > 0 ? hosts : undefined
}

async function main(): Promise<void> {
  const baseUrl = process.env.TIMBRIX_API_URL ?? DEFAULT_API_URL
  const transport = process.env.MCP_TRANSPORT ?? "stdio"

  if (transport === "http") {
    // Multi-tenant: each session supplies its own API key over the
    // Authorization/X-API-Key header (see transport/http.ts), so there is
    // no single operator key to read here.
    const port = Number(process.env.PORT ?? 8787)
    const host = process.env.MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST
    const allowedHosts = readAllowedHosts()
    await startHttpTransport(
      (apiKey) => createServer(new TimbrixApiClient({ apiKey, baseUrl })),
      port,
      {
        host,
        allowedHosts,
        // Only trust a proxy hop on a non-loopback bind (mirroring
        // allowedHosts, which is likewise only required there). Trusting
        // X-Forwarded-For with no real proxy in front (plain local
        // testing) would let any same-network peer spoof it and evade
        // the session-creation rate limit.
        trustProxy: isLoopbackHost(host) ? undefined : 1,
      }
    )
  } else {
    const apiKey = readEnv("TIMBRIX_API_KEY")
    const client = new TimbrixApiClient({ apiKey, baseUrl })
    await startStdioTransport(createServer(client))
  }
}

// This module is the package's `bin` entry point and nothing else — it is
// never imported as a library, so `main()` runs unconditionally. The
// previous `process.argv[1] === fileURLToPath(import.meta.url)` guard
// looked equivalent but silently never fired under `npx`/global installs:
// npm exposes a bin as a *symlink* in `node_modules/.bin`, so `argv[1]` is
// the symlink path while `import.meta.url` is the realpath-resolved
// target, and the two never match. Keeping the entry point separate from
// `src/index.ts` (which stays a side-effect-free library export) removes
// that whole class of bug by construction.
await main().catch((error: unknown) => {
  console.error("Fatal error starting @timbrix/mcp:", error)
  process.exit(1)
})
