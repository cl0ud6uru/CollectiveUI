"use client";

import { DropdownMenu as M } from "radix-ui";
import { cn } from "@/lib/utils";

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuSub = M.Sub;

export function MenuContent({
  children,
  className,
  align = "start",
  side,
  sideOffset = 6,
}: {
  children: React.ReactNode;
  className?: string;
  align?: "start" | "end" | "center";
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
}) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-[200px] rounded-2xl border border-border bg-popover p-1.5 text-sm shadow-lg",
          className,
        )}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {children}
      </M.Content>
    </M.Portal>
  );
}

export function MenuItem({
  className,
  danger,
  ...props
}: React.ComponentProps<typeof M.Item> & { danger?: boolean }) {
  return (
    <M.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-50 [&_svg]:h-4 [&_svg]:w-4",
        danger && "text-danger",
        className,
      )}
      {...props}
    />
  );
}

export function MenuSeparator() {
  return <M.Separator className="mx-2 my-1 h-px bg-border" />;
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <M.Label className="px-2.5 py-1.5 text-xs text-subtle">{children}</M.Label>;
}

export function MenuSubTrigger({ className, ...props }: React.ComponentProps<typeof M.SubTrigger>) {
  return (
    <M.SubTrigger
      className={cn(
        "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-hover data-[state=open]:bg-hover [&_svg]:h-4 [&_svg]:w-4",
        className,
      )}
      {...props}
    />
  );
}

export function MenuSubContent({ children }: { children: React.ReactNode }) {
  return (
    <M.Portal>
      <M.SubContent
        sideOffset={6}
        className="z-50 min-w-[180px] rounded-2xl border border-border bg-popover p-1.5 text-sm shadow-lg"
      >
        {children}
      </M.SubContent>
    </M.Portal>
  );
}
