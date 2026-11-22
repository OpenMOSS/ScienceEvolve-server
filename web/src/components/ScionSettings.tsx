import { Children, forwardRef, isValidElement, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function ScionSwitch({ title, description, checked, disabled, label, onChange }: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="scion-setting-row" data-component="switch" data-checked={checked ? "" : undefined}
      data-disabled={disabled ? "" : undefined}>
      <input data-slot="switch-input" type="checkbox" role="switch" aria-label={label} checked={checked}
        disabled={disabled} onChange={event => {
          if (!disabled) onChange(event.target.checked);
        }} />
      <span className="scion-setting-copy">
        <span data-slot="switch-label">{title}</span>
        {description && <small data-slot="switch-description">{description}</small>}
      </span>
      <span data-slot="switch-control" aria-hidden="true"><span data-slot="switch-thumb" /></span>
    </label>
  );
}

export function ScionSelect({ children, ...props }: ComponentPropsWithoutRef<"select">) {
  const option = Children.toArray(children).find(child =>
    isValidElement<ComponentPropsWithoutRef<"option">>(child) && String(child.props.value) === String(props.value ?? ""));
  return (
    <span className="scion-native-select" data-component="select">
      <span aria-hidden="true" data-component="button" data-variant="secondary" data-size="normal" data-slot="select-select-trigger">
        <span data-slot="select-select-trigger-value">{isValidElement<ComponentPropsWithoutRef<"option">>(option) ? option.props.children : props.value}</span>
        <span data-slot="select-select-trigger-icon"><ChevronDown size={14} /></span>
      </span>
      <select {...props}>{children}</select>
    </span>
  );
}

export const ScionInput = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<"input">>(function ScionInput(props, ref) {
  return <span data-component="input" data-variant="normal"><span data-slot="input-wrapper">
    <input {...props} ref={ref} data-slot="input-input" data-invalid={props["aria-invalid"] === true ? "" : undefined} />
  </span></span>;
});

export const ScionTextarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<"textarea">>(function ScionTextarea(props, ref) {
  return <span data-component="input" data-variant="normal"><span data-slot="input-wrapper">
    <textarea {...props} ref={ref} data-slot="input-input" />
  </span></span>;
});
