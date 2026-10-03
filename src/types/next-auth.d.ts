import "next-auth";

declare module "next-auth" {
  interface User { sessionVersion?: number; }
  interface Session {
    user: { id: string; sessionId: string; sessionVersion: number; mustChangePassword: boolean; name?: string | null; email?: string | null; image?: string | null };
  }
}
