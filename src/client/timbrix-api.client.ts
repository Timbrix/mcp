import { Timbrix, TimbrixApiError } from "@timbrix/sdk"
import type {
  CancelInvoiceInput,
  CfdiUsage,
  CreateInvoiceInput,
  Invoice,
  InvoiceCancellation,
  ListInvoicesParams,
  ListInvoicesResponse,
} from "@timbrix/sdk"

export { TimbrixApiError }

export interface TimbrixApiClientConfig {
  apiKey: string
  baseUrl?: string
  /** Escape hatch for tests — inject a pre-built SDK client instead of constructing one from apiKey/baseUrl. */
  sdk?: Timbrix
}

/**
 * Thin wrapper over `@timbrix/sdk`'s `Timbrix` client: calls the
 * organization-agnostic routes (no `organizationId` — the API resolves it
 * from the key itself, see TIM-114). Error translation from `ky`'s
 * `HTTPError` into `TimbrixApiError` (with a human-readable message
 * extracted from the API's JSON error body) now happens inside the SDK
 * itself (see `@timbrix/sdk`'s `client.ts` `beforeError` hook), so this
 * wrapper only needs a defensive fallback for the (should-not-happen) case
 * of a raw, non-SDK error reaching it.
 */
export class TimbrixApiClient {
  private readonly sdk: Timbrix

  constructor(config: TimbrixApiClientConfig) {
    this.sdk =
      config.sdk ??
      new Timbrix({ apiKey: config.apiKey, baseUrl: config.baseUrl })
  }

  async createInvoice(data: CreateInvoiceInput): Promise<Invoice> {
    return this.run(() => this.sdk.invoices.create(data))
  }

  async cancelInvoice(
    uuid: string,
    data: CancelInvoiceInput
  ): Promise<InvoiceCancellation> {
    return this.run(() => this.sdk.invoices.cancel(uuid, data))
  }

  async listInvoices(
    params?: ListInvoicesParams
  ): Promise<ListInvoicesResponse> {
    return this.run(() => this.sdk.invoices.list(params))
  }

  async getUsage(): Promise<CfdiUsage> {
    return this.run(() => this.sdk.invoices.usage())
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof TimbrixApiError) throw error
      throw new TimbrixApiError(
        error instanceof Error ? error.message : "Unknown error",
        0
      )
    }
  }
}
