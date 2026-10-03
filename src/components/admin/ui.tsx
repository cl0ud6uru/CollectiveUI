import { cn } from "@/lib/utils";

export function AdminHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-2xl border border-border p-4", className)}>{children}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <Card>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-subtle">{sub}</div>}
    </Card>
  );
}

export function Table({ head, children }: { head: React.ReactNode[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ className, children, colSpan }: { className?: string; children?: React.ReactNode; colSpan?: number }) {
  return (
    <td className={cn("px-3 py-2 align-middle", className)} colSpan={colSpan}>
      {children}
    </td>
  );
}

export function Badge({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "green" | "red" | "amber" | "blue" }) {
  const tones = {
    default: "bg-surface-2 text-muted",
    green: "bg-green-500/15 text-green-700 dark:text-green-400",
    red: "bg-red-500/15 text-red-700 dark:text-red-400",
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    blue: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  };
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs", tones[tone])}>{children}</span>;
}
