import { db, type DbOrTx } from "@/db";
import { auditLog } from "@/db/schema";

/** Admin/security audit trail. Never put secrets in `details`. */
export async function audit(actorId: string | null, action: string, target?: string, details?: object, query: DbOrTx = db) {
  await query.insert(auditLog).values({ actorId, action, target, details: details ?? null });
}

/** The person remains the audit actor; attribution to the assistant is server-owned. */
export type AuditVia = { agent: "architect"; botId: string };
export async function auditVia(actorId: string, via: AuditVia, action: string, target?: string, details?: object, query: DbOrTx = db) {
  await audit(actorId, action, target, { ...details, via }, query);
}
