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
  try {
    await requireAdmin();
    const result = await perform(input);
    const action = input as { action?: string };
    if (!['diagnose', 'network-read', 'network-check'].includes(action.action ?? '')) revalidatePath('/admin/docker-sandboxes');
    return { ok: true as const, ...result };
  } catch (error) {
    // Expected failures must cross the production Server Action boundary as data.
    // Thrown errors are redacted by React into an opaque server-render error.
    return { ok: false as const, error: error instanceof HttpError ? error.message
      : 'The SBX administration request could not be completed. Refresh before retrying.' };
  }
}
