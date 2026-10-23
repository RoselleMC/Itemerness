import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import {
    itemLayout,
    itemTheme,
    MAXIMUM_FRAGMENTS_PER_REGION,
    MAXIMUM_HIDING_WEIGHT,
    MAXIMUM_LITERAL_CODE_POINTS,
    MAXIMUM_SLOT_ENTRIES,
    type FieldPartStyles,
    type Fragment,
    type ItemNode,
    type OverflowStrategy,
    type PresentationBlock,
    type ProjectDocument,
    type Summary,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { representativeTheme } from "../../state/themeSelectorLibrary.js";
import { itemSlotIds, SLOT_ID_PATTERN } from "../../state/composition.js";
import { SelectField } from "../common/SelectField.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { humanizePath, resolveMessage } from "../common/messages.js";
import { itemDataKeys } from "../common/typedValues.js";

type FragmentKind = Fragment["kind"];
type PieceKind = Exclude<FragmentKind, "slot" | "data">;

const FRAGMENT_KINDS: readonly FragmentKind[] = [
    "message",
    "data",
    "glyph",
    "literal",
    "slot",
];
const PIECE_KINDS: readonly PieceKind[] = ["literal", "glyph", "message"];

function themeStyles(document: ProjectDocument, item: ItemNode): string[] {
    return Object.keys(
        representativeTheme(document, itemTheme(document, item))?.styles ?? {},
    );
}

function codePoints(text: string): number {
    return [...text].length;
}

/** Keeps a fragment's style and condition when its kind changes. */
function keepCommon(from: Fragment, to: Fragment): Fragment {
    return {
        ...to,
        ...(from.style ? { style: from.style } : {}),
        ...(from.condition ? { condition: from.condition } : {}),
    };
}

/**
 * Creates a fragment of one kind. A message fragment also writes its default text, so both
 * changes are one undo step.
 */
function useFragmentFactory(item: ItemNode) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const doc = store.document;
    const dataKeys = itemDataKeys(doc, item)
        .filter((key) => key.presentationReadable)
        .map((key) => key.id);
    const glyphs = doc.glyphs.map((glyph) => glyph.id);
    const available = (kind: FragmentKind) =>
        kind === "data"
            ? dataKeys.length > 0
            : kind === "glyph"
              ? glyphs.length > 0
              : true;
    const create = (
        kind: FragmentKind,
        apply: (fragment: Fragment) => void,
    ) => {
        if (kind === "message") {
            const message = `item.text.${crypto.randomUUID()}`;
            const transaction = store.beginTransaction();
            store.setMessage(
                doc.defaultLocale,
                message,
                t("inspector.composition.newText"),
            );
            apply({ kind: "message", message });
            store.commitTransaction(transaction);
            return;
        }
        const slots = new Set(itemSlotIds(item));
        let slot = "more";
        for (let index = 2; slots.has(slot); index += 1) slot = `more-${index}`;
        const fragment: Fragment | null =
            kind === "data"
                ? dataKeys[0]
                    ? { kind: "data", data: dataKeys[0] }
                    : null
                : kind === "glyph"
                  ? glyphs[0]
                      ? { kind: "glyph", glyph: glyphs[0] }
                      : null
                  : kind === "literal"
                    ? { kind: "literal", text: "-" }
                    : { kind: "slot", id: slot };
        if (fragment) apply(fragment);
    };
    return { create, available, dataKeys, glyphs };
}

/** The text of one message in the previewed language, typed in place. */
function MessageField({
    messageKey,
    label,
    testId,
}: {
    messageKey: string;
    label: string;
    testId: string;
}) {
    const store = useEditorStore();
    const resolved = resolveMessage(
        store.document,
        store.viewerLocale,
        messageKey,
    );
    return (
        <input
            className="fragment-value"
            value={resolved.source === "own" ? resolved.text : ""}
            placeholder={resolved.source === "own" ? undefined : resolved.text}
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
    );
}

/** The value of one fragment: its message text, data key, glyph, literal text or slot id. */
function FragmentValue({
    item,
    fragment,
    onChange,
    testId,
}: {
    item: ItemNode;
    fragment: Fragment;
    onChange(next: Fragment): void;
    testId: string;
}) {
    const { t } = useTranslation();
    const { dataKeys, glyphs } = useFragmentFactory(item);
    const label = t(`inspector.composition.kinds.${fragment.kind}`);
    switch (fragment.kind) {
        case "message":
            return (
                <MessageField
                    messageKey={fragment.message}
                    label={label}
                    testId={`${testId}-text`}
                />
            );
        case "data":
            return (
                <SelectField
                    label={label}
                    value={fragment.data}
                    data-testid={`${testId}-data`}
                    onValueChange={(data) => onChange({ ...fragment, data })}
                    options={dataKeys.map((key) => ({
                        value: key,
                        label: key.split(":").pop() ?? key,
                    }))}
                />
            );
        case "glyph":
            return (
                <SelectField
                    label={label}
                    value={fragment.glyph}
                    data-testid={`${testId}-glyph`}
                    onValueChange={(glyph) => onChange({ ...fragment, glyph })}
                    options={glyphs.map((glyph) => ({
                        value: glyph,
                        label: glyph,
                    }))}
                />
            );
        case "literal":
            return (
                <BufferedInput
                    label={label}
                    value={fragment.text}
                    owner={`${testId}:literal`}
                    testId={`${testId}-literal`}
                    validate={(raw) =>
                        codePoints(raw) >= 1 &&
                        codePoints(raw) <= MAXIMUM_LITERAL_CODE_POINTS
                            ? null
                            : t("inspector.composition.literalRange", {
                                  maximum: MAXIMUM_LITERAL_CODE_POINTS,
                              })
                    }
                    onCommit={(text) => onChange({ ...fragment, text })}
                />
            );
        case "slot": {
            const taken = new Set(itemSlotIds(item));
            taken.delete(fragment.id);
            return (
                <BufferedInput
                    label={label}
                    value={fragment.id}
                    owner={`${testId}:slot`}
                    testId={`${testId}-slot`}
                    validate={(raw) =>
                        !SLOT_ID_PATTERN.test(raw) || raw.length > 64
                            ? t("inspector.composition.slotIdInvalid")
                            : taken.has(raw)
                              ? t("inspector.composition.slotIdTaken")
                              : null
                    }
                    onCommit={(id) => onChange({ ...fragment, id })}
                />
            );
        }
    }
}

/** One optional static piece: literal text, a glyph or a message. */
function PieceField({
    item,
    piece,
    onChange,
    label,
    testId,
}: {
    item: ItemNode;
    piece: Fragment | undefined;
    onChange(next: Fragment | undefined): void;
    label: string;
    testId: string;
}) {
    const { t } = useTranslation();
    const { create, available } = useFragmentFactory(item);
    return (
        <div className="field-inline fragment-piece">
            <span>{label}</span>
            <SelectField
                label={label}
                value={piece?.kind ?? ""}
                data-testid={`${testId}-kind`}
                onValueChange={(kind) =>
                    kind
                        ? create(kind as PieceKind, (next) =>
                              onChange(piece ? keepCommon(piece, next) : next),
                          )
                        : onChange(undefined)
                }
                options={[
                    { value: "", label: t("inspector.none") },
                    ...PIECE_KINDS.map((kind) => ({
                        value: kind,
                        label: t(`inspector.composition.kinds.${kind}`),
                        disabled: !available(kind),
                    })),
                ]}
            />
            {piece && (
                <FragmentValue
                    item={item}
                    fragment={piece}
                    onChange={onChange}
                    testId={testId}
                />
            )}
        </div>
    );
}

function StyleField({
    item,
    value,
    onChange,
    label,
    defaultLabel,
    testId,
}: {
    item: ItemNode;
    value: string | undefined;
    onChange(style: string | undefined): void;
    label: string;
    defaultLabel: string;
    testId: string;
}) {
    const doc = useEditorStore((state) => state.document);
    return (
        <label className="field-inline">
            <span>{label}</span>
            <SelectField
                label={label}
                value={value ?? ""}
                data-testid={testId}
                onValueChange={(style) => onChange(style || undefined)}
                options={[
                    { value: "", label: defaultLabel },
                    ...themeStyles(doc, item).map((style) => ({
                        value: style,
                        label: humanizePath(style),
                    })),
                ]}
            />
        </label>
    );
}

function withOptional<T extends object, K extends keyof T>(
    value: T,
    key: K,
    next: T[K] | undefined,
): T {
    const { [key]: _previous, ...rest } = value;
    return next === undefined ? (rest as T) : ({ ...rest, [key]: next } as T);
}

/** Settings rarely needed per fragment: style, data format and slot decorations. */
function FragmentOptions({
    item,
    fragment,
    onChange,
    testId,
}: {
    item: ItemNode;
    fragment: Fragment;
    onChange(next: Fragment): void;
    testId: string;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const doc = store.document;
    return (
        <details className="advanced fragment-options">
            <summary>{t("inspector.content.moreOptions")}</summary>
            <StyleField
                item={item}
                value={fragment.style}
                label={t("inspector.content.style")}
                defaultLabel={t("inspector.composition.inheritStyle")}
                testId={`${testId}-style`}
                onChange={(style) =>
                    onChange(withOptional(fragment, "style", style))
                }
            />
            {fragment.kind === "data" && (
                <label className="field-inline">
                    <span>{t("inspector.content.formatLabel")}</span>
                    <SelectField
                        label={t("inspector.content.formatLabel")}
                        value={fragment.format ?? ""}
                        data-testid={`${testId}-format`}
                        onValueChange={(format) =>
                            onChange(
                                withOptional(
                                    fragment,
                                    "format",
                                    format || undefined,
                                ),
                            )
                        }
                        options={[
                            { value: "", label: t("inspector.none") },
                            ...doc.formats.map((format) => ({
                                value: format.id,
                                label: format.id.split(":").pop() ?? format.id,
                            })),
                        ]}
                    />
                </label>
            )}
            {fragment.kind === "slot" && (
                <>
                    {(["prefix", "separator", "suffix"] as const).map(
                        (part) => (
                            <PieceField
                                key={part}
                                item={item}
                                piece={fragment[part]}
                                label={t(`inspector.composition.slot.${part}`)}
                                testId={`${testId}-${part}`}
                                onChange={(piece) =>
                                    onChange(
                                        withOptional(fragment, part, piece),
                                    )
                                }
                            />
                        ),
                    )}
                    <label className="field-inline">
                        <span>{t("inspector.composition.slot.maximum")}</span>
                        <BufferedInput
                            label={t("inspector.composition.slot.maximum")}
                            value={String(fragment.maximumEntries ?? "")}
                            owner={`${testId}:maximum`}
                            inputMode="numeric"
                            testId={`${testId}-maximum`}
                            validate={(raw) =>
                                raw === "" ||
                                (/^\d+$/.test(raw) &&
                                    Number(raw) >= 1 &&
                                    Number(raw) <= MAXIMUM_SLOT_ENTRIES)
                                    ? null
                                    : t(
                                          "inspector.composition.slot.maximumRange",
                                          {
                                              maximum: MAXIMUM_SLOT_ENTRIES,
                                          },
                                      )
                            }
                            onCommit={(raw) => {
                                const maximumEntries =
                                    raw === "" ? undefined : Number(raw);
                                // The count message only applies when entries are limited.
                                const limited = withOptional(
                                    fragment,
                                    "maximumEntries",
                                    maximumEntries,
                                );
                                onChange(
                                    maximumEntries === undefined
                                        ? withOptional(
                                              limited,
                                              "overflowCountMessage",
                                              undefined,
                                          )
                                        : limited,
                                );
                            }}
                        />
                    </label>
                    {fragment.maximumEntries !== undefined && (
                        <label className="field-inline">
                            <span>{t("inspector.composition.slot.count")}</span>
                            {fragment.overflowCountMessage ? (
                                <span className="fragment-count">
                                    <MessageField
                                        messageKey={
                                            fragment.overflowCountMessage
                                        }
                                        label={t(
                                            "inspector.composition.slot.count",
                                        )}
                                        testId={`${testId}-count`}
                                    />
                                    <button
                                        type="button"
                                        className="icon-button"
                                        aria-label={t(
                                            "inspector.composition.slot.removeCount",
                                        )}
                                        data-tooltip={t(
                                            "inspector.composition.slot.removeCount",
                                        )}
                                        onClick={() =>
                                            onChange(
                                                withOptional(
                                                    fragment,
                                                    "overflowCountMessage",
                                                    undefined,
                                                ),
                                            )
                                        }
                                    >
                                        <X size={14} />
                                    </button>
                                </span>
                            ) : (
                                <button
                                    type="button"
                                    className="text-command"
                                    data-testid={`${testId}-add-count`}
                                    onClick={() => {
                                        const message = `item.text.${crypto.randomUUID()}`;
                                        const transaction =
                                            store.beginTransaction();
                                        store.setMessage(
                                            doc.defaultLocale,
                                            message,
                                            "+{count}",
                                        );
                                        onChange({
                                            ...fragment,
                                            overflowCountMessage: message,
                                        });
                                        store.commitTransaction(transaction);
                                    }}
                                >
                                    <Plus size={14} />
                                    {t("inspector.composition.slot.addCount")}
                                </button>
                            )}
                        </label>
                    )}
                </>
            )}
            {fragment.condition && (
                <p className="dim small">
                    {t("inspector.composition.conditional")}
                </p>
            )}
        </details>
    );
}

/**
 * The runs of a composed row, rule title or name decoration, in order. Message parts are typed
 * in the previewed language like content labels; rarely changed settings stay folded per part.
 */
export function FragmentListEditor({
    item,
    fragments,
    onChange,
    label,
    testId,
    allowSlots = true,
}: {
    item: ItemNode;
    fragments: readonly Fragment[];
    onChange(next: Fragment[]): void;
    label: string;
    testId: string;
    allowSlots?: boolean;
}) {
    const { t } = useTranslation();
    const { create, available } = useFragmentFactory(item);
    const replaceAt = (index: number, fragment: Fragment) =>
        onChange(
            fragments.map((entry, at) => (at === index ? fragment : entry)),
        );
    const move = (index: number, delta: number) => {
        const next = [...fragments];
        const [moved] = next.splice(index, 1);
        next.splice(index + delta, 0, moved!);
        onChange(next);
    };
    return (
        <div className="fragment-list" data-testid={testId}>
            <span className="field-label">{label}</span>
            {fragments.length === 0 && (
                <p className="dim small">{t("inspector.composition.empty")}</p>
            )}
            {fragments.map((fragment, index) => {
                const rowId = `${testId}-${index}`;
                return (
                    <div
                        className="fragment-row"
                        key={`${index}-${fragment.kind}`}
                        data-testid={rowId}
                    >
                        <div className="fragment-main">
                            <SelectField
                                label={t("inspector.composition.kind")}
                                value={fragment.kind}
                                data-testid={`${rowId}-kind`}
                                onValueChange={(kind) =>
                                    kind !== fragment.kind &&
                                    create(kind as FragmentKind, (next) =>
                                        replaceAt(
                                            index,
                                            keepCommon(fragment, next),
                                        ),
                                    )
                                }
                                options={FRAGMENT_KINDS.map((kind) => ({
                                    value: kind,
                                    label: t(
                                        `inspector.composition.kinds.${kind}`,
                                    ),
                                    disabled:
                                        !available(kind) ||
                                        (kind === "slot" && !allowSlots),
                                }))}
                            />
                            <FragmentValue
                                item={item}
                                fragment={fragment}
                                testId={rowId}
                                onChange={(next) => replaceAt(index, next)}
                            />
                            <span className="fragment-commands">
                                <button
                                    type="button"
                                    className="icon-button"
                                    disabled={index === 0}
                                    aria-label={t("inspector.content.moveUp")}
                                    data-tooltip={t("inspector.content.moveUp")}
                                    onClick={() => move(index, -1)}
                                >
                                    <ChevronUp size={14} />
                                </button>
                                <button
                                    type="button"
                                    className="icon-button"
                                    disabled={index === fragments.length - 1}
                                    aria-label={t("inspector.content.moveDown")}
                                    data-tooltip={t(
                                        "inspector.content.moveDown",
                                    )}
                                    onClick={() => move(index, 1)}
                                >
                                    <ChevronDown size={14} />
                                </button>
                                <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t(
                                        "inspector.composition.removePart",
                                    )}
                                    data-tooltip={t(
                                        "inspector.composition.removePart",
                                    )}
                                    data-testid={`${rowId}-remove`}
                                    onClick={() =>
                                        onChange(
                                            fragments.filter(
                                                (_entry, at) => at !== index,
                                            ),
                                        )
                                    }
                                >
                                    <X size={14} />
                                </button>
                            </span>
                        </div>
                        <FragmentOptions
                            item={item}
                            fragment={fragment}
                            testId={rowId}
                            onChange={(next) => replaceAt(index, next)}
                        />
                    </div>
                );
            })}
            <button
                type="button"
                className="text-command"
                data-testid={`${testId}-add`}
                disabled={fragments.length >= MAXIMUM_FRAGMENTS_PER_REGION}
                onClick={() =>
                    create("message", (fragment) =>
                        onChange([...fragments, fragment]),
                    )
                }
            >
                <Plus size={14} />
                {t("inspector.composition.addPart")}
            </button>
        </div>
    );
}

type RowBlock = Extract<PresentationBlock, { type: "row" }>;
type RuleBlock = Extract<PresentationBlock, { type: "rule" }>;

/** A composed row: left runs, and right runs aligned to the far edge. */
export function RowFields({
    item,
    block,
    onReplace,
}: {
    item: ItemNode;
    block: RowBlock;
    onReplace(next: PresentationBlock): void;
}) {
    const { t } = useTranslation();
    return (
        <div className="block-detail composition-fields">
            <FragmentListEditor
                item={item}
                fragments={block.left}
                label={t("inspector.composition.left")}
                testId={`row-left-${block.uuid.slice(0, 8)}`}
                onChange={(left) => onReplace({ ...block, left })}
            />
            <FragmentListEditor
                item={item}
                fragments={block.right}
                label={t("inspector.composition.right")}
                testId={`row-right-${block.uuid.slice(0, 8)}`}
                onChange={(right) => onReplace({ ...block, right })}
            />
        </div>
    );
}

/** A measured rule across the tooltip; an optional title sits centered on it. */
export function RuleFields({
    item,
    block,
    onReplace,
}: {
    item: ItemNode;
    block: RuleBlock;
    onReplace(next: PresentationBlock): void;
}) {
    const { t } = useTranslation();
    return (
        <div className="block-detail composition-fields">
            <FragmentListEditor
                item={item}
                fragments={block.title}
                label={t("inspector.composition.title")}
                testId={`rule-title-${block.uuid.slice(0, 8)}`}
                onChange={(title) => onReplace({ ...block, title })}
            />
        </div>
    );
}

/** Styles for the icon, label, separator and value of a stat row; folded with its options. */
export function PartStylesFields({
    item,
    value,
    onChange,
    testId,
}: {
    item: ItemNode;
    value: FieldPartStyles | undefined;
    onChange(next: FieldPartStyles | undefined): void;
    testId: string;
}) {
    const { t } = useTranslation();
    return (
        <div className="part-styles" data-testid={testId}>
            <span className="field-label">
                {t("inspector.composition.partStyles")}
            </span>
            {(["icon", "label", "separator", "value"] as const).map((part) => (
                <StyleField
                    key={part}
                    item={item}
                    value={value?.[part]}
                    label={t(`inspector.composition.parts.${part}`)}
                    defaultLabel={t("inspector.composition.inheritStyle")}
                    testId={`${testId}-${part}`}
                    onChange={(style) => {
                        const next = withOptional(value ?? {}, part, style);
                        onChange(Object.keys(next).length ? next : undefined);
                    }}
                />
            ))}
        </div>
    );
}

export function effectiveOverflow(
    document: ProjectDocument,
    item: ItemNode,
): OverflowStrategy {
    const layout = document.layouts.find(
        (entry) => entry.id === itemLayout(document, item),
    );
    return (
        item.presentation.overflow ??
        (layout?.kind === "flow" ? layout.overflow : undefined) ??
        "FALLBACK"
    );
}

/**
 * How a block gives way when the tooltip is full, folded because only full tooltips need it.
 * A container passes its weight to its rows; only rows can leave a summary behind.
 */
export function HidingFields({
    item,
    block,
    onReplace,
}: {
    item: ItemNode;
    block: PresentationBlock;
    onReplace(next: PresentationBlock): void;
}) {
    const { t } = useTranslation();
    const doc = useEditorStore((state) => state.document);
    const weight = block.weight;
    const mode =
        weight === undefined ? "" : weight === "never" ? "never" : "ranked";
    const summarizes =
        block.type !== "conditional" &&
        block.type !== "group" &&
        weight !== "never";
    const summary = summarizes ? block.summary : undefined;
    const slots = itemSlotIds(item);
    const testId = `hiding-${block.uuid.slice(0, 8)}`;
    const setSummary = (next: Summary | undefined) =>
        onReplace(withOptional(block, "summary", next));
    return (
        <details
            className="advanced"
            data-testid={testId}
            open={weight !== undefined || summary !== undefined || undefined}
        >
            <summary>{t("inspector.hiding.heading")}</summary>
            {effectiveOverflow(doc, item) !== "HIDE" && (
                <p className="dim small">{t("inspector.hiding.inactive")}</p>
            )}
            <label className="field-inline">
                <span>{t("inspector.hiding.weight")}</span>
                <SelectField
                    label={t("inspector.hiding.weight")}
                    value={mode}
                    data-testid={`${testId}-mode`}
                    onValueChange={(next) => {
                        const value =
                            next === "never"
                                ? ("never" as const)
                                : next === "ranked"
                                  ? 0
                                  : undefined;
                        const updated = withOptional(block, "weight", value);
                        // A row that is never hidden cannot leave a summary behind.
                        onReplace(
                            value === "never"
                                ? withOptional(updated, "summary", undefined)
                                : updated,
                        );
                    }}
                    options={[
                        {
                            value: "",
                            label: t("inspector.hiding.modes.default"),
                        },
                        {
                            value: "ranked",
                            label: t("inspector.hiding.modes.ranked"),
                        },
                        {
                            value: "never",
                            label: t("inspector.hiding.modes.never"),
                        },
                    ]}
                />
            </label>
            {typeof weight === "number" && (
                <label className="field-inline">
                    <span>{t("inspector.hiding.rank")}</span>
                    <BufferedInput
                        label={t("inspector.hiding.rank")}
                        value={String(weight)}
                        owner={`${block.uuid}:weight`}
                        inputMode="numeric"
                        testId={`${testId}-rank`}
                        validate={(raw) =>
                            /^\d+$/.test(raw) &&
                            Number(raw) <= MAXIMUM_HIDING_WEIGHT
                                ? null
                                : t("inspector.hiding.rankRange", {
                                      maximum: MAXIMUM_HIDING_WEIGHT,
                                  })
                        }
                        onCommit={(raw) =>
                            onReplace({ ...block, weight: Number(raw) })
                        }
                    />
                </label>
            )}
            <p className="dim small">{t("inspector.hiding.order")}</p>
            {summarizes && (
                <>
                    <label className="field-inline">
                        <span>{t("inspector.hiding.summary")}</span>
                        <SelectField
                            label={t("inspector.hiding.summary")}
                            value={summary?.slot ?? ""}
                            data-testid={`${testId}-slot`}
                            onValueChange={(slot) =>
                                setSummary(
                                    slot
                                        ? summary
                                            ? { ...summary, slot }
                                            : {
                                                  slot,
                                                  ...(block.type === "repeat"
                                                      ? {
                                                            valuePath:
                                                                block.template
                                                                    .valuePath,
                                                        }
                                                      : {
                                                            piece: {
                                                                kind: "literal",
                                                                text: "+",
                                                            },
                                                        }),
                                              }
                                        : undefined,
                                )
                            }
                            options={[
                                { value: "", label: t("inspector.none") },
                                ...slots.map((slot) => ({
                                    value: slot,
                                    label: slot,
                                })),
                            ]}
                        />
                    </label>
                    {slots.length === 0 && !summary && (
                        <p className="dim small">
                            {t("inspector.hiding.noSlots")}
                        </p>
                    )}
                    {summary && (
                        <SummaryFields
                            item={item}
                            block={block}
                            summary={summary}
                            onChange={setSummary}
                            testId={testId}
                        />
                    )}
                </>
            )}
        </details>
    );
}

function SummaryFields({
    item,
    block,
    summary,
    onChange,
    testId,
}: {
    item: ItemNode;
    block: PresentationBlock;
    summary: Summary;
    onChange(next: Summary): void;
    testId: string;
}) {
    const { t } = useTranslation();
    const doc = useEditorStore((state) => state.document);
    const elementValue = summary.valuePath !== undefined;
    return (
        <>
            {block.type === "repeat" && (
                <label className="field-inline">
                    <span>{t("inspector.hiding.leaves")}</span>
                    <SelectField
                        label={t("inspector.hiding.leaves")}
                        value={elementValue ? "value" : "piece"}
                        data-testid={`${testId}-leaves`}
                        onValueChange={(next) =>
                            onChange(
                                next === "value"
                                    ? {
                                          slot: summary.slot,
                                          valuePath: block.template.valuePath,
                                          ...(summary.style
                                              ? { style: summary.style }
                                              : {}),
                                      }
                                    : {
                                          slot: summary.slot,
                                          piece: { kind: "literal", text: "+" },
                                          ...(summary.style
                                              ? { style: summary.style }
                                              : {}),
                                      },
                            )
                        }
                        options={[
                            {
                                value: "piece",
                                label: t("inspector.hiding.leavePiece"),
                            },
                            {
                                value: "value",
                                label: t("inspector.hiding.leaveValue"),
                            },
                        ]}
                    />
                </label>
            )}
            {elementValue ? (
                <>
                    <label className="field-inline">
                        <span>{t("inspector.hiding.valuePath")}</span>
                        <BufferedInput
                            label={t("inspector.hiding.valuePath")}
                            value={summary.valuePath ?? ""}
                            owner={`${block.uuid}:summary-path`}
                            testId={`${testId}-path`}
                            validate={(raw) =>
                                raw.length > 0
                                    ? null
                                    : t("inspector.hiding.valuePathRequired")
                            }
                            onCommit={(valuePath) =>
                                onChange({ ...summary, valuePath })
                            }
                        />
                    </label>
                    <label className="field-inline">
                        <span>{t("inspector.content.formatLabel")}</span>
                        <SelectField
                            label={t("inspector.content.formatLabel")}
                            value={summary.format ?? ""}
                            data-testid={`${testId}-format`}
                            onValueChange={(format) =>
                                onChange(
                                    withOptional(
                                        summary,
                                        "format",
                                        format || undefined,
                                    ),
                                )
                            }
                            options={[
                                { value: "", label: t("inspector.none") },
                                ...doc.formats.map((format) => ({
                                    value: format.id,
                                    label:
                                        format.id.split(":").pop() ?? format.id,
                                })),
                            ]}
                        />
                    </label>
                </>
            ) : (
                <PieceField
                    item={item}
                    piece={summary.piece}
                    label={t("inspector.hiding.piece")}
                    testId={`${testId}-piece`}
                    onChange={(piece) =>
                        onChange(withOptional(summary, "piece", piece))
                    }
                />
            )}
            <StyleField
                item={item}
                value={summary.style}
                label={t("inspector.content.style")}
                defaultLabel={t("inspector.composition.inheritStyle")}
                testId={`${testId}-style`}
                onChange={(style) =>
                    onChange(withOptional(summary, "style", style))
                }
            />
        </>
    );
}

/** Runs before and after the item name, folded because most names need none. */
export function NameDecorationFields({ item }: { item: ItemNode }) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const set = (key: "nameBefore" | "nameAfter", next: Fragment[]) =>
        store.updateItem(item.uuid, (current) => ({
            ...current,
            presentation: withOptional(
                current.presentation,
                key,
                next.length ? next : undefined,
            ),
        }));
    const decorated = Boolean(
        item.presentation.nameBefore?.length ||
        item.presentation.nameAfter?.length,
    );
    return (
        <details
            className="advanced"
            data-testid="name-decorations"
            open={decorated || undefined}
        >
            <summary>{t("inspector.composition.nameDecorations")}</summary>
            <FragmentListEditor
                item={item}
                fragments={item.presentation.nameBefore ?? []}
                label={t("inspector.composition.nameBefore")}
                testId="name-before"
                onChange={(next) => set("nameBefore", next)}
            />
            <FragmentListEditor
                item={item}
                fragments={item.presentation.nameAfter ?? []}
                label={t("inspector.composition.nameAfter")}
                testId="name-after"
                onChange={(next) => set("nameAfter", next)}
            />
        </details>
    );
}

/** The item's response to a full tooltip; absent follows its layout. */
export function ItemOverflowField({ item }: { item: ItemNode }) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const doc = store.document;
    const layout = doc.layouts.find(
        (entry) => entry.id === itemLayout(doc, item),
    );
    const inherited =
        (layout?.kind === "flow" ? layout.overflow : undefined) ?? "FALLBACK";
    return (
        <label className="field">
            <span>{t("inspector.hiding.itemOverflow")}</span>
            <SelectField
                label={t("inspector.hiding.itemOverflow")}
                value={item.presentation.overflow ?? ""}
                data-testid="item-overflow"
                onValueChange={(value) =>
                    store.updateItem(item.uuid, (current) => ({
                        ...current,
                        presentation: withOptional(
                            current.presentation,
                            "overflow",
                            (value || undefined) as
                                OverflowStrategy | undefined,
                        ),
                    }))
                }
                options={[
                    {
                        value: "",
                        label: t("inspector.hiding.overflowInherit", {
                            strategy: t(
                                `inspector.hiding.strategies.${inherited}`,
                            ),
                        }),
                    },
                    ...(["FALLBACK", "HIDE"] as const).map((strategy) => ({
                        value: strategy,
                        label: t(`inspector.hiding.strategies.${strategy}`),
                    })),
                ]}
            />
            <span className="muted small">
                {t("inspector.hiding.overflowHint")}
            </span>
        </label>
    );
}
