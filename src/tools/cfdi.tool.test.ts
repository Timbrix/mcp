import { describe, it, expect, vi } from "vitest"
import { registerCfdiTools, crearCfdiIngresoSchema } from "./cfdi.tool"
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

/** A payload that would actually stamp — every field the API's
 * `CreateInvoiceDto` marks required for a type=I CFDI. */
function validIngresoInput(): Record<string, unknown> {
  return {
    series: "A",
    folioNumber: "1",
    date: "2026-08-29T12:00:00",
    paymentForm: "01",
    use: "G03",
    customer: {
      legalName: "ESCUELA KEMPER URGATE SA DE CV",
      taxId: "EKU9003173C9",
      taxSystem: "601",
      zip: "45079",
    },
    items: [
      {
        quantity: 1,
        amount: 100,
        description: "Servicio de consultoría",
        unitPrice: 100,
        productKey: "84111506",
        unitKey: "E48",
      },
    ],
  }
}

// These exercise the Zod schema itself, not the tool handler: the schema
// object is literally what an MCP client shows the calling agent, so a
// field wrongly marked optional here means the agent omits it and the API
// rejects the very first real stamping attempt. The fake server below
// ignores the schema entirely (it never validates `config`), so only a
// direct `safeParse` can catch that class of drift.
describe("crearCfdiIngresoSchema", () => {
  it("accepts a realistic Ingreso payload", () => {
    const result = crearCfdiIngresoSchema.safeParse(validIngresoInput())

    expect(result.success).toBe(true)
    expect(result.data?.date).toBe("2026-08-29T12:00:00")
  })

  it("rejects a payload missing `date` — the API requires it (SAT 72h rule)", () => {
    const withoutDate = validIngresoInput()
    delete withoutDate.date

    const result = crearCfdiIngresoSchema.safeParse(withoutDate)

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(
      "date"
    )
  })

  it("rejects an empty `date` string", () => {
    const result = crearCfdiIngresoSchema.safeParse({
      ...validIngresoInput(),
      date: "",
    })

    expect(result.success).toBe(false)
  })
})

describe("registerCfdiTools", () => {
  it("timbrix_crear_cfdi_ingreso forces type=I and returns the created invoice as JSON", async () => {
    const server = fakeServer()
    const client = {
      createInvoice: vi.fn().mockResolvedValue({ id: "inv-1", uuid: "uuid-1" }),
    }
    registerCfdiTools(server, client as unknown as TimbrixApiClient)

    const handler = server.tools.get("timbrix_crear_cfdi_ingreso")!
    const result = await handler(validIngresoInput())

    expect(client.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        series: "A",
        type: "I",
        date: "2026-08-29T12:00:00",
      })
    )
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      id: "inv-1",
      uuid: "uuid-1",
    })
  })

  it("timbrix_crear_cfdi_ingreso overrides a caller-supplied type with type=I", async () => {
    const server = fakeServer()
    const client = {
      createInvoice: vi.fn().mockResolvedValue({ id: "inv-1", uuid: "uuid-1" }),
    }
    registerCfdiTools(server, client as unknown as TimbrixApiClient)

    const handler = server.tools.get("timbrix_crear_cfdi_ingreso")!
    await handler({ ...validIngresoInput(), type: "E" })

    expect(client.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ type: "I" })
    )
  })

  it("timbrix_crear_cfdi_ingreso returns isError on API failure without throwing", async () => {
    const server = fakeServer()
    const client = {
      createInvoice: vi
        .fn()
        .mockRejectedValue(new TimbrixApiError("Invalid invoice payload", 400)),
    }
    registerCfdiTools(server, client as unknown as TimbrixApiClient)

    const handler = server.tools.get("timbrix_crear_cfdi_ingreso")!
    const result = await handler(validIngresoInput())

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe("Invalid invoice payload")
  })

  describe("timbrix_crear_cfdi_ingreso — requiere_confirmacion (TIM-92)", () => {
    it("stamps normally when requiere_confirmacion is omitted, ignoring any threshold", async () => {
      const server = fakeServer()
      const client = {
        createInvoice: vi
          .fn()
          .mockResolvedValue({ id: "inv-1", uuid: "uuid-1" }),
      }
      registerCfdiTools(server, client as unknown as TimbrixApiClient)

      const handler = server.tools.get("timbrix_crear_cfdi_ingreso")!
      const result = await handler(validIngresoInput())

      expect(client.createInvoice).toHaveBeenCalled()
      expect(result.isError).toBeFalsy()
    })

    it("stamps normally when requiere_confirmacion is true but the estimated subtotal is under the threshold", async () => {
      const server = fakeServer()
      const client = {
        createInvoice: vi
          .fn()
          .mockResolvedValue({ id: "inv-1", uuid: "uuid-1" }),
      }
      registerCfdiTools(server, client as unknown as TimbrixApiClient)

      const handler = server.tools.get("timbrix_crear_cfdi_ingreso")!
      // validIngresoInput() has a single item with amount: 100
      const result = await handler({
        ...validIngresoInput(),
        requiere_confirmacion: true,
        umbral_confirmacion_mxn: 500000,
      })

      expect(client.createInvoice).toHaveBeenCalled()
      expect(result.isError).toBeFalsy()
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        id: "inv-1",
        uuid: "uuid-1",
      })
    })

    it("blocks stamping and returns a structured pending-confirmation message when the estimated subtotal exceeds the threshold", async () => {
      const server = fakeServer()
      const client = {
        createInvoice: vi
          .fn()
          .mockResolvedValue({ id: "inv-1", uuid: "uuid-1" }),
      }
      registerCfdiTools(server, client as unknown as TimbrixApiClient)

      const handler = server.tools.get("timbrix_crear_cfdi_ingreso")!
      const result = await handler({
        ...validIngresoInput(),
        requiere_confirmacion: true,
        umbral_confirmacion_mxn: 50,
      })

      expect(client.createInvoice).not.toHaveBeenCalled()
      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed).toMatchObject({
        requiereConfirmacion: true,
        subtotalEstimadoMxn: 100,
        umbralConfirmacionMxn: 50,
      })
      expect(parsed.mensaje).toContain("confirmado")
    })

    it("proceeds to stamp despite exceeding the threshold when confirmado is true", async () => {
      const server = fakeServer()
      const client = {
        createInvoice: vi
          .fn()
          .mockResolvedValue({ id: "inv-1", uuid: "uuid-1" }),
      }
      registerCfdiTools(server, client as unknown as TimbrixApiClient)

      const handler = server.tools.get("timbrix_crear_cfdi_ingreso")!
      const result = await handler({
        ...validIngresoInput(),
        requiere_confirmacion: true,
        umbral_confirmacion_mxn: 50,
        confirmado: true,
      })

      expect(client.createInvoice).toHaveBeenCalled()
      expect(result.isError).toBeFalsy()
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        id: "inv-1",
        uuid: "uuid-1",
      })
    })

    it("never leaks requiere_confirmacion/umbral_confirmacion_mxn/confirmado into the API payload", async () => {
      const server = fakeServer()
      const client = {
        createInvoice: vi
          .fn()
          .mockResolvedValue({ id: "inv-1", uuid: "uuid-1" }),
      }
      registerCfdiTools(server, client as unknown as TimbrixApiClient)

      const handler = server.tools.get("timbrix_crear_cfdi_ingreso")!
      await handler({
        ...validIngresoInput(),
        requiere_confirmacion: true,
        umbral_confirmacion_mxn: 500000,
        confirmado: true,
      })

      const sentPayload = client.createInvoice.mock.calls[0]![0]
      expect(sentPayload).not.toHaveProperty("requiere_confirmacion")
      expect(sentPayload).not.toHaveProperty("umbral_confirmacion_mxn")
      expect(sentPayload).not.toHaveProperty("confirmado")
    })

    it("returns isError when requiere_confirmacion is true but umbral_confirmacion_mxn is missing", async () => {
      const server = fakeServer()
      const client = {
        createInvoice: vi.fn(),
      }
      registerCfdiTools(server, client as unknown as TimbrixApiClient)

      const handler = server.tools.get("timbrix_crear_cfdi_ingreso")!
      const result = await handler({
        ...validIngresoInput(),
        requiere_confirmacion: true,
      })

      expect(client.createInvoice).not.toHaveBeenCalled()
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain("umbral_confirmacion_mxn")
    })
  })

  it("timbrix_cancelar_cfdi passes uuid, motivo and folioSustitucion to the client", async () => {
    const server = fakeServer()
    const client = {
      cancelInvoice: vi.fn().mockResolvedValue({ id: "cancel-1" }),
    }
    registerCfdiTools(server, client as unknown as TimbrixApiClient)

    const handler = server.tools.get("timbrix_cancelar_cfdi")!
    await handler({ uuid: "uuid-1", motivo: "01", folioSustitucion: "uuid-2" })

    expect(client.cancelInvoice).toHaveBeenCalledWith("uuid-1", {
      motivo: "01",
      folioSustitucion: "uuid-2",
    })
  })

  it("timbrix_listar_cfdi forwards filters to the client", async () => {
    const server = fakeServer()
    const client = {
      listInvoices: vi.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 1,
      }),
    }
    registerCfdiTools(server, client as unknown as TimbrixApiClient)

    const handler = server.tools.get("timbrix_listar_cfdi")!
    await handler({ page: 2, limit: 10, status: "vigente" })

    expect(client.listInvoices).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      status: "vigente",
    })
  })
})
