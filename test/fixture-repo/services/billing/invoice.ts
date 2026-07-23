/** Billing invoice logic. Owned by `billing`. */
export interface LineItem {
  description: string;
  cents: number;
}

export function invoiceTotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.cents, 0);
}
