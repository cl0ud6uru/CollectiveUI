import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="max-w-md text-sm text-muted">It may have been deleted, or the link is incorrect.</p>
      <Link href="/" className="mt-2 inline-flex h-10 items-center rounded-full bg-fg px-4 text-sm font-medium text-bg hover:opacity-85">
        Go to start
      </Link>
    </div>
  );
}
