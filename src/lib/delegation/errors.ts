import { HttpError } from "@/lib/http-error";

/** Fixed application guidance; arbitrary tool/provider errors remain private. */
export class DelegationBudgetError extends HttpError {
  readonly userFacing = true;
  constructor(scope: "root" | "async") {
    super(429, scope === "root" ? "This turn reached its delegated task budget."
      : "You have too many asynchronous tasks in progress. Wait for one to finish.");
    this.name = "DelegationBudgetError";
  }
}
