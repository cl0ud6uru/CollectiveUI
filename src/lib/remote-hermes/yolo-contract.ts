import type { NativeSessionView } from './view';

/** f97608f (release 0.21.5, desktop contract 8) and 6fa88c1 source have the stale-session guard.
 * Do not infer safe mutation from catalog presence or a newer/unknown version number.
 */
export function sessionYoloCompatible(view: Pick<NativeSessionView, 'runtimeVersion' | 'desktopContract' | 'nativeProfile' | 'profile'>) {
  return view.runtimeVersion === '0.21.5' && view.desktopContract === 8 && view.nativeProfile === view.profile;
}
export type YoloConfirmation = { confirmation: string; expiresAt: number; value: 'on' | 'off'; profile: string; title: string; effectiveBypass: boolean | null; approvalMode: string };
export function yoloStatus(view: Pick<NativeSessionView, 'yolo' | 'approvalMode'>) {
  return { effectiveBypass: typeof view.yolo === 'boolean' ? view.yolo : null, approvalMode: view.approvalMode || 'not reported' };
}
export function yoloStatusText(view: Pick<NativeSessionView, 'yolo' | 'approvalMode'>, sessionValue?: 'on' | 'off') {
  const state = yoloStatus(view);
  return `${sessionValue ? `Session YOLO flag set ${sessionValue.toUpperCase()}. ` : ''}Hermes effective approval bypass: ${state.effectiveBypass === null ? 'not reported' : state.effectiveBypass ? 'ON' : 'OFF'}. Profile approval mode: ${state.approvalMode}.`
    + (sessionValue === 'off' && state.effectiveBypass ? ' Bypass remains active: profile/process policy or another native client can keep it enabled; session OFF does not revoke those settings.' : '')
    + ' Session changes affect other native clients sharing this conversation. Hermes hard deny rules and runtime access limits remain in force.';
}
