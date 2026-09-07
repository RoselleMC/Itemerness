import { useRef, type ComponentProps } from "react";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { describeContext } from "../../state/interface.js";
import { copyAction } from "./contextActions.js";
import { useTranslation } from "react-i18next";

export interface SelectChoice {
    value: string;
    label: string;
    disabled?: boolean;
    group?: string;
}
export function SelectField({
    value,
    onValueChange,
    options,
    label,
    ...props
}: {
    value: string;
    onValueChange: (value: string) => void;
    options: readonly SelectChoice[];
    label: string;
} & Omit<ComponentProps<"button">, "value" | "onChange" | "children">) {
    const trigger = useRef<HTMLButtonElement>(null);
    const { t } = useTranslation();
    const choices: readonly SelectChoice[] = options.some(
        (option) => option.value === value,
    )
        ? options
        : [...options, { value, label: value, disabled: true }];
    const groups = [...new Set(choices.map((option) => option.group ?? ""))];
    return (
        <Select.Root
            value={value}
            items={choices}
            modal={false}
            disabled={props.disabled}
            onValueChange={(next) => {
                if (next !== null) onValueChange(next);
            }}
        >
            <Select.Trigger
                {...props}
                ref={trigger}
                className={`ui-select ${props.className ?? ""}`}
                aria-label={label}
                data-field-value={value}
                data-tooltip={
                    choices.find((option) => option.value === value)?.label
                }
                onContextMenu={(event) =>
                    describeContext(event, {
                        label,
                        items: [
                            copyAction(
                                "copy-value",
                                t("menus.copyValue"),
                                value,
                            ),
                            {
                                id: "choose-value",
                                label: t("menus.chooseValue"),
                                icon: ChevronDown,
                                disabled: props.disabled,
                                run: () => trigger.current?.click(),
                            },
                        ],
                    })
                }
            >
                <Select.Value className="ui-select-value" />
                <Select.Icon>
                    <ChevronDown size={14} />
                </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
                <Select.Positioner
                    className="ui-positioner"
                    sideOffset={5}
                    alignItemWithTrigger={false}
                    collisionPadding={{ top: 56, right: 8, bottom: 8, left: 8 }}
                >
                    <Select.Popup
                        className="ui-popup ui-select-popup"
                        data-ui-popup
                        aria-label={label}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") event.stopPropagation();
                        }}
                    >
                        <Select.List>
                            {groups.map((group) => (
                                <Select.Group key={group}>
                                    {group && (
                                        <Select.GroupLabel className="ui-menu-label">
                                            {group}
                                        </Select.GroupLabel>
                                    )}
                                    {choices
                                        .filter(
                                            (option) =>
                                                (option.group ?? "") === group,
                                        )
                                        .map((option) => (
                                            <Select.Item
                                                key={option.value}
                                                value={option.value}
                                                disabled={option.disabled}
                                                className="ui-option"
                                                data-option-value={option.value}
                                            >
                                                <Select.ItemText>
                                                    {option.label}
                                                </Select.ItemText>
                                                <Select.ItemIndicator className="ui-menu-check">
                                                    <Check size={15} />
                                                </Select.ItemIndicator>
                                            </Select.Item>
                                        ))}
                                </Select.Group>
                            ))}
                        </Select.List>
                    </Select.Popup>
                </Select.Positioner>
            </Select.Portal>
        </Select.Root>
    );
}
