// GENERATED — do not edit by hand. Under services/billing/, but the billing
// agent declares a write-deny on services/billing/generated/**, so even the
// owner cannot write here. Regenerate via the build, not a delegation.
export const BILLING_SCHEMA_VERSION = 3;
export interface InvoiceRow {
  id: string;
  total_cents: number;
}
