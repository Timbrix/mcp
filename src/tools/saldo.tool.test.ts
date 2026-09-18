import { describe, it, expect, vi } from "vitest"
import { registerSaldoTools } from "./saldo.tool"
import { TimbrixApiError } from "../client/timbrix-api.client"
import type { TimbrixApiClient } from "../client/timbrix-api.client"

interface ToolResult {
  isError?: boolean
  content: { type: string; text: string }[]
}

function fakeServer(): {
  registerTool: (
    name: string,
    config: unknown,
    handler: (input: unknown) => Promise<ToolResult>
  ) => void
  tools: Map<string, (input: unknown) => Promise<ToolResult>>
} {
  const tools = new Map<string, (input: unknown) => Promise<ToolResult>>()
  return {
    registerTool: (name, _config, handler) => {
      tools.set(name, handler)
    },
    tools,
  }
}

describe("registerSaldoTools", () => {
  it("timbrix_consultar_saldo returns the usage summary as JSON", async () => {
    const server = fakeServer()
    const client = {
      getUsage: vi.fn().mockResolvedValue({
        plan: "starter",
        cfdiIncluded: 100,
        cfdiUsedThisMonth: 30,
        cfdiRemaining: 70,
        periodResetsAt: "2026-09-01T06:00:00.000Z",
      }),
    }
    registerSaldoTools(server, client as unknown as TimbrixApiClient)

    const handler = server.tools.get("timbrix_consultar_saldo")!
    const result = await handler({})

    expect(client.getUsage).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.content[0]!.text)).toEqual(
      expect.objectContaining({ plan: "starter", cfdiRemaining: 70 })
    )
  })

  it("returns isError when the API call fails", async () => {
    const server = fakeServer()
    const client = {
      getUsage: vi
        .fn()
        .mockRejectedValue(new TimbrixApiError("Rate limited", 429)),
    }
    registerSaldoTools(server, client as unknown as TimbrixApiClient)

    const handler = server.tools.get("timbrix_consultar_saldo")!
    const result = await handler({})

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe("Rate limited")
  })
})
