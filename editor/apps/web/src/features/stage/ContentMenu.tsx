import { itemKey } from "@itemerness/protocol";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import {
    ListTree,
    ArrowUpToLine,
    ArrowDownToLine,
    Plus,
    ArrowLeft,
} from "lucide-react";
import type { PresentationBlock } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import type {
    ContentBranch,
    ContentInsertionTarget,
} from "../../state/blocks.js";
import { resolveMessage } from "../common/messages.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { describeContext, runMenuAction } from "../../state/interface.js";
import { contentActions, insertActions } from "../common/contextActions.js";

export function ContentMenu({
    outlineOnly = false,
    anchorUuid,
    position = "after",
}: {
    outlineOnly?: boolean;
    anchorUuid?: string;
    position?: "before" | "after";
}) {
    const { t } = useTranslation();
    const state = useEditorStore();
    const [open, setOpen] = useState(false);
    const [branchTarget, setBranchTarget] = useState<Exclude<
        ContentInsertionTarget,
        string
    > | null>(null);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLDivElement>(null);
    const [popupPosition, setPopupPosition] = useState({ left: 0, top: 0 });
    useLayoutEffect(() => {
        if (!open) return;
        const update = () => {
            const rect = trigger.current?.getBoundingClientRect();
            const menu = popup.current;
            if (!rect || !menu) return;
            setPopupPosition({
                left: Math.max(
                    8,
                    Math.min(
                        rect.left,
                        window.innerWidth - menu.offsetWidth - 8,
                    ),
                ),
                top: Math.max(
                    56,
                    Math.min(
                        rect.bottom + 6,
                        window.innerHeight - menu.offsetHeight - 8,
                    ),
                ),
            });
        };
        update();
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        return () => {
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
        };
    }, [open, branchTarget]);
    const item = state.document.items.find(
        (entry) =>
            itemKey(state.document, entry) === state.selectedItemId,
    );
    const close = () => {
        setOpen(false);
        setBranchTarget(null);
        trigger.current?.focus();
    };
    useEffect(() => {
        setOpen(false);
        setBranchTarget(null);
    }, [
        state.workspaceEpoch,
        state.selectedItemId,
        state.mode,
        state.snapshotHash,
    ]);
    useEffect(() => {
        if (!open) return;
        popup.current
            ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
            ?.focus();
        const dismiss = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                !root.current?.contains(event.target) &&
                !popup.current?.contains(event.target)
            )
                setOpen(false);
        };
        document.addEventListener("pointerdown", dismiss, true);
        return () => document.removeEventListener("pointerdown", dismiss, true);
    }, [open, branchTarget]);
    if (!item) return null;

    const branchName = (branch: ContentBranch) =>
        t(
            `inspector.content.${branch === "thenBlocks" ? "then" : "otherwise"}`,
        );
    const insertionTarget = branchTarget ?? anchorUuid;
    const additions = insertionTarget
        ? insertActions(insertionTarget, position, t)
        : [];
    const outline = (
        blocks: readonly PresentationBlock[],
        depth = 0,
    ): ReactNode =>
        blocks.map((block) => {
            const key =
                block.type === "field"
                    ? block.labelMessage
                    : block.type === "description"
                      ? block.message
                      : null;
            const label = key
                ? resolveMessage(state.document, state.viewerLocale, key).text
                : t(
                      `inspector.content.${block.type === "conditional" ? "conditional" : block.type === "repeat" ? "repeat" : block.type === "text" ? "value" : "nested"}`,
                  );
            return (
                <div key={block.uuid}>
                    <button
                        type="button"
                        role="menuitem"
                        className="content-outline-row"
                        style={{ paddingLeft: 10 + Math.min(depth, 4) * 12 }}
                        data-testid={`select-content-${block.uuid}`}
                        onContextMenu={(event) => {
                            if (!commitInlineEditor()) {
                                event.preventDefault();
                                return;
                            }
                            describeContext(event, {
                                label,
                                items: contentActions(block.uuid, t),
                                allowPopup: true,
                            });
                        }}
                        onClick={() => {
                            if (!commitInlineEditor()) return;
                            state.selectBlock(block.uuid);
                            close();
                        }}
                    >
                        {label}
                    </button>
                    {block.type === "conditional" &&
                        (["thenBlocks", "otherwiseBlocks"] as const).map(
                            (branch) => (
                                <div key={branch}>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="content-outline-row"
                                        style={{
                                            paddingLeft:
                                                10 +
                                                Math.min(depth + 1, 4) * 12,
                                        }}
                                        aria-label={t(
                                            "inspector.content.addToBranch",
                                            { branch: branchName(branch) },
                                        )}
                                        data-testid={`add-branch-${block.uuid}-${branch}`}
                                        onClick={() =>
                                            setBranchTarget({
                                                parentUuid: block.uuid,
                                                branch,
                                            })
                                        }
                                    >
                                        <Plus size={14} />
                                        {branchName(branch)}
                                        <span className="dim small">
                                            {block[branch].length}
                                        </span>
                                    </button>
                                    {outline(block[branch], depth + 2)}
                                </div>
                            ),
                        )}
                </div>
            );
        });
    return (
        <div
            className="content-menu"
            ref={root}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                if (event.key === "Escape" && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (branchTarget) setBranchTarget(null);
                    else close();
                }
                if (
                    !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                        event.key,
                    ) ||
                    !open
                )
                    return;
                const entries = [
                    ...popup.current!.querySelectorAll<HTMLButtonElement>(
                        '[role="menuitem"]:not(:disabled)',
                    ),
                ];
                const index = entries.indexOf(
                    document.activeElement as HTMLButtonElement,
                );
                event.preventDefault();
                entries[
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? entries.length - 1
                          : (index +
                                (event.key === "ArrowDown" ? 1 : -1) +
                                entries.length) %
                            entries.length
                ]?.focus();
            }}
        >
            <button
                type="button"
                className="icon-button"
                data-testid={
                    outlineOnly ? "content-menu" : `insert-${position}`
                }
                ref={trigger}
                data-tooltip={t(
                    outlineOnly
                        ? "stage.outline"
                        : `stage.insert${position === "before" ? "Before" : "After"}`,
                )}
                aria-label={t(
                    outlineOnly
                        ? "stage.outline"
                        : `stage.insert${position === "before" ? "Before" : "After"}`,
                )}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                {outlineOnly ? (
                    <ListTree size={18} />
                ) : position === "before" ? (
                    <ArrowUpToLine size={15} />
                ) : (
                    <ArrowDownToLine size={15} />
                )}
            </button>
            {open &&
                createPortal(
                    <div
                        role="menu"
                        className="content-menu-popup ui-popup"
                        data-ui-popup
                        ref={popup}
                        style={popupPosition}
                        aria-label={t("inspector.content.heading")}
                    >
                        {(!outlineOnly || branchTarget) && (
                            <>
                                {branchTarget && (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => setBranchTarget(null)}
                                        aria-label={t(
                                            "inspector.content.backToOutline",
                                        )}
                                        data-testid="back-to-outline"
                                    >
                                        <ArrowLeft size={16} />
                                        {branchName(branchTarget.branch)}
                                    </button>
                                )}
                                {additions.map((action) => {
                                    const Icon = action.icon;
                                    return (
                                        <button
                                            key={action.id}
                                            type="button"
                                            role="menuitem"
                                            data-testid={`${action.id === "add-condition" ? "add-conditional" : action.id}-row`}
                                            disabled={action.disabled}
                                            onClick={() => {
                                                runMenuAction(action);
                                                close();
                                            }}
                                        >
                                            {Icon && <Icon size={16} />}
                                            {action.label}
                                        </button>
                                    );
                                })}
                            </>
                        )}
                        {outlineOnly && !branchTarget && (
                            <div className="content-outline">
                                <button
                                    type="button"
                                    role="menuitem"
                                    data-testid="select-content-name"
                                    onClick={() => {
                                        if (!commitInlineEditor()) return;
                                        state.selectBlock("__name");
                                        close();
                                    }}
                                >
                                    {
                                        resolveMessage(
                                            state.document,
                                            state.viewerLocale,
                                            item.presentation.nameMessage,
                                        ).text
                                    }
                                </button>
                                {outline(item.presentation.blocks)}
                            </div>
                        )}
                    </div>,
                    document.body,
                )}
        </div>
    );
}
