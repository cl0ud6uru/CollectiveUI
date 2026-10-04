'use server';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/session';
import { HttpError } from '@/lib/authz';
import { setDockerEnrollment } from '@/lib/docker-hermes/enrollment';
export async function updateDockerEnrollment(userId: string, enabled: boolean) {
  const p = await requireAdmin();
  try {
    await setDockerEnrollment(p, userId, enabled);
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (e) { return { error: e instanceof HttpError ? e.message : 'Enrollment could not be saved. Refresh its status before retrying.' }; }
}
