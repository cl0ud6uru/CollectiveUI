export const SANDBOX_PROFILE: 'collectiveui-sandbox-v1';
export const SECCOMP_PATH: string;
export const SECCOMP_SHA256: string;
export const APPARMOR_PATH: string;
export const APPARMOR_SHA256: string;
export function sandboxPolicy(profile?: string): Promise<{ create: string[]; inspect: string[]; appArmorProfile?: string }>;
export function dockerExecutable(value?: string): string;
