import { describe, it, expect, vi, afterEach } from "vitest"
import { TimbrixApiError } from "@timbrix/sdk"
import { createServer } from "node:http"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Timbrix } from "@timbrix/sdk"
import { TimbrixApiClient } from "./timbrix-api.client"

function fakeSdk(overrides: {
  create?: ReturnType<typeof vi.fn>
  cancel?: ReturnType<typeof vi.fn>
  list?: ReturnType<typeof vi.fn>
  usage?: ReturnType<typeof vi.fn>
}): Timbrix {
  return {
    invoices: {
      create: overrides.create ?? vi.fn(),
      cancel: overrides.cancel ?? vi.fn(),
      list: overrides.list ?? vi.fn(),
      usage: overrides.usage ?? vi.fn(),
    },
  } as unknown as Timbrix
}

describe("TimbrixApiClient", () => {
  it("calls the SDK without organizationId for createInvoice, listInvoices and getUsage", async () => {
    const create = vi.fn().mockResolvedValue({ id: "inv-1" })
    const list = vi.fn().mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 1,
    })
    const usage = vi.fn().mockResolvedValue({ plan: "starter" })
    const sdk = fakeSdk({ create, list, usage })
    const client = new TimbrixApiClient({
      apiKey: "sk_test",
      sdk,
    })

    await client.createInvoice({ series: "A" } as never)
    await client.listInvoices({ page: 1 })
    await client.getUsage()

    expect(create).toHaveBeenCalledWith({ series: "A" })
    expect(list).toHaveBeenCalledWith({ page: 1 })
    expect(usage).toHaveBeenCalledWith()
  })

  it("does not inject organizationId into cancelInvoice (scoped by uuid, not org)", async () => {
    const cancel = vi.fn().mockResolvedValue({ id: "cancel-1" })
    const sdk = fakeSdk({ cancel })
    const client = new TimbrixApiClient({
      apiKey: "sk_test",
      sdk,
    })

    await client.cancelInvoice("uuid-1", { motivo: "02" })

    expect(cancel).toHaveBeenCalledWith("uuid-1", { motivo: "02" })
  })

  it("passes a TimbrixApiError thrown by the SDK straight through unchanged", async () => {
    // The SDK itself normalizes every failed HTTP response into a
    // TimbrixApiError (see @timbrix/sdk's client.ts beforeError hook) —
    // this wrapper's job is just to not mangle it on the way out.
    const create = vi
      .fn()
      .mockRejectedValue(
        new TimbrixApiError("Invalid invoice payload", 400, "BAD_REQUEST")
      )
    const sdk = fakeSdk({ create })
    const client = new TimbrixApiClient({
      apiKey: "sk_test",
      sdk,
    })

    await expect(client.createInvoice({} as never)).rejects.toMatchObject({
      name: "TimbrixApiError",
      message: "Invalid invoice payload",
      statusCode: 400,
      code: "BAD_REQUEST",
    })
  })

  it("wraps a non-SDK error (e.g. a thrown bug) with a generic TimbrixApiError", async () => {
    const create = vi.fn().mockRejectedValue(new Error("network down"))
    const sdk = fakeSdk({ create })
    const client = new TimbrixApiClient({
      apiKey: "sk_test",
      sdk,
    })

    await expect(client.createInvoice({} as never)).rejects.toMatchObject({
      name: "TimbrixApiError",
      message: "network down",
    })
  })

  describe("real ky round-trip (regression: HTTPError body is consumed by ky)", () => {
    let server: Server | undefined

    afterEach(async () => {
      if (!server) return
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = undefined
    })

    it("propagates the real API's JSON error message, not ky's generic HTTPError message", async () => {
      server = createServer((req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ message: "organizationId not found" }))
      })
      await new Promise<void>((resolve) => server?.listen(0, resolve))
      const port = (server.address() as AddressInfo).port

      const client = new TimbrixApiClient({
        apiKey: "sk_test",
        baseUrl: `http://127.0.0.1:${port}`,
      })

      await expect(client.createInvoice({} as never)).rejects.toMatchObject({
        name: "TimbrixApiError",
        message: "organizationId not found",
        statusCode: 400,
      })
    })
  })
})
