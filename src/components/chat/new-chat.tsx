"use client";

import { usePathname } from "next/navigation";
import { useState, type ComponentProps } from "react";
import { Chat } from "./chat";

/**
 * A fresh chat for the "/" route. The conversation id is created in the browser and the chat only
 * resets when the user navigates to "New chat" (or switches app/bot) — not when a server action
 * refreshes the page, which would otherwise wipe the draft and open panels.
 */
export function NewChat(props: Omit<ComponentProps<typeof Chat>, "conversationId" | "isNew" | "initialRows" | "initialLeafId">) {
  const pathname = usePathname();
  const [prevPath, setPrevPath] = useState(pathname);
  const [nonce, setNonce] = useState(0);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    if (pathname === "/") setNonce((n) => n + 1);
  }
  const key = `${props.target?.kind ?? "none"}:${props.target?.id ?? ""}:${nonce}`;
  return <Chat key={key} isNew initialRows={[]} initialLeafId={null} {...props} />;
}
