import { redirect } from "next/navigation";
import { requirePagePrincipal } from "@/lib/session";

export default async function SecurityPage() {
  await requirePagePrincipal();
  redirect("/settings?tab=security");
}
