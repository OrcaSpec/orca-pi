/** Public API service. Owned by `api` (sibling-adjacent to billing). */
export function handleRequest(path: string): { status: number } {
  return { status: path === "/health" ? 200 : 404 };
}
