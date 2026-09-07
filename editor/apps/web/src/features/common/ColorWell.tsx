import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { HexColorPicker } from "react-colorful";
import { NAMED_COLORS } from "@itemerness/mc-render";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { useEditorStore } from "../../state/store.js";
import { describeContext, useInterface } from "../../state/interface.js";
import { copyAction } from "./contextActions.js";

export function ColorWell({
    value,
    label,
    id,
    owner,
    onValueChange,
    onClear,
}: {
    value: string;
    label: string;
    id: string;
    owner: string;
    onValueChange: (value: string) => void;
    onClear: () => void;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(value);
    const closeSignal = useInterface((state) => state.closePopups);
    useEffect(() => setDraft(value), [value]);
    useEffect(() => setOpen(false), [owner, closeSignal]);
    return (
        <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
            <Popover.Trigger
                className="color-well"
                data-testid={id}
                data-color={value}
                aria-label={label}
                data-tooltip={label}
                style={{ backgroundColor: value }}
                onContextMenu={(event) =>
                    describeContext(event, {
                        label,
                        items: [
                            copyAction(
                                "copy-color",
                                t("menus.copyValue"),
                                value,
                            ),
                            {
                                id: "clear-color",
                                label: t("menus.clearOverride"),
                                icon: RotateCcw,
                                run: onClear,
                            },
                        ],
                    })
                }
            />
            <Popover.Portal>
                <Popover.Positioner
                    className="ui-positioner"
                    sideOffset={6}
                    collisionPadding={{ top: 56, right: 8, bottom: 8, left: 8 }}
                >
                    <Popover.Popup
                        className="ui-popup ui-color-popup ui-document-popup"
                        data-ui-popup
                        aria-label={label}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") event.stopPropagation();
                        }}
                    >
                        <HexColorPicker
                            color={value}
                            onChange={onValueChange}
                            onPointerDown={() =>
                                useEditorStore
                                    .getState()
                                    .setEditGroup(`color:${owner}`)
                            }
                            onPointerUp={() =>
                                useEditorStore.getState().setEditGroup(null)
                            }
                        />
                        <div className="color-palette">
                            {[...NAMED_COLORS].map(([name, color]) => (
                                <button
                                    type="button"
                                    key={name}
                                    aria-label={name}
                                    data-tooltip={name}
                                    style={{
                                        backgroundColor: `#${color.toString(16).padStart(6, "0")}`,
                                    }}
                                    onClick={() => {
                                        useEditorStore
                                            .getState()
                                            .setEditGroup(null);
                                        onValueChange(
                                            `#${color.toString(16).padStart(6, "0")}`,
                                        );
                                    }}
                                />
                            ))}
                        </div>
                        <label className="color-hex-label">
                            {t("menus.hexColor")}
                            <input
                                data-testid={`${id}-hex`}
                                value={draft}
                                aria-invalid={!/^#[\da-f]{6}$/i.test(draft)}
                                spellCheck={false}
                                onChange={(event) => {
                                    const next = event.target.value;
                                    setDraft(next);
                                    if (/^#[\da-f]{6}$/i.test(next))
                                        onValueChange(next.toLowerCase());
                                }}
                                onBlur={() => setDraft(value)}
                            />
                        </label>
                        <button
                            type="button"
                            className="ui-menu-item"
                            onClick={() => {
                                onClear();
                                setOpen(false);
                            }}
                        >
                            <RotateCcw size={15} />
                            {t("menus.clearOverride")}
                        </button>
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
}
