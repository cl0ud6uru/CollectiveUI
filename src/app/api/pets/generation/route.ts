import { requirePrincipal } from "@/lib/session";
import { GET as listJobs, POST as createJob } from "@/app/api/admin/pets/generation/route";

export async function GET() {
  await requirePrincipal();
  return listJobs();
}

export async function POST(request: Request) {
  await requirePrincipal();
  return createJob(request);
}
