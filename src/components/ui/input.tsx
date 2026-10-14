"use client";

import { Children, Fragment, cloneElement, forwardRef, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Select } from "./select";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-10 w-full rounded-lg border border-border bg-transparent px-3 text-sm outline-none placeholder:text-subtle focus:border-fg/40",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-subtle focus:border-fg/40",
          className,
        )}
        {...props}
      />
    );
  },
);

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-sm font-medium", className)} {...props} />;
}

type FieldControlProps = {
  id?: string;
  type?: string;
  children?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
};

// Inspect layout wrappers, but leave opaque custom controls and nested fields alone.
// Custom controls retain their own names inside the field's accessible group.
function mapFieldControls(children: ReactNode, map: (control: ReactElement<FieldControlProps>) => ReactNode): ReactNode {
  return Children.map(children, child => {
    if (!isValidElement<FieldControlProps>(child)) return child;
    const { type, props } = child;
    if (type === Input || type === Textarea || type === Select || type === "textarea" || type === "select" || (type === "input" && props.type !== "hidden")) {
      return map(child);
    }
    if ((typeof type === "string" || type === Fragment) && props.children && type !== "label") {
      return cloneElement(child, {}, mapFieldControls(props.children, map));
    }
    return child;
  });
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const fieldId = useId();
  const labelId = `${fieldId}-label`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const controls: ReactElement<FieldControlProps>[] = [];
  mapFieldControls(children, control => { controls.push(control); return control; });
  let index = 0;
  const content = mapFieldControls(children, control => {
    const props = control.props;
    const id = props.id ?? `${fieldId}-control-${index}`;
    index++;
    return cloneElement(control, {
      id,
      // A single control is named by its native label. Multiple controls share
      // the group label unless they already supply a more specific name.
      "aria-labelledby": props["aria-labelledby"] ?? (controls.length > 1 && !props["aria-label"] ? labelId : undefined),
      "aria-describedby": [props["aria-describedby"], hintId].filter(Boolean).join(" ") || undefined,
    });
  });
  const description = hint && <p id={hintId} className="text-xs text-muted">{hint}</p>;
  if (controls.length !== 1) {
    return (
      <fieldset className="min-w-0 space-y-1" aria-describedby={hintId}>
        <legend id={labelId} className="mb-1.5 text-sm font-medium">{label}</legend>
        {content}
        {description}
      </fieldset>
    );
  }
  return (
    <div className="space-y-1">
      <Label id={labelId} htmlFor={controls[0].props.id ?? `${fieldId}-control-0`}>{label}</Label>
      {content}
      {description}
    </div>
  );
}

export { Select };
