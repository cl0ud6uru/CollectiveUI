"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { continueSharedConversation } from "@/app/(chat)/actions";
import type { PortalUIMessage } from "@/lib/chat/store";
import { Button } from "@/components/ui/button";
import { AssistantMessage, UserMessage } from "./message";

export function SharedView({
  token,
  title,
  author,
  createdAt,
  messages,
  appName,
}: {
  token: string;
  title: string;
  author: string;
  createdAt: string;
  messages: PortalUIMessage[];
  appName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const noop = () => {};
  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between bg-bg/90 px-4 backdrop-blur">
        <Link href="/" className="font-semibold">{appName}</Link>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const id = await continueSharedConversation(token);
            router.push(`/c/${id}`);
          }}
        >
          Continue this conversation
        </Button>
      </header>
      <div className="mx-auto max-w-3xl px-4 pb-24">
        <div className="border-b border-border py-8">
          <h1 className="text-3xl font-semibold">{title}</h1>
          <p className="mt-2 text-sm text-muted">
            Shared by {author} · {new Date(createdAt).toLocaleDateString()}
          </p>
        </div>
        <div className="space-y-6 pt-8">
          {messages.map((m) =>
            m.role === "user" ? (
              <UserMessage key={m.id} message={m} readOnly />
            ) : (
              <AssistantMessage key={m.id} message={m} streaming={false} isLast={false} readOnly onApprove={noop} onDeny={noop} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
