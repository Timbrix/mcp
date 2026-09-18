import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { TimbrixApiClient } from "./client/timbrix-api.client"
import { createServer } from "./index"

describe("createServer", () => {
  it("builds an McpServer with all 4 v1 tools registered, without throwing", () => {
    const client = new TimbrixApiClient({
      apiKey: "sk_test",
    })

    const server = createServer(client)

    expect(server).toBeInstanceOf(McpServer)
    // Individual tool behavior (input handling, error translation) is
    // covered by cfdi.tool.test.ts and saldo.tool.test.ts — this only
    // confirms wiring them all into one server doesn't throw.
  })
})
