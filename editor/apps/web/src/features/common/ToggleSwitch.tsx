import { Switch } from "@base-ui/react/switch";

export function ToggleSwitch({
    checked,
    onCheckedChange,
    disabled = false,
    label,
}: {
    checked: boolean;
    onCheckedChange(checked: boolean): void;
    disabled?: boolean;
    label: string;
}) {
    return (
        <Switch.Root
            className="toggle-switch"
            nativeButton
            render={<button type="button" />}
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            aria-label={label}
        >
            <Switch.Thumb className="toggle-switch-thumb" />
        </Switch.Root>
    );
}
