import { randomUUID } from "node:crypto"
import type { Server as HttpServer } from "node:http"
import express, { type Request, type Response } from "express"
import rateLimit from "express-rate-limit"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"

interface Session {
  server: McpServer
  transport: StreamableHTTPServerTransport
  lastActivityAt: number
}

export interface HttpTransportOptions {
  /**
   * Address to bind to. Defaults to `127.0.0.1` (loopback only).
   *
   * Each session authenticates independently via the `Authorization:
   * Bearer <api-key>` or `X-API-Key` header sent with its `initialize`
   * request (see `extractApiKey`) — there is no shared, process-wide
   * credential. Binding to all interfaces is still an explicit opt-in
   * (`MCP_HTTP_HOST`) because a non-loopback bind also requires
   * `allowedHosts` to be set, for DNS-rebinding protection.
   */
  host?: string
  /**
   * Evict a session once it's been idle longer than this. Defaults to 30
   * minutes — long enough that a normal interactive agent session (a
   * human pausing to think, or a burst of tool calls a few minutes
   * apart) never gets cut off, short enough that an abandoned session
   * (client crash, tab close, network drop — none of which trigger a
   * `DELETE /mcp`) doesn't hold its `McpServer`/transport pair in memory
   * indefinitely on a long-running hosted server.
   */
  idleTimeoutMs?: number
  /**
   * How often to sweep `sessions` for idle entries. Defaults to 60
   * seconds — frequent enough that eviction lags the idle threshold by
   * at most a minute, cheap enough (a `Map` walk) to not matter at any
   * realistic session count.
   */
  sweepIntervalMs?: number
  /**
   * Hostnames this server is publicly reachable as, for Host-header
   * (DNS-rebinding) validation on a non-loopback bind. Required whenever
   * `host` is not loopback — `startHttpTransport` throws synchronously
   * otherwise, rather than starting with no Host validation at all. Not
   * used when `host` is loopback (the fixed `localhost`/`127.0.0.1`/
   * `[::1]` allowlist applies instead).
   */
  allowedHosts?: string[]
  /**
   * Rate limit for new-session (`initialize`) creation, keyed by
   * requester IP. Defaults to 30 per minute. Never applies to requests
   * that carry an existing `Mcp-Session-Id` — established sessions are
   * unaffected regardless of how many new sessions are being attempted.
   */
  sessionCreationRateLimit?: { windowMs: number; limit: number }
  /**
   * Value passed to Express's `trust proxy` setting. Required to be set
   * truthy (e.g. `1`, meaning "trust exactly one hop") whenever this
   * server sits behind a reverse proxy/load balancer (Railway's edge,
   * for instance) — otherwise `req.ip`, which `express-rate-limit`'s
   * default key generator uses, resolves to the proxy's address for
   * every request, collapsing the per-IP session-creation limit into
   * one shared global bucket across every caller. Left unset (Express's
   * own default, `false`) on a direct/loopback bind, where there is no
   * proxy hop to trust.
   */
  trustProxy?: boolean | number | string
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_SESSION_CREATION_RATE_LIMIT = { windowMs: 60_000, limit: 30 }
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

/** True when `host` only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * Stateful Streamable HTTP + SSE transport, per the MCP spec's own
 * required session lifecycle: a client's `Client.connect()` sends
 * `initialize` as one POST, gets an `Mcp-Session-Id` back, then sends
 * `notifications/initialized` (and every later request) as a *separate*
 * POST carrying that header — those later requests must be routed to the
 * same `McpServer`/transport pair the `initialize` call created, or the
 * server rejects them as "not initialized". A new `McpServer`/transport
 * pair is created only for the first request of a session (an
 * `initialize` request with no `Mcp-Session-Id` header yet); it's kept in
 * `sessions`, keyed by the ID the SDK assigns via `onsessioninitialized`,
 * and evicted either explicitly (`DELETE /mcp`, `transport.onclose`) or
 * by the idle-timeout sweep below — a normal client's `close()` does NOT
 * send `DELETE` (that requires the separate, opt-in
 * `transport.terminateSession()`), so without the sweep, any client that
 * disconnects without explicitly terminating (crash, tab close, network
 * drop) would leak its session forever on a long-running hosted server.
 *
 * Security: each session authenticates with its own API key, extracted
 * from the `initialize` request's `Authorization`/`X-API-Key` header (see
 * `extractApiKey`) — the server never validates that key itself, it is
 * forwarded to the Timbrix API on every call exactly as `TimbrixApiClient`
 * already does, so `apps/api`'s existing guards are the single source of
 * truth for whether it's valid. An `initialize` request with neither
 * header is rejected with 401 before any session is created. Host-header
 * (DNS-rebinding) validation applies unconditionally: the fixed
 * localhost allowlist on a loopback bind, `options.allowedHosts` on a
 * non-loopback one (required — see `HttpTransportOptions.allowedHosts`).
 */
export async function startHttpTransport(
  buildServer: (apiKey: string) => McpServer,
  port: number,
  options: HttpTransportOptions = {}
): Promise<HttpServer> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  const host = options.host ?? DEFAULT_HOST

  if (
    !isLoopbackHost(host) &&
    (!options.allowedHosts || options.allowedHosts.length === 0)
  ) {
    throw new Error(
      "startHttpTransport: `allowedHosts` is required when `host` is not loopback " +
        "(e.g. set MCP_ALLOWED_HOSTS to the public hostname this server is reachable as)."
    )
  }

  const app = express()

  if (options.trustProxy !== undefined) {
    app.set("trust proxy", options.trustProxy)
  }

  // Registered before the Host-validation middleware below on purpose: a
  // health probe isn't part of the DNS-rebinding threat model that
  // middleware exists for, but infrastructure health checks (Railway's
  // included) send their own Host header (e.g. `healthcheck.railway.app`)
  // that will never be in an operator's allowedHosts list. Express matches
  // routes in registration order and a route that sends a response never
  // reaches later middleware, so declaring it first exempts it entirely
  // rather than requiring every health-check origin to be allowlisted.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" })
  })

  // DNS-rebinding protection. On the default loopback bind, a malicious
  // web page can otherwise point a hostname it controls at 127.0.0.1 and
  // have the victim's browser drive this server — validating the Host
  // header against localhost-only names blocks that (per-session auth is
  // a second layer too: the attacker's page can't supply the victim's API
  // key). When the operator has explicitly opted into a non-loopback bind
  // via MCP_HTTP_HOST, they must provide an allowedHosts list; this
  // validates the Host header against that list, preserving DNS-rebinding
  // protection in a multi-tenant hosted environment where the fixed
  // localhost allowlist would not apply.
  if (isLoopbackHost(host)) {
    app.use(localhostHostValidation())
  } else {
    app.use(hostHeaderValidation(options.allowedHosts!))
  }

  app.use(express.json())

  const sessions = new Map<string, Session>()

  function touchSession(req: Request): Session | undefined {
    const sessionId = req.headers["mcp-session-id"]
    if (typeof sessionId !== "string") {
      return undefined
    }
    const session = sessions.get(sessionId)
    if (session) {
      session.lastActivityAt = Date.now()
    }
    return session
  }

  /** Extracts the caller's Timbrix API key from `Authorization: Bearer
   * <key>` (checked first) or `X-API-Key` — the same two headers
   * `apps/api`'s `FlexibleAuthGuard` already accepts, so client config is
   * interchangeable between local stdio and hosted HTTP. Returns
   * `undefined` when neither header carries one. */
  function extractApiKey(req: Request): string | undefined {
    const authHeader = req.headers.authorization
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const key = authHeader.slice("Bearer ".length).trim()
      if (key) {
        return key
      }
    }
    const apiKeyHeader = req.headers["x-api-key"]
    if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
      return apiKeyHeader.trim()
    }
    return undefined
  }

  const sessionCreationLimit =
    options.sessionCreationRateLimit ?? DEFAULT_SESSION_CREATION_RATE_LIMIT
  const sessionCreationLimiter = rateLimit({
    windowMs: sessionCreationLimit.windowMs,
    limit: sessionCreationLimit.limit,
    standardHeaders: true,
    legacyHeaders: false,
    // Only new-session attempts count against the limit — a request
    // carrying a known session header is routed straight to that
    // session's transport by the handler below and never creates
    // anything.
    skip: (req) => typeof req.headers["mcp-session-id"] === "string",
    handler: (_req, res) => {
      res.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Too many new-session attempts, try again shortly",
        },
        id: null,
      })
    },
  })

  app.post(
    "/mcp",
    sessionCreationLimiter,
    async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"]
      const existing = touchSession(req)

      if (existing) {
        await existing.transport.handleRequest(req, res, req.body)
        return
      }

      if (sessionId) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        })
        return
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        })
        return
      }

      const apiKey = extractApiKey(req)
      if (!apiKey) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message:
              "Missing credentials: provide an Authorization: Bearer <api-key> or X-API-Key header",
          },
          id: null,
        })
        return
      }

      const server = buildServer(apiKey)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, {
            server,
            transport,
            lastActivityAt: Date.now(),
          })
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId)
        }
        server.close()
      }
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    }
  )

  app.get("/mcp", async (req: Request, res: Response) => {
    const existing = touchSession(req)
    if (!existing) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      })
      return
    }
    await existing.transport.handleRequest(req, res)
  })

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"]
    const existing = touchSession(req)
    if (!existing) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      })
      return
    }
    await existing.transport.handleRequest(req, res)
    if (typeof sessionId === "string") {
      sessions.delete(sessionId)
    }
  })

  // Idle-session eviction: without this, a client that disconnects
  // without sending DELETE /mcp (the common case) leaks its
  // McpServer/transport pair in `sessions` forever. Deleting from the
  // map here (not just calling transport.close() and relying on
  // transport.onclose to do it) makes eviction take effect immediately
  // for routing purposes, regardless of how quickly onclose fires.
  const sweepInterval = setInterval(() => {
    const now = Date.now()
    for (const [sessionId, session] of sessions) {
      if (now - session.lastActivityAt > idleTimeoutMs) {
        sessions.delete(sessionId)
        void session.transport.close().catch(() => {
          // Best-effort cleanup — the session is already evicted from
          // routing either way.
        })
      }
    }
  }, sweepIntervalMs).unref()

  return new Promise<HttpServer>((resolve) => {
    const httpServer = app.listen(port, host, () => {
      console.error(`@timbrix/mcp HTTP transport listening on ${host}:${port}`)
      if (!isLoopbackHost(host)) {
        console.error(
          `@timbrix/mcp: accepting requests for Host header(s): ${(options.allowedHosts ?? []).join(", ")}. ` +
            "Each session authenticates independently via its own Authorization/X-API-Key header."
        )
      }
      resolve(httpServer)
    })
    httpServer.on("close", () => clearInterval(sweepInterval))
  })
}
