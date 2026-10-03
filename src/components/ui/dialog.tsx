"use client";

import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  hideClose,
  onCloseAutoFocus,
  onPointerDownOutside,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  hideClose?: boolean;
  onCloseAutoFocus?: React.ComponentProps<typeof D.Content>["onCloseAutoFocus"];
  onPointerDownOutside?: React.ComponentProps<typeof D.Content>["onPointerDownOutside"];
}) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in" />
      <D.Content
        onCloseAutoFocus={onCloseAutoFocus}
        onPointerDownOutside={onPointerDownOutside}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-dialog p-6 shadow-2xl outline-none",
          className,
        )}
      >
        {title ? <D.Title className="text-lg font-semibold">{title}</D.Title> : <D.Title className="sr-only">Dialog</D.Title>}
        {description ? (
          <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>
        ) : (
          <D.Description className="sr-only">Dialog</D.Description>
        )}
        <div className={title ? "mt-4" : ""}>{children}</div>
        {!hideClose && (
          <D.Close className="absolute right-4 top-4 rounded-lg p-1.5 text-muted hover:bg-hover" aria-label="Close">
            <X className="h-5 w-5" />
          </D.Close>
        )}
      </D.Content>
    </D.Portal>
  );
}
