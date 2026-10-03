"use server";

import { revalidatePath } from "next/cache";
import { HttpError } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { cancelChatGPTDeviceLogin, pollChatGPTDeviceLogin, startChatGPTDeviceLogin, type DeviceLoginPoll, type DeviceLoginStart } from "@/lib/llm/chatgpt/device";
import { deleteChatGPTConnection } from "@/lib/llm/chatgpt/store";
import { requirePrincipal } from "@/lib/session";

// Results carry friendly errors instead of throwing: production builds hide thrown server action messages.
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

async function friendly<T>(fn: () => Promise<T>): Promise<Result<{ value: T }>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) return { ok: false, error: "Your portal session has expired. Sign in again." };
    if (err instanceof HttpError) return { ok: false, error: err.message };
    console.error("[chatgpt] connect failed", err);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/** Starts "Connect ChatGPT": returns the code to enter at OpenAI. */
export async function startChatGPTConnect(): Promise<Result<{ value: DeviceLoginStart }>> {
  return friendly(async () => startChatGPTDeviceLogin(await requirePrincipal()));
}

/** One poll of the sign-in in progress (the server decides whether it's time to ask OpenAI). */
export async function pollChatGPTConnect(): Promise<Result<{ value: DeviceLoginPoll }>> {
  const r = await friendly(async () => pollChatGPTDeviceLogin(await requirePrincipal()));
  if (r.ok && r.value.status === "connected") revalidatePath("/", "layout");
  return r;
}

export async function cancelChatGPTConnect(): Promise<Result<{ value: void }>> {
  return friendly(async () => cancelChatGPTDeviceLogin((await requirePrincipal()).user.id));
}

/** Disconnects this person's ChatGPT plan and revokes the sign-in at OpenAI. */
export async function disconnectChatGPT() {
  const p = await requirePrincipal();
  if (await deleteChatGPTConnection(p.user.id)) await audit(p.user.id, "chatgpt.disconnect", p.user.id);
  revalidatePath("/", "layout");
}
