export type AdminSearchParams = Record<string, string | string[] | undefined>;

export const ADMIN_PAGE_SIZE = 50;

export function queryText(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function requestedPage(value: string | string[] | undefined): number {
  const page = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 1;
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function pageWindow(total: number, requested: number) {
  const pages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const page = Math.min(Math.max(1, requested), pages);
  const offset = (page - 1) * ADMIN_PAGE_SIZE;
  return { total, page, pages, offset, first: total ? offset + 1 : 0, last: Math.min(total, offset + ADMIN_PAGE_SIZE) };
}

export type AdminPageWindow = ReturnType<typeof pageWindow>;

export function adminListHref(path: string, filters: Record<string, string>, page = 1) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  if (page > 1) query.set("page", String(page));
  return `${path}${query.size ? `?${query}` : ""}`;
}

/** User-entered search is literal text, not an SQL LIKE wildcard expression. */
export function containsPattern(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}
