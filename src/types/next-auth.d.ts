import "next-auth";
import type { AuthProvider } from "@/lib/auth/config";

declare module "next-auth" {
  interface User { sessionVersion?: number; }
  interface Session {
    user: { id: string; sessionId: string; sessionVersion: number; mustChangePassword: boolean; authProvider?: AuthProvider | null; name?: string | null; email?: string | null; image?: string | null };
  }
}
