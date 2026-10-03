import { forwardRef } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "icon" | "icon-sm";

const variants: Record<Variant, string> = {
  primary: "bg-fg text-bg hover:opacity-85",
  secondary: "bg-surface-2 text-fg hover:bg-hover",
  ghost: "text-fg hover:bg-hover",
  outline: "border border-border text-fg hover:bg-hover",
  danger: "bg-danger text-white hover:opacity-90",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm rounded-full",
  md: "h-10 px-4 text-sm rounded-full",
  icon: "h-9 w-9 rounded-lg",
  "icon-sm": "h-8 w-8 rounded-lg",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});
