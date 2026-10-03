"use server";

import { headers } from "next/headers";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { AuthError } from "next-auth";
import { safeCallback } from "@/lib/auth/callback";
import { signIn } from "@/auth";
import { redirect } from "next/navigation";
import { localEnabled } from "@/lib/auth/config";
import { localPasswordChangeRequired } from "@/lib/auth/local";

export async function ldapLogin(_prev: string | null, formData: FormData): Promise<string | null> {
  try {
    await signIn("ldap", {
      username: formData.get("username"),
      password: formData.get("password"),
      redirectTo: safeCallback(formData.get("callbackUrl")),
    });
    return null;
  } catch (err) {
    if (err instanceof AuthError) return "Incorrect username or password.";
    throw err; // NEXT_REDIRECT on success
  }
}

export async function entraLogin(formData: FormData) {
  await signIn("microsoft-entra-id", { redirectTo: safeCallback(formData.get("callbackUrl")) });
}

export async function localLogin(_prev: string | null, formData: FormData): Promise<string | null> {
  assertAuthOrigin(await headers());
  if (!localEnabled()) return "Unable to sign in. Check your credentials or try again later.";
  try {
    await signIn("local", {
      username: formData.get("username"), password: formData.get("password"),
      redirect: false,
    });
    // auth() reads the incoming request cookies, not the new cookie written by signIn.
    const mustChange = await localPasswordChangeRequired(String(formData.get("username") ?? ""));
    redirect(mustChange ? "/account/password" : safeCallback(formData.get("callbackUrl")));
  } catch (err) {
    if (err instanceof AuthError) return "Unable to sign in. Check your credentials or try again later.";
    throw err;
  }
}
