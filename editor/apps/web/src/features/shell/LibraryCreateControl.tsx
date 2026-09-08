import { useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEditorStore, type EditorMode } from "../../state/store.js";
import { runMenuAction, type MenuAction } from "../../state/interface.js";
import { newItemAction } from "../common/contextActions.js";
import { addSchema } from "../common/dataLibraryActions.js";
import { addPresentationAction } from "../common/presentationLibraryActions.js";
import { createThemeLayoutActions } from "../common/themeLayoutActions.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { MenuItems } from "../common/MenuItems.js";

export function LibraryCreateControl({
    mode,
    active,
}: {
    mode: EditorMode;
    active: boolean;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const epoch = useEditorStore((state) => state.workspaceEpoch);
    useEditorStore((state) => state.document);
    useEffect(() => setOpen(false), [mode, active, epoch]);
    const actions: MenuAction[] =
        mode === "items"
            ? [{ ...newItemAction(t), id: "add-item" }]
            : mode === "themes" || mode === "layouts"
              ? createThemeLayoutActions(mode, t)
              : mode === "data"
                ? [
                      {
                          id: "add-data-schema",
                          label: t("dataLibrary.addSchema"),
                          run: () => addSchema(),
                      },
                  ]
                : [addPresentationAction(mode, t)];
    const label =
        mode === "layouts"
            ? t("themeLayoutLibrary.add.layout")
            : actions[0]!.label;
    const props = {
        className: "icon-button library-create",
        "aria-label": label,
        "data-tooltip": label,
        "data-testid": actions.length === 1 ? actions[0]!.id : "add-layout",
        disabled: !active || actions.every((action) => action.disabled),
    };
    if (actions.length === 1)
        return (
            <button
                type="button"
                {...props}
                onClick={() => runMenuAction(actions[0]!)}
            >
                <Plus size={16} aria-hidden="true" />
            </button>
        );
    return (
        <Menu.Root
            modal={false}
            open={open && active}
            onOpenChange={(value) => {
                if (!value || commitInlineEditor()) setOpen(value);
            }}
        >
            <Menu.Trigger {...props}>
                <Plus size={16} aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
                <Menu.Positioner
                    className="ui-positioner"
                    align="end"
                    sideOffset={5}
                    collisionPadding={8}
                >
                    <Menu.Popup
                        className="ui-popup"
                        data-ui-popup
                        aria-label={label}
                    >
                        <MenuItems items={actions} />
                    </Menu.Popup>
                </Menu.Positioner>
            </Menu.Portal>
        </Menu.Root>
    );
}
