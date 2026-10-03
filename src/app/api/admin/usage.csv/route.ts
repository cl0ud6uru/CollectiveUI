import { errorResponse, requireAdmin } from "@/lib/session";
import { toCsv, USAGE_EXPORT_COLUMNS, usageExportRows } from "@/lib/usage";

export async function GET() {
  try {
    await requireAdmin();
    const csv = toCsv(await usageExportRows(90), USAGE_EXPORT_COLUMNS);
    return new Response(csv, {
      headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="usage.csv"' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
