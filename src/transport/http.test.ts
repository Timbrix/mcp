import { describe, it, expect, afterEach } from "vitest"
import { request as httpRequest, type Server } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpTransport } from "./http"

/** Builds a minimal `McpServer` with a `ping` tool and a `whoami` tool that
 * echoes back `label` — standing in for the real `createServer` from
 * `src/index.ts` — enough to exercise a real client's `connect()` ->
 * `listTools()`/`callTool()` flow without depending on `TimbrixApiClient`.
 * `label` lets a test distinguish which server instance actually answered a
 * request — `ping` alone can't, since every instance answers it
 * identically. */
function buildTestServer(label = "default"): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  server.registerTool(
    "ping",
    { title: "Ping", description: "Returns pong", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] })
  )
  server.registerTool(
    "whoami",
    {
      title: "Whoami",
      description: "Returns the label baked into this server instance",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: label }] })
  )
  return server
}

/** Returns a `buildServer` callback that hands out a distinct label
 * ("instance-1", "instance-2", ...) to each `McpServer` it builds — one
 * call per session, since `startHttpTransport` calls `buildServer()` once
 * per `initialize` request. */
function labeledServerBuilder(): (apiKey: string) => McpServer {
  let count = 0
  return () => {
    count += 1
    return buildTestServer(`instance-${count}`)
  }
}

/** GETs `path` over loopback with an explicit `Host` header and resolves
 * with the status code. `fetch` can't do this — undici treats `Host` as a
 * forbidden header and silently overwrites it with the real target — so a
 * raw `http.request` is the only way to exercise Host-header validation. */
function getWithHost(
  port: number,
  path: string,
  host: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode ?? 0))
      }
    )
    req.on("error", reject)
    req.end()
  })
}

function firstTextContent(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>
  const block = content.find((item) => item.type === "text")
  if (!block?.text) {
    throw new Error("Expected a text content block")
  }
  return block.text
}

const TEST_API_KEY = "sk_test_default"

/** A `StreamableHTTPClientTransport` pointed at `/mcp` on `port`, carrying
 * `apiKey` as an `Authorization: Bearer` header — what every test that
 * expects a session to succeed needs, now that `initialize` requires
 * credentials. */
function authedTransport(
  port: number,
  apiKey: string = TEST_API_KEY
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }
  )
}

describe("startHttpTransport", () => {
  let server: Server | undefined
  const clients: Client[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.close()
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
  })

  async function startTestServer(
    buildServer: (apiKey: string) => McpServer = buildTestServer,
    options?: Parameters<typeof startHttpTransport>[2]
  ): Promise<number> {
    server = await startHttpTransport(buildServer, 0, options)
    const address = server.address()
    return typeof address === "object" && address ? address.port : 0
  }

  it("serves a health check on GET /health", async () => {
    const port = await startTestServer()

    const response = await fetch(`http://127.0.0.1:${port}/health`)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ status: "ok" })
  })

  it("serves /health even with a Host header that would be rejected on /mcp", async () => {
    // Regression test for the fix this addresses: Railway's deployment
    // healthcheck sends its own Host header (e.g.
    // healthcheck.railway.app), which is never in an operator's
    // MCP_ALLOWED_HOSTS. /health must be exempt from Host validation
    // entirely, or every hosted deploy's healthcheck fails with 403.
    const port = await startTestServer(buildTestServer, {
      host: "0.0.0.0",
      allowedHosts: ["mcp.timbrix.mx"],
    })

    const status = await getWithHost(port, "/health", "healthcheck.railway.app")

    expect(status).toBe(200)
  })

  it("lets a real MCP client connect and list tools over a session", async () => {
    // Regression test for the bug this fix addresses: the previous
    // implementation built a brand-new McpServer/transport pair per
    // request while still assigning a session ID, so a real client's
    // second request (notifications/initialized, sent with the
    // Mcp-Session-Id header from the initialize response) hit an
    // uninitialized server instance and was rejected with "Server not
    // initialized". `client.connect()` resolving at all proves that no
    // longer happens.
    const port = await startTestServer()
    const client = new Client({ name: "test-client", version: "0.0.0" })
    const transport = authedTransport(port)

    await client.connect(transport)
    clients.push(client)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain("ping")
  })

  it("routes each concurrently connecting client's requests to its own session", async () => {
    // Both clients get their own McpServer instance (via
    // labeledServerBuilder), each baked with a different `whoami` answer.
    // Every instance answers `ping` identically, so a test that only
    // checked `listTools()`/`ping` wouldn't distinguish "routed
    // correctly" from "routed to the wrong session that happens to
    // answer identically" — e.g. a `getSession` bug that always returned
    // the map's first entry regardless of the Mcp-Session-Id header would
    // still pass a ping-only check. Asserting each client's `whoami`
    // result matches only *its own* server instance's label rules that
    // out.
    const port = await startTestServer(labeledServerBuilder())

    const clientA = new Client({ name: "client-a", version: "0.0.0" })
    const transportA = authedTransport(port)
    const clientB = new Client({ name: "client-b", version: "0.0.0" })
    const transportB = authedTransport(port)

    await Promise.all([
      clientA.connect(transportA),
      clientB.connect(transportB),
    ])
    clients.push(clientA, clientB)

    expect(transportA.sessionId).toBeDefined()
    expect(transportB.sessionId).toBeDefined()
    expect(transportA.sessionId).not.toBe(transportB.sessionId)

    const [resultA, resultB] = await Promise.all([
      clientA.callTool({ name: "whoami", arguments: {} }),
      clientB.callTool({ name: "whoami", arguments: {} }),
    ])

    const labelA = firstTextContent(resultA)
    const labelB = firstTextContent(resultB)

    expect(labelA).not.toBe(labelB)
    expect([labelA, labelB].sort()).toEqual(["instance-1", "instance-2"])
  })

  it("rejects a session when no credentials are provided", async () => {
    const port = await startTestServer()
    const client = new Client({ name: "no-auth-client", version: "0.0.0" })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    )

    await expect(client.connect(transport)).rejects.toThrow()
  })

  it("does not create a session when credentials are missing", async () => {
    const port = await startTestServer(labeledServerBuilder())

    const rejected = new Client({ name: "no-auth", version: "0.0.0" })
    const rejectedTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    )
    await expect(rejected.connect(rejectedTransport)).rejects.toThrow()

    // If the failed attempt had still called buildServer, this would be
    // "instance-2" instead of "instance-1".
    const accepted = new Client({ name: "with-auth", version: "0.0.0" })
    await accepted.connect(authedTransport(port))
    clients.push(accepted)

    const result = await accepted.callTool({ name: "whoami", arguments: {} })
    expect(firstTextContent(result)).toBe("instance-1")
  })

  it("accepts credentials via the X-API-Key header", async () => {
    const port = await startTestServer()
    const client = new Client({ name: "x-api-key-client", version: "0.0.0" })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { "X-API-Key": TEST_API_KEY } } }
    )

    await client.connect(transport)
    clients.push(client)

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain("ping")
  })

  it("prefers Authorization over X-API-Key when both are present", async () => {
    const port = await startTestServer((apiKey) => buildTestServer(apiKey))
    const client = new Client({ name: "both-headers", version: "0.0.0" })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: "Bearer from-bearer",
            "X-API-Key": "from-x-api-key",
          },
        },
      }
    )

    await client.connect(transport)
    clients.push(client)

    const result = await client.callTool({ name: "whoami", arguments: {} })
    expect(firstTextContent(result)).toBe("from-bearer")
  })

  it("passes each session's own API key to buildServer, isolated per session", async () => {
    const port = await startTestServer((apiKey) => buildTestServer(apiKey))

    const clientA = new Client({ name: "a", version: "0.0.0" })
    const clientB = new Client({ name: "b", version: "0.0.0" })

    await Promise.all([
      clientA.connect(authedTransport(port, "key-a")),
      clientB.connect(authedTransport(port, "key-b")),
    ])
    clients.push(clientA, clientB)

    const [resultA, resultB] = await Promise.all([
      clientA.callTool({ name: "whoami", arguments: {} }),
      clientB.callTool({ name: "whoami", arguments: {} }),
    ])

    expect(firstTextContent(resultA)).toBe("key-a")
    expect(firstTextContent(resultB)).toBe("key-b")
  })

  it("rate-limits new-session creation but not requests on an existing session", async () => {
    const port = await startTestServer(buildTestServer, {
      sessionCreationRateLimit: { windowMs: 60_000, limit: 1 },
    })

    const first = new Client({ name: "first", version: "0.0.0" })
    await first.connect(authedTransport(port, "key-1"))
    clients.push(first)

    const second = new Client({ name: "second", version: "0.0.0" })
    await expect(
      second.connect(authedTransport(port, "key-2"))
    ).rejects.toThrow()

    // The limiter only gates *new* sessions — the one already established
    // above keeps working past the limit.
    const result = await first.callTool({ name: "ping", arguments: {} })
    expect(firstTextContent(result)).toBe("pong")
  })

  it("binds to loopback only by default", async () => {
    // Even with per-session auth, a session's credential still comes from
    // whoever can reach the port — binding all interfaces by default
    // would let anyone on the network open sessions (with their own or a
    // stolen key) against this process. Asserting the bound address (not
    // just that a loopback request works) is what distinguishes
    // 127.0.0.1 from 0.0.0.0, since both answer localhost.
    await startTestServer()

    const address = server!.address()

    expect(typeof address).toBe("object")
    expect((address as { address: string }).address).toBe("127.0.0.1")
  })

  it("rejects a spoofed Host header on the default loopback bind", async () => {
    // DNS-rebinding protection: a page on attacker.example could resolve
    // its own hostname to 127.0.0.1 and drive this server through the
    // victim's browser. The SDK's Host-header validation blocks it.
    // Targets /mcp rather than /health: /health is intentionally exempt
    // from Host validation (see startHttpTransport) so infrastructure
    // health probes aren't subject to the allowlist, so it can no longer
    // be used to exercise this middleware.
    const port = await startTestServer()

    const status = await getWithHost(port, "/mcp", "attacker.example")

    expect(status).toBe(403)
  })

  it("still serves requests whose Host header is a localhost name", async () => {
    // 400, not 200: a valid Host header lets the request past the
    // validation middleware and into the /mcp GET handler, which then
    // rejects it for the unrelated reason that no session header was
    // sent — proving the *middleware* accepted the Host, which is what
    // this test is about.
    const port = await startTestServer()

    const status = await getWithHost(port, "/mcp", `localhost:${port}`)

    expect(status).toBe(400)
  })

  it("throws when bound to a non-loopback host without allowedHosts", async () => {
    // Fail-closed: an operator hosting this publicly must say which
    // hostnames are legitimate, rather than the server silently skipping
    // Host validation altogether.
    await expect(
      startHttpTransport(buildTestServer, 0, { host: "0.0.0.0" })
    ).rejects.toThrow(/allowedHosts/)
  })

  it("rejects a Host header not in the configured allowedHosts", async () => {
    // Targets /mcp — see the loopback-bind Host-rejection test above for
    // why /health can no longer be used here.
    const port = await startTestServer(buildTestServer, {
      host: "0.0.0.0",
      allowedHosts: ["mcp.timbrix.mx"],
    })

    const status = await getWithHost(port, "/mcp", "attacker.example")

    expect(status).toBe(403)
  })

  it("accepts a Host header in the configured allowedHosts", async () => {
    // 400, not 200 — see the loopback-bind Host-acceptance test above.
    const port = await startTestServer(buildTestServer, {
      host: "0.0.0.0",
      allowedHosts: ["mcp.timbrix.mx"],
    })

    const status = await getWithHost(port, "/mcp", "mcp.timbrix.mx")

    expect(status).toBe(400)
  })

  it("evicts a session once it has been idle past the configured timeout", async () => {
    const port = await startTestServer(buildTestServer, {
      idleTimeoutMs: 50,
      sweepIntervalMs: 20,
    })
    const client = new Client({ name: "idle-client", version: "0.0.0" })
    const transport = authedTransport(port)

    await client.connect(transport)
    clients.push(client)

    const sessionId = transport.sessionId
    expect(sessionId).toBeDefined()

    // Give the sweep at least a couple of ticks past the idle threshold,
    // with no further requests on this session in between.
    await new Promise((resolve) => setTimeout(resolve, 200))

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId as string,
      },
      body: JSON.stringify({}),
    })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error.message).toBe("Session not found")
  })

  it("tracks separate IPs from X-Forwarded-For as separate rate-limit buckets when trustProxy is set", async () => {
    // Regression test for the bug this fix addresses: without `trust
    // proxy` set, express-rate-limit's default key generator uses
    // `req.ip`, which — behind a reverse proxy — is the proxy's address
    // for every request, collapsing the per-IP session-creation limit
    // into one shared global bucket. With `trustProxy: 1`, Express
    // resolves `req.ip` from the first `X-Forwarded-For` entry instead,
    // so two requests claiming different client IPs get independent
    // quotas even though both physically arrive over the same loopback
    // connection in this test.
    const port = await startTestServer(buildTestServer, {
      sessionCreationRateLimit: { windowMs: 60_000, limit: 1 },
      trustProxy: 1,
    })

    const first = new Client({ name: "first", version: "0.0.0" })
    await first.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${TEST_API_KEY}`,
              "X-Forwarded-For": "1.1.1.1",
            },
          },
        }
      )
    )
    clients.push(first)

    const second = new Client({ name: "second", version: "0.0.0" })
    await second.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${TEST_API_KEY}`,
              "X-Forwarded-For": "2.2.2.2",
            },
          },
        }
      )
    )
    clients.push(second)

    // Both connected without hitting the limit=1 rate limit — proving
    // they were attributed to separate buckets rather than one shared
    // one.
    expect(first.getServerVersion()).toBeDefined()
    expect(second.getServerVersion()).toBeDefined()
  })

  it("returns 401 with a JSON-RPC error body when credentials are missing", async () => {
    const port = await startTestServer()

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw-test", version: "0.0.0" },
        },
      }),
    })
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.error.message).toMatch(/Authorization|X-API-Key/)
  })

  it("returns 429 with a JSON-RPC error body when the session-creation limit is hit", async () => {
    const port = await startTestServer(buildTestServer, {
      sessionCreationRateLimit: { windowMs: 60_000, limit: 1 },
    })

    const first = new Client({ name: "first", version: "0.0.0" })
    await first.connect(authedTransport(port, "key-1"))
    clients.push(first)

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer key-2",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw-test-2", version: "0.0.0" },
        },
      }),
    })
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(body.error.message).toMatch(/Too many/)
  })
})
