'use server';

import { revalidatePath } from 'next/cache';
import { HttpError } from '@/lib/authz';
import { requireAdmin } from '@/lib/session';
import { performDockerSandboxAction as perform, readDockerSandboxes as read } from '@/lib/docker-sandboxes/admin';

export async function readDockerSandboxes() {
  await requireAdmin();
  try { return await read(); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'SBX administration is unavailable. Refresh to check its current state.');
  }
}

export async function performDockerSandboxAction(input: unknown) {
  await requireAdmin();
  try {
    const result = await perform(input);
    revalidatePath('/admin/docker-sandboxes');
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'The SBX administration request could not be completed. Refresh before retrying.');
  }
}
