import Link from "next/link";
import { adminListHref, type AdminPageWindow } from "@/lib/admin/listing";

export function AdminPagination({ window, path, filters, noun }: {
  window: AdminPageWindow; path: string; filters: Record<string, string>; noun: string;
}) {
  const { first, last, total, page, pages } = window;
  const style = "rounded-lg border border-border px-3 py-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2";
  return <nav aria-label={`${noun} pagination`} className="my-4 flex flex-wrap items-center justify-between gap-3 text-sm">
    <p role="status">{total ? `${first}–${last} of ${total.toLocaleString()} ${noun}` : `0 ${noun}`}</p>
    {pages > 1 && <div className="flex items-center gap-3">
      {page > 1 ? <Link className={style} href={adminListHref(path, filters, page - 1)}>Previous</Link> : <span className="px-3 py-2 text-subtle" aria-disabled="true">Previous</span>}
      <span>Page {page} of {pages}</span>
      {page < pages ? <Link className={style} href={adminListHref(path, filters, page + 1)}>Next</Link> : <span className="px-3 py-2 text-subtle" aria-disabled="true">Next</span>}
    </div>}
  </nav>;
}
