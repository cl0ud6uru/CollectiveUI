"use client";

import { Switch as S } from "radix-ui";
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  name,
  defaultChecked,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  "aria-label"?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (v: boolean) => void;
  name?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <S.Root
      name={name}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      value="true"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-hover transition-colors data-[state=checked]:bg-accent disabled:opacity-50",
        className,
      )}
    >
      <S.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-fg" />
    </S.Root>
  );
}
