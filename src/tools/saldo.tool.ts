import type { TimbrixApiClient } from "../client/timbrix-api.client"
import { toolError } from "./tool-error.util"
import type { ToolServer } from "./cfdi.tool"

export function registerSaldoTools(
  server: ToolServer,
  client: TimbrixApiClient
): void {
  server.registerTool(
    "timbrix_consultar_saldo",
    {
      title: "Consultar saldo de CFDI",
      description:
        "Devuelve cuántos CFDI ha timbrado la organización configurada en el mes calendario actual (hora Ciudad de México) contra el límite incluido en su plan, y cuándo se reinicia el periodo. Importante: `cfdiIncluded` y `cfdiRemaining` son `null` cuando el plan es enterprise (timbrado ilimitado), no cero — nunca reportes que al cliente le quedan 0 timbres en ese caso.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const usage = await client.getUsage()
        return {
          content: [{ type: "text", text: JSON.stringify(usage, null, 2) }],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )
}
