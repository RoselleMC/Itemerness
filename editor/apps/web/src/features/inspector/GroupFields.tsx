import { useTranslation } from "react-i18next";
import {
    MAXIMUM_GROUP_GAP_LINES,
    type FieldSeparator,
    type GroupDividers,
    type GroupEmptyPolicy,
    type GroupHeaderMissingPolicy,
    type GroupMarker,
    type ItemNode,
    type MarkerPiece,
    type PresentationBlock,
    type ProjectDocument,
    type ThemeMarkers,
    type ThemeNode,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { setGroupHeader } from "../../state/contentActions.js";
import { SelectField } from "../common/SelectField.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { resolveMessage } from "../common/messages.js";

type GroupBlock = Extract<PresentationBlock, { type: "group" }>;

/** The shared message behind the explicit "Colon" choice, so every field reuses one key. */
export const COLON_SEPARATOR_MESSAGE = "separator.colon";

const MARKERS: readonly GroupMarker[] = ["NONE", "BULLET", "TREE"];

/** Writes a document-level message only where it is missing, so authored text is never replaced. */
function withDefaultMessage(
    document: ProjectDocument,
    key: string,
    text: string,
): ProjectDocument {
    return {
        ...document,
        locales: document.locales.map((locale) =>
            locale.locale === document.defaultLocale &&
            !Object.hasOwn(locale.messages, key)
                ? { ...locale, messages: { ...locale.messages, [key]: text } }
                : locale,
        ),
    };
}

/** The message text of one key in the previewed language, edited in place like content labels. */
function MessageText({
    messageKey,
    label,
    testId,
}: {
    messageKey: string;
    label: string;
    testId: string;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const resolved = resolveMessage(
        store.document,
        store.viewerLocale,
        messageKey,
    );
    return (
        <label className="field-inline">
            <span>{label}</span>
            <span className="block-message">
                <input
                    value={resolved.source === "own" ? resolved.text : ""}
                    placeholder={
                        resolved.source === "own" ? undefined : resolved.text
                    }
                    aria-label={label}
                    data-testid={testId}
                    onChange={(event) =>
                        store.setMessage(
                            store.viewerLocale,
                            messageKey,
                            event.target.value,
                        )
                    }
                />
                {resolved.source !== "own" && resolved.source !== "missing" ? (
                    <span className="inherit-hint">
                        {t("inspector.name.inherited", {
                            locale: resolved.sourceLocale,
                        })}
                    </span>
                ) : null}
            </span>
        </label>
    );
}

/**
 * The run between a field label and its value. Blocks may inherit the layout; a layout's own
 * default is the original colon, which needs no message.
 */
export function SeparatorField({
    value,
    inheritable,
    testId,
    apply,
}: {
    value: FieldSeparator | undefined;
    inheritable: boolean;
    testId: string;
    apply(
        document: ProjectDocument,
        separator: FieldSeparator | undefined,
    ): ProjectDocument;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const current =
        value === undefined
            ? inheritable
                ? "inherit"
                : "colon"
            : value.kind === "none"
              ? "none"
              : value.message === COLON_SEPARATOR_MESSAGE
                ? "colon"
                : "message";
    const choose = (choice: string) => {
        if (choice === current) return;
        const transaction = store.beginTransaction();
        store.updateDocument((document) => {
            if (choice === "inherit") return apply(document, undefined);
            if (choice === "none") return apply(document, { kind: "none" });
            if (choice === "colon")
                return inheritable
                    ? apply(
                          withDefaultMessage(
                              document,
                              COLON_SEPARATOR_MESSAGE,
                              ": ",
                          ),
                          { kind: "message", message: COLON_SEPARATOR_MESSAGE },
                      )
                    : apply(document, undefined);
            const message = `separator.${crypto.randomUUID()}`;
            return apply(withDefaultMessage(document, message, ": "), {
                kind: "message",
                message,
            });
        });
        store.commitTransaction(transaction);
    };
    return (
        <>
            <label className="field-inline">
                <span>{t("inspector.content.separator")}</span>
                <SelectField
                    label={t("inspector.content.separator")}
                    value={current}
                    data-testid={testId}
                    onValueChange={choose}
                    options={[
                        ...(inheritable
                            ? [
                                  {
                                      value: "inherit",
                                      label: t(
                                          "inspector.content.separatorOptions.inherit",
                                      ),
                                  },
                              ]
                            : []),
                        {
                            value: "colon",
                            label: t(
                                "inspector.content.separatorOptions.colon",
                            ),
                        },
                        {
                            value: "none",
                            label: t("inspector.content.separatorOptions.none"),
                        },
                        {
                            value: "message",
                            label: t(
                                "inspector.content.separatorOptions.message",
                            ),
                        },
                    ]}
                />
            </label>
            {value?.kind === "message" &&
                value.message !== COLON_SEPARATOR_MESSAGE && (
                    <MessageText
                        messageKey={value.message}
                        label={t("inspector.content.separatorText")}
                        testId={`${testId}-text`}
                    />
                )}
        </>
    );
}

/** Replaces one optional key, deleting it when it returns to its default. */
function withOption<T extends object, K extends string, V>(
    target: T,
    key: K,
    value: V,
    fallback: V,
): T {
    const next = { ...target } as Record<string, unknown>;
    if (value === fallback) delete next[key];
    else next[key] = value;
    return next as T;
}

/**
 * Group settings. The marker and header are primary; the rest describes edge cases and stays in
 * a collapsed disclosure like other secondary settings.
 */
export function GroupFields({
    block,
    onReplace,
}: {
    block: GroupBlock;
    onReplace(next: PresentationBlock): void;
}) {
    const { t } = useTranslation();
    const option = <K extends string, V>(key: K, value: V, fallback: V) =>
        onReplace(withOption(block, key, value, fallback));
    return (
        <div className="block-detail group-fields">
            <label>
                {t("inspector.content.marker")}
                <SelectField
                    label={t("inspector.content.marker")}
                    value={block.marker ?? "NONE"}
                    data-testid="group-marker"
                    onValueChange={(value) =>
                        option("marker", value as GroupMarker, "NONE")
                    }
                    options={MARKERS.map((marker) => ({
                        value: marker,
                        label: t(`inspector.content.markers.${marker}`),
                    }))}
                />
            </label>
            <label>
                {t("inspector.content.groupHeader")}
                <SelectField
                    label={t("inspector.content.groupHeader")}
                    value={block.header?.type ?? ""}
                    data-testid="group-header"
                    onValueChange={(value) =>
                        setGroupHeader(
                            block.uuid,
                            value === "field" || value === "text"
                                ? value
                                : null,
                        )
                    }
                    options={[
                        { value: "", label: t("inspector.none") },
                        {
                            value: "field",
                            label: t("inspector.content.addField"),
                        },
                        {
                            value: "text",
                            label: t("inspector.content.addValue"),
                        },
                    ]}
                />
            </label>
            <details className="advanced" data-testid="group-options">
                <summary>{t("inspector.content.groupOptions")}</summary>
                <label className="field-inline">
                    <span>{t("inspector.content.dividers")}</span>
                    <SelectField
                        label={t("inspector.content.dividers")}
                        value={block.dividers ?? "NONE"}
                        data-testid="group-dividers"
                        onValueChange={(value) =>
                            option("dividers", value as GroupDividers, "NONE")
                        }
                        options={(["NONE", "BETWEEN_CHILDREN"] as const).map(
                            (value) => ({
                                value,
                                label: t(
                                    `inspector.content.dividerOptions.${value}`,
                                ),
                            }),
                        )}
                    />
                </label>
                <label className="field-inline">
                    <span>{t("inspector.content.whenHeaderMissing")}</span>
                    <SelectField
                        label={t("inspector.content.whenHeaderMissing")}
                        value={block.whenHeaderMissing ?? "HIDE"}
                        data-testid="group-when-header-missing"
                        onValueChange={(value) =>
                            option(
                                "whenHeaderMissing",
                                value as GroupHeaderMissingPolicy,
                                "HIDE",
                            )
                        }
                        options={(["HIDE", "SHOW_CHILDREN"] as const).map(
                            (value) => ({
                                value,
                                label: t(
                                    `inspector.content.headerMissingOptions.${value}`,
                                ),
                            }),
                        )}
                    />
                </label>
                <label className="field-inline">
                    <span>{t("inspector.content.whenEmpty")}</span>
                    <SelectField
                        label={t("inspector.content.whenEmpty")}
                        value={block.whenEmpty ?? "SHOW_HEADER"}
                        data-testid="group-when-empty"
                        onValueChange={(value) =>
                            option(
                                "whenEmpty",
                                value as GroupEmptyPolicy,
                                "SHOW_HEADER",
                            )
                        }
                        options={(["SHOW_HEADER", "HIDE"] as const).map(
                            (value) => ({
                                value,
                                label: t(
                                    `inspector.content.emptyOptions.${value}`,
                                ),
                            }),
                        )}
                    />
                </label>
                <label className="field-inline">
                    <span>{t("inspector.content.gapBeforeLines")}</span>
                    <BufferedInput
                        label={t("inspector.content.gapBeforeLines")}
                        value={String(block.gapBeforeLines ?? 0)}
                        owner={`${block.uuid}:gap-before-lines`}
                        inputMode="numeric"
                        testId="group-gap-before-lines"
                        validate={(raw) =>
                            /^\d+$/.test(raw) &&
                            Number(raw) <= MAXIMUM_GROUP_GAP_LINES
                                ? null
                                : t("inspector.content.gapBeforeLinesRange", {
                                      maximum: MAXIMUM_GROUP_GAP_LINES,
                                  })
                        }
                        onCommit={(raw) =>
                            option("gapBeforeLines", Number(raw), 0)
                        }
                    />
                </label>
            </details>
        </div>
    );
}

/** The implicit root group's decoration, kept with other rarely changed item settings. */
export function RootGroupFields({ item }: { item: ItemNode }) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const set = (key: "marker" | "dividers", value: string, fallback: string) =>
        store.updateItem(item.uuid, (current) => ({
            ...current,
            presentation: withOption(
                current.presentation,
                key,
                value,
                fallback,
            ),
        }));
    return (
        <>
            <label className="field-inline">
                <span>{t("inspector.advanced.rootMarker")}</span>
                <SelectField
                    label={t("inspector.advanced.rootMarker")}
                    value={item.presentation.marker ?? "NONE"}
                    data-testid="root-marker"
                    onValueChange={(value) => set("marker", value, "NONE")}
                    options={MARKERS.map((marker) => ({
                        value: marker,
                        label: t(`inspector.content.markers.${marker}`),
                    }))}
                />
            </label>
            <label className="field-inline">
                <span>{t("inspector.advanced.rootDividers")}</span>
                <SelectField
                    label={t("inspector.advanced.rootDividers")}
                    value={item.presentation.dividers ?? "BETWEEN_CHILDREN"}
                    data-testid="root-dividers"
                    onValueChange={(value) =>
                        set("dividers", value, "BETWEEN_CHILDREN")
                    }
                    options={(["NONE", "BETWEEN_CHILDREN"] as const).map(
                        (value) => ({
                            value,
                            label: t(
                                `inspector.content.dividerOptions.${value}`,
                            ),
                        }),
                    )}
                />
            </label>
        </>
    );
}

type MarkerSlot = "bullet" | "branch" | "last" | "vertical";
const MARKER_SLOTS: readonly MarkerSlot[] = [
    "bullet",
    "branch",
    "last",
    "vertical",
];
const DEFAULT_MARKER_TEXT: Record<MarkerSlot, string> = {
    bullet: "• ",
    branch: "├─ ",
    last: "└─ ",
    vertical: "│  ",
};

function markerPiece(
    markers: ThemeMarkers | undefined,
    slot: MarkerSlot,
): MarkerPiece | undefined {
    return slot === "bullet" ? markers?.bullet : markers?.tree?.[slot];
}

/** Drops empty marker objects so a theme without custom art keeps its original shape. */
function withMarkerPiece(
    markers: ThemeMarkers | undefined,
    slot: MarkerSlot,
    piece: MarkerPiece | undefined,
): ThemeMarkers | undefined {
    const next: ThemeMarkers = { ...markers };
    if (slot === "bullet") {
        if (piece) next.bullet = piece;
        else delete next.bullet;
    } else {
        const tree = { ...next.tree };
        if (piece) tree[slot] = piece;
        else delete tree[slot];
        if (Object.keys(tree).length) next.tree = tree;
        else delete next.tree;
    }
    return Object.keys(next).length ? next : undefined;
}

/** Marker art for decorated groups, collapsed because built-in pieces suit most themes. */
export function ThemeMarkerFields({
    theme,
    document,
    update,
}: {
    theme: ThemeNode;
    document: ProjectDocument;
    update(mutate: (current: ThemeNode) => ThemeNode): void;
}) {
    const { t } = useTranslation();
    const setMarkers = (
        mutate: (markers: ThemeMarkers | undefined) => ThemeMarkers | undefined,
    ) =>
        update((current) => {
            const markers = mutate(current.markers);
            const { markers: _previous, ...rest } = current;
            return markers ? { ...rest, markers } : rest;
        });
    const glyphs = document.glyphs.map((glyph) => glyph.id);
    return (
        <details className="advanced" data-testid="theme-markers">
            <summary>{t("inspector.theme.markers")}</summary>
            <label className="field-inline">
                <span>{t("inspector.theme.markerStyle")}</span>
                <SelectField
                    label={t("inspector.theme.markerStyle")}
                    value={theme.markers?.style ?? ""}
                    data-testid="theme-marker-style"
                    onValueChange={(style) =>
                        setMarkers((markers) => {
                            const next: ThemeMarkers = { ...markers };
                            if (style) next.style = style;
                            else delete next.style;
                            return Object.keys(next).length ? next : undefined;
                        })
                    }
                    options={[
                        {
                            value: "",
                            label: t("inspector.theme.markerStyleDefault"),
                        },
                        ...Object.keys(theme.styles).map((role) => ({
                            value: role,
                            label: role,
                        })),
                    ]}
                />
            </label>
            {MARKER_SLOTS.map((slot) => {
                const piece = markerPiece(theme.markers, slot);
                const label = t(`inspector.theme.markerPieces.${slot}`);
                return (
                    <div className="field-inline" key={slot}>
                        <span>{label}</span>
                        <SelectField
                            label={label}
                            value={piece?.kind ?? ""}
                            data-testid={`theme-marker-${slot}`}
                            onValueChange={(kind) =>
                                setMarkers((markers) =>
                                    withMarkerPiece(
                                        markers,
                                        slot,
                                        kind === "text"
                                            ? {
                                                  kind: "text",
                                                  text: DEFAULT_MARKER_TEXT[
                                                      slot
                                                  ],
                                              }
                                            : kind === "glyph" && glyphs[0]
                                              ? {
                                                    kind: "glyph",
                                                    glyph: glyphs[0],
                                                }
                                              : undefined,
                                    ),
                                )
                            }
                            options={[
                                {
                                    value: "",
                                    label: t("inspector.theme.markerDefault", {
                                        text: DEFAULT_MARKER_TEXT[slot],
                                    }),
                                },
                                {
                                    value: "text",
                                    label: t("inspector.theme.markerText"),
                                },
                                // Glyph pieces follow the icon rule: only resource-pack themes.
                                ...(theme.requiresResourcePack
                                    ? [
                                          {
                                              value: "glyph",
                                              label: t(
                                                  "inspector.theme.markerGlyph",
                                              ),
                                              disabled: glyphs.length === 0,
                                          },
                                      ]
                                    : []),
                            ]}
                        />
                        {piece?.kind === "text" && (
                            <BufferedInput
                                label={label}
                                value={piece.text}
                                owner={`${theme.uuid}:marker-${slot}`}
                                testId={`theme-marker-${slot}-text`}
                                validate={(raw) =>
                                    raw.length > 0 && raw.length <= 32
                                        ? null
                                        : t("inspector.theme.markerTextRange")
                                }
                                onCommit={(text) =>
                                    setMarkers((markers) =>
                                        withMarkerPiece(markers, slot, {
                                            kind: "text",
                                            text,
                                        }),
                                    )
                                }
                            />
                        )}
                        {piece?.kind === "glyph" && (
                            <SelectField
                                label={label}
                                value={piece.glyph}
                                data-testid={`theme-marker-${slot}-glyph`}
                                onValueChange={(glyph) =>
                                    setMarkers((markers) =>
                                        withMarkerPiece(markers, slot, {
                                            kind: "glyph",
                                            glyph,
                                        }),
                                    )
                                }
                                options={glyphs.map((glyph) => ({
                                    value: glyph,
                                    label: glyph,
                                }))}
                            />
                        )}
                    </div>
                );
            })}
        </details>
    );
}
