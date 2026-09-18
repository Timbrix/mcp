import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CreateInvoiceInput } from "@timbrix/sdk"
import type { TimbrixApiClient } from "../client/timbrix-api.client"
import { toolError } from "./tool-error.util"

export type ToolServer = Pick<McpServer, "registerTool">

const invoiceCustomerSchema = z.object({
  legalName: z.string().min(1),
  taxId: z.string().min(12).max(13),
  taxSystem: z.string().optional(),
  zip: z.string().optional(),
})

const invoiceTaxSchema = z.object({
  type: z.string(),
  factorType: z.string(),
  rate: z.string().optional(),
  base: z.number().optional(),
  amount: z.number().optional(),
  withholding: z.boolean().optional(),
})

const invoiceItemSchema = z.object({
  quantity: z.number().positive(),
  amount: z.number(),
  productId: z.string().optional(),
  description: z.string().optional(),
  unitPrice: z.number().optional(),
  productKey: z.string().optional(),
  unitKey: z.string().optional(),
  unit: z.string().optional(),
  taxObject: z.string().optional(),
  taxes: z.array(invoiceTaxSchema).optional(),
})

/**
 * Input shape for `timbrix_crear_cfdi_ingreso`. Exported as a raw shape
 * (what `registerTool` needs) plus a `z.object` wrapper so tests can run
 * the real Zod validation directly — the schema an MCP client sees is the
 * only thing telling the calling agent which fields are mandatory, so it
 * has to match `CreateInvoiceInput`/the API's `CreateInvoiceDto`.
 */
export const crearCfdiIngresoShape = {
  series: z.string().min(1).describe("Serie del folio (ej. 'A')"),
  folioNumber: z.string().min(1).describe("Número de folio"),
  date: z
    .string()
    .min(1)
    .describe(
      "Obligatorio. Fecha y hora de emisión del CFDI en ISO 8601 sin zona horaria, en hora local de Ciudad de México (America/Mexico_City, UTC-6) — NUNCA en UTC. El PAC compara este valor directamente contra su propio reloj de servidor, que está en hora de México sin ninguna conversión; una fecha en UTC se ve ~6 horas en el futuro y el timbrado falla (a veces reportado como el confuso 'CFDI40102 - digestión no coincide con el sello' en vez de un error de fecha claro). El SAT exige que esté dentro de las 72 horas previas al timbrado, por lo que debe indicarla explícitamente el llamador; el servidor no la asigna por su cuenta."
    ),
  paymentForm: z
    .string()
    .describe(
      "Clave SAT de forma de pago (catálogo c_FormaPago), ej. '01' = Efectivo"
    ),
  paymentMethod: z.enum(["PUE", "PPD"]).optional(),
  currency: z.string().optional(),
  exchange: z.number().optional(),
  use: z
    .string()
    .describe("Clave SAT de uso de CFDI (catálogo c_UsoCFDI), ej. 'G01'"),
  customer: invoiceCustomerSchema
    .optional()
    .describe("Datos del receptor (excluyente con customerId)"),
  customerId: z
    .string()
    .optional()
    .describe("ID de un cliente ya registrado (excluyente con customer)"),
  items: z.array(invoiceItemSchema).min(1).describe("Conceptos del CFDI"),
  idempotencyKey: z.string().optional(),
  requiere_confirmacion: z
    .boolean()
    .optional()
    .describe(
      "Si es true, valida el subtotal estimado del CFDI (suma de items[].amount) contra `umbral_confirmacion_mxn` antes de timbrar. Si lo supera y `confirmado` no es true, el tool NO timbra: retorna un mensaje estructurado pidiendo confirmación explícita en vez de proceder. Default: false (no bloquea el flujo estándar)."
    ),
  umbral_confirmacion_mxn: z
    .number()
    .positive()
    .optional()
    .describe(
      "Monto en MXN a partir del cual se requiere confirmación explícita antes de timbrar. Obligatorio cuando `requiere_confirmacion` es true."
    ),
  confirmado: z
    .boolean()
    .optional()
    .describe(
      "Envíalo como true en una segunda llamada, después de que un humano confirme explícitamente, para timbrar a pesar de que el subtotal supere `umbral_confirmacion_mxn`. Default: false."
    ),
}

export const crearCfdiIngresoSchema = z.object(crearCfdiIngresoShape)

export function registerCfdiTools(
  server: ToolServer,
  client: TimbrixApiClient
): void {
  server.registerTool(
    "timbrix_crear_cfdi_ingreso",
    {
      title: "Timbrar CFDI de ingreso",
      description:
        "Timbra (sella ante el SAT vía PAC) un CFDI 4.0 de tipo Ingreso para la organización configurada. Devuelve el UUID fiscal, el XML timbrado y el estatus.",
      inputSchema: crearCfdiIngresoShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
      try {
        // Control-only fields for the TIM-92 confirmation hook — stripped
        // out of `invoiceInput` below so they never reach the real API
        // payload (the API DTO doesn't know about them).
        const {
          requiere_confirmacion,
          umbral_confirmacion_mxn,
          confirmado,
          ...invoiceInput
        } = input

        if (requiere_confirmacion) {
          if (umbral_confirmacion_mxn === undefined) {
            return toolError(
              new Error(
                "umbral_confirmacion_mxn es requerido cuando requiere_confirmacion es true."
              )
            )
          }

          // Misma fórmula que usa la API para calcular el subtotal real
          // (ver invoice-payload-resolver.service.ts: sum + concepto.amount)
          // — una estimación fiel hecha del lado del MCP, antes de llamar
          // a la API, ya que el subtotal "oficial" solo lo calcula el PAC
          // después de timbrar.
          const subtotalEstimadoMxn = invoiceInput.items.reduce(
            (sum, item) => sum + item.amount,
            0
          )

          if (subtotalEstimadoMxn > umbral_confirmacion_mxn && !confirmado) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      requiereConfirmacion: true,
                      subtotalEstimadoMxn,
                      umbralConfirmacionMxn: umbral_confirmacion_mxn,
                      mensaje: `Este CFDI tiene un subtotal estimado de $${subtotalEstimadoMxn.toFixed(2)} MXN, que supera el umbral de confirmación configurado ($${umbral_confirmacion_mxn.toFixed(2)} MXN). Obtén confirmación explícita de un humano antes de continuar, y vuelve a llamar a esta herramienta con el mismo payload agregando "confirmado": true.`,
                    },
                    null,
                    2
                  ),
                },
              ],
            }
          }
        }

        // `type` is forced to "I" — this tool only stamps Ingreso. The
        // rest of the payload is checked against `CreateInvoiceInput` for
        // real (no blanket `as never`), so any future drift between this
        // schema and the SDK/API contract is a compile error.
        const payload: CreateInvoiceInput = { ...invoiceInput, type: "I" }
        const invoice = await client.createInvoice(payload)
        return {
          content: [{ type: "text", text: JSON.stringify(invoice, null, 2) }],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    "timbrix_cancelar_cfdi",
    {
      title: "Cancelar CFDI",
      description:
        "Solicita la cancelación de un CFDI ya timbrado ante el SAT. Si el receptor debe aprobar la cancelación, el resultado queda en estatus 'pendiente'.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        uuid: z
          .string()
          .describe("UUID fiscal (folio fiscal) del CFDI a cancelar"),
        motivo: z
          .enum(["01", "02", "03", "04"])
          .describe(
            "01 = con relación (requiere folioSustitucion), 02 = sin relación, 03 = no se llevó a cabo la operación, 04 = operación nominativa de factura global"
          ),
        folioSustitucion: z
          .string()
          .optional()
          .describe(
            "UUID del CFDI que sustituye a este; requerido cuando motivo=01"
          ),
      },
    },
    async ({ uuid, motivo, folioSustitucion }) => {
      try {
        const cancellation = await client.cancelInvoice(uuid, {
          motivo,
          folioSustitucion,
        })
        return {
          content: [
            { type: "text", text: JSON.stringify(cancellation, null, 2) },
          ],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    "timbrix_listar_cfdi",
    {
      title: "Listar CFDI",
      description:
        "Lista los CFDI timbrados de la organización configurada, más recientes primero, con filtros opcionales de tipo y estatus.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        page: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(100).optional(),
        type: z.enum(["I", "E", "T"]).optional(),
        status: z.enum(["vigente", "cancelado"]).optional(),
      },
    },
    async (input) => {
      try {
        const result = await client.listInvoices(input)
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )
}
