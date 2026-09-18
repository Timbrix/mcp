import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { TimbrixApiError } from "../client/timbrix-api.client"

/** Converts any thrown error from a `TimbrixApiClient` call into an MCP `isError` tool result instead of letting it crash the server process. */
export function toolError(error: unknown): CallToolResult {
  const message =
    error instanceof TimbrixApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unknown error"

  return {
    isError: true,
    content: [{ type: "text", text: message }],
  }
}
