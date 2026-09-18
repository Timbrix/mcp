import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { TimbrixApiClient } from "./client/timbrix-api.client"
import { registerCfdiTools } from "./tools/cfdi.tool"
import { registerSaldoTools } from "./tools/saldo.tool"

export { TimbrixApiClient, TimbrixApiError } from "./client/timbrix-api.client"
export type { TimbrixApiClientConfig } from "./client/timbrix-api.client"
export { startStdioTransport } from "./transport/stdio"
export { startHttpTransport } from "./transport/http"
export type { HttpTransportOptions } from "./transport/http"

/**
 * Builds the Timbrix MCP server with all v1 tools registered. Pure
 * library export with no side effects — the executable entry point lives
 * in `src/cli.ts` (the package's `bin`), so importing this module from a
 * test or another package never starts a server or reads env vars.
 */
export function createServer(client: TimbrixApiClient): McpServer {
  const server = new McpServer({ name: "timbrix", version: "0.1.0" })
  registerCfdiTools(server, client)
  registerSaldoTools(server, client)
  return server
}
