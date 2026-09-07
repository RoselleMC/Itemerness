import { useRef, type ComponentProps } from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";

export function SuggestionInput({
    value,
    onValueChange,
    suggestions,
    label,
    ...props
}: {
    value: string;
    onValueChange: (value: string) => void;
    suggestions: readonly string[];
    label: string;
} & Omit<ComponentProps<"input">, "value" | "onChange" | "list">) {
    const anchor = useRef<HTMLInputElement>(null);
    return (
        <Autocomplete.Root
            items={suggestions}
            value={value}
            onValueChange={onValueChange}
            openOnInputClick
        >
            <Autocomplete.Input {...props} ref={anchor} aria-label={label} />
            <Autocomplete.Portal>
                <Autocomplete.Positioner
                    anchor={anchor}
                    className="ui-positioner"
                    sideOffset={5}
                    collisionPadding={{ top: 56, left: 8, right: 8, bottom: 8 }}
                >
                    <Autocomplete.Popup
                        className="ui-popup ui-select-popup"
                        data-ui-popup
                        aria-label={label}
                    >
                        <Autocomplete.List>
                            {(option: string) => (
                                <Autocomplete.Item
                                    key={option}
                                    value={option}
                                    className="ui-option"
                                    data-option-value={option}
                                >
                                    {option}
                                </Autocomplete.Item>
                            )}
                        </Autocomplete.List>
                    </Autocomplete.Popup>
                </Autocomplete.Positioner>
            </Autocomplete.Portal>
        </Autocomplete.Root>
    );
}
