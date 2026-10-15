import { requirePrincipal } from "@/lib/session";
import { GET as getJob, POST as updateJob } from "@/app/api/admin/pets/generation/[id]/route";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  await requirePrincipal();
  return getJob(request, context);
}

export async function POST(request: Request, context: Context) {
  await requirePrincipal();
  return updateJob(request, context);
}
