import { errorResponse, requireAdmin } from "@/lib/session";
import { ADMIN_USAGE_DAYS, toCsv, USAGE_EXPORT_COLUMNS, usageExportRows } from "@/lib/usage";

export async function GET() {
  try {
    await requireAdmin();
    const csv = toCsv(await usageExportRows(ADMIN_USAGE_DAYS), USAGE_EXPORT_COLUMNS);
    return new Response(csv, {
      headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="usage-last-${ADMIN_USAGE_DAYS}-days.csv"` },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
