"use client";

import { Tooltip as T } from "radix-ui";

export function Tip({
  label,
  children,
  side = "bottom",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[60] rounded-lg bg-black px-2 py-1 text-xs font-medium text-white shadow dark:bg-white dark:text-black"
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
