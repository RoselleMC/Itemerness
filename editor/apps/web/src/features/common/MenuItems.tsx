import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import { runMenuAction, type MenuAction } from "../../state/interface.js";

export function MenuItems({ items }: { items: MenuAction[] }) {
    return items.map((item) => <MenuEntry key={item.id} item={item} />);
}
function MenuEntry({ item }: { item: MenuAction }) {
    const Icon = item.icon;
    const label = (
        <>
            <span className="ui-menu-icon">{Icon && <Icon size={16} />}</span>
            <span className="ui-menu-text">{item.label}</span>
            {item.shortcut && (
                <span className="ui-menu-shortcut">{item.shortcut}</span>
            )}
        </>
    );
    const properties = {
        className: `ui-menu-item ${item.danger ? "ui-danger" : ""}`,
        disabled: item.disabled,
        "data-testid": `menu-${item.id}`,
    };
    return (
        <>
            {item.separator && <Menu.Separator className="ui-separator" />}
            {item.children ? (
                <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger {...properties}>
                        {label}
                        <ChevronRight size={14} />
                    </Menu.SubmenuTrigger>
                    <Menu.Portal>
                        <Menu.Positioner
                            className="ui-positioner"
                            sideOffset={3}
                            collisionPadding={{
                                top: 8,
                                left: 8,
                                right: 8,
                                bottom: 8,
                            }}
                        >
                            <Menu.Popup
                                className="ui-popup"
                                data-ui-popup
                                aria-label={item.label}
                            >
                                <MenuItems items={item.children} />
                            </Menu.Popup>
                        </Menu.Positioner>
                    </Menu.Portal>
                </Menu.SubmenuRoot>
            ) : item.checked !== undefined ? (
                <Menu.CheckboxItem
                    {...properties}
                    checked={item.checked}
                    closeOnClick
                    onClick={() => runMenuAction(item)}
                >
                    {label}
                    <Menu.CheckboxItemIndicator className="ui-menu-check">
                        <Check size={15} />
                    </Menu.CheckboxItemIndicator>
                </Menu.CheckboxItem>
            ) : (
                <Menu.Item {...properties} onClick={() => runMenuAction(item)}>
                    {label}
                </Menu.Item>
            )}
        </>
    );
}
