import { requirePrincipal } from '@/lib/session';
import { createOfficialPlanAuthHttp } from '@/lib/hermes-team/official-plan-auth-http';
const controller=createOfficialPlanAuthHttp(requirePrincipal);
export const GET=controller.GET;
export const POST=controller.POST;
