"use client";

import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Select as S } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Radix reserves "" for "no value"; native selects use it for "none/default" options.
const EMPTY = "__empty__";
const toRadix = (v: string) => (v === "" ? EMPTY : v);
const fromRadix = (v: string) => (v === EMPTY ? "" : v);

type Option = { value: string; label: ReactNode; disabled?: boolean };
type Entry = Option | { group: ReactNode; options: Option[] };

function collectOptions(children: ReactNode, out: Entry[] = []): Entry[] {
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value?: unknown; children?: ReactNode; disabled?: boolean; label?: ReactNode }>(child)) return;
    if (child.type === Fragment) collectOptions(child.props.children, out);
    else if (child.type === "option") out.push({ value: String(child.props.value ?? ""), label: child.props.children, disabled: child.props.disabled });
    else if (child.type === "optgroup") {
      const options = collectOptions(child.props.children).filter((e): e is Option => "value" in e)
        .map(option => ({ ...option, disabled: child.props.disabled || option.disabled }));
      if (options.length) out.push({ group: child.props.label, options });
    }
  });
  return out;
}

export type SelectChangeEvent = { target: { value: string }; currentTarget: { value: string } };

/**
 * A styled dropdown with the native `<select>` API (`value`, `onChange(e.target.value)`, `<option>`/`<optgroup>` children), so forms
 * look like the rest of the app instead of the OS. Items carry `data-value` for tests.
 */
export function Select({
  value,
  defaultValue,
  onChange,
  children,
  className,
  disabled,
  id,
  name,
  required,
  placeholder,
  ...aria
}: {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (e: SelectChangeEvent) => void;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  required?: boolean;
  placeholder?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  const entries = collectOptions(children);
  const item = (o: Option) => (
    <S.Item
      key={o.value}
      value={toRadix(o.value)}
      disabled={o.disabled}
      data-value={o.value}
      className="relative flex cursor-pointer select-none items-center gap-2 rounded-lg py-2 pl-2.5 pr-8 outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-hover data-[disabled]:opacity-50"
    >
      <S.ItemText>{o.label}</S.ItemText>
      <S.ItemIndicator className="absolute right-2.5">
        <Check className="h-4 w-4" />
      </S.ItemIndicator>
    </S.Item>
  );
  return (
    <S.Root
      value={value === undefined ? undefined : toRadix(String(value))}
      defaultValue={defaultValue === undefined ? undefined : toRadix(String(defaultValue))}
      onValueChange={(v) => {
        const next = fromRadix(v);
        onChange?.({ target: { value: next }, currentTarget: { value: next } });
      }}
      disabled={disabled}
      name={name}
      required={required}
    >
      <S.Trigger
        id={id}
        {...aria}
        className={cn(
          "flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-transparent px-3 text-left text-sm outline-none hover:bg-hover focus-visible:border-fg/40 disabled:opacity-50 data-[placeholder]:text-subtle data-[state=open]:border-fg/40",
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon asChild>
          <ChevronDown className="h-4 w-4 shrink-0 text-subtle" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className="z-[60] max-h-[min(var(--radix-select-content-available-height),320px)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-2xl border border-border bg-popover p-1.5 text-sm shadow-lg"
        >
          <S.Viewport>
            {entries.map((e, i) =>
              "group" in e ? (
                <S.Group key={`group:${i}`}>
                  <S.Label className="px-2.5 pb-1 pt-2 text-xs font-medium text-subtle">{e.group}</S.Label>
                  {e.options.map(item)}
                </S.Group>
              ) : (
                item(e)
              ),
            )}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
