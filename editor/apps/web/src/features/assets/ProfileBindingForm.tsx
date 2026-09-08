import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import {
    namespacedIdSchema,
    uuidSchema,
    type AssetProfileNode,
    type ProjectDocument,
    type ResourcePackBindingNode,
    type TooltipStyleNode,
} from "@itemerness/protocol";
import { AssetSelect, AssetText, AssetToggle } from "./AssetFields.js";
import { SuggestionInput } from "../common/SuggestionInput.js";
import { fallbackCycle } from "../../state/assetLibrary.js";
import { AssetTexture } from "./AssetTexture.js";

export function ProfileForm({
    profile,
    document,
    update,
}: {
    profile: AssetProfileNode;
    document: ProjectDocument;
    update(change: (source: AssetProfileNode) => AssetProfileNode): void;
}) {
    const { t } = useTranslation();
    const [capability, setCapability] = useState("");
    const [error, setError] = useState<string | null>(null);
    const add = () => {
        const issue = !namespacedIdSchema.safeParse(capability).success
            ? "namespacedId"
            : profile.capabilities.includes(capability)
              ? "duplicateCapability"
              : null;
        setError(issue);
        if (issue) return;
        update((source) => ({
            ...source,
            capabilities: [...source.capabilities, capability],
        }));
        setCapability("");
    };
    return (
        <>
            <section>
                <h3>{t("assetAuthoring.assetProfile")}</h3>
                <AssetText
                    name="metricsRevision"
                    value={profile.metricsRevision ?? ""}
                    owner={profile.uuid}
                    suggestions={document.assetProfiles.flatMap((entry) =>
                        entry.metricsRevision ? [entry.metricsRevision] : [],
                    )}
                    validate={(value) =>
                        value === "" ||
                        namespacedIdSchema.safeParse(value).success
                            ? null
                            : "namespacedId"
                    }
                    onChange={(value) =>
                        update((source) => ({
                            ...source,
                            metricsRevision: value || null,
                        }))
                    }
                />
                <AssetSelect
                    name="profileFallback"
                    value={profile.fallback ?? ""}
                    options={[
                        { value: "", label: t("inspector.none") },
                        ...document.assetProfiles.map((entry) => ({
                            value: entry.id,
                            label: entry.id,
                            disabled: fallbackCycle(
                                document,
                                "assetProfiles",
                                profile.id,
                                entry.id,
                            ),
                        })),
                    ]}
                    onChange={(value) =>
                        update((source) => ({
                            ...source,
                            fallback: value || null,
                        }))
                    }
                />
            </section>
            <section>
                <h3>{t("assetAuthoring.capabilities")}</h3>
                <ul className="asset-capability-list">
                    {profile.capabilities.map((value) => (
                        <li key={value}>
                            <AssetText
                                name="capability"
                                value={value}
                                owner={`${profile.uuid}:${value}`}
                                testId={`asset-capability-${value}`}
                                validate={(next) =>
                                    !namespacedIdSchema.safeParse(next).success
                                        ? "namespacedId"
                                        : next !== value &&
                                            profile.capabilities.includes(next)
                                          ? "duplicateCapability"
                                          : null
                                }
                                onChange={(next) =>
                                    update((source) => ({
                                        ...source,
                                        capabilities: source.capabilities.map(
                                            (entry) =>
                                                entry === value ? next : entry,
                                        ),
                                    }))
                                }
                            />
                            <button
                                type="button"
                                className="icon-button"
                                aria-label={t(
                                    "assetAuthoring.removeCapability",
                                    { value },
                                )}
                                data-tooltip={t(
                                    "assetAuthoring.removeCapability",
                                    { value },
                                )}
                                onClick={() =>
                                    update((source) => ({
                                        ...source,
                                        capabilities:
                                            source.capabilities.filter(
                                                (entry) => entry !== value,
                                            ),
                                    }))
                                }
                            >
                                <Trash2 size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
                <div className="asset-add-row">
                    <SuggestionInput
                        label={t("assetAuthoring.addCapability")}
                        value={capability}
                        suggestions={[
                            ...new Set([
                                ...document.assetProfiles.flatMap(
                                    (entry) => entry.capabilities,
                                ),
                                ...document.themes.flatMap(
                                    (theme) => theme.requiredCapabilities,
                                ),
                            ]),
                        ]}
                        onValueChange={(value) => {
                            setCapability(value);
                            setError(null);
                        }}
                        data-testid="asset-capability-input"
                    />
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={t("assetAuthoring.addCapability")}
                        data-tooltip={t("assetAuthoring.addCapability")}
                        data-testid="asset-add-capability"
                        onClick={add}
                    >
                        <Plus size={15} />
                    </button>
                </div>
                {error && (
                    <p className="error small" role="alert">
                        {t(`assetAuthoring.errors.${error}`)}
                    </p>
                )}
            </section>
        </>
    );
}

export function BindingForm({
    binding,
    document,
    update,
}: {
    binding: ResourcePackBindingNode;
    document: ProjectDocument;
    update(
        change: (source: ResourcePackBindingNode) => ResourcePackBindingNode,
    ): void;
}) {
    const { t } = useTranslation();
    return (
        <section>
            <h3>{t("assetAuthoring.binding")}</h3>
            <AssetToggle
                name="bindingEnabled"
                checked={binding.enabled}
                onChange={(enabled) =>
                    update((source) => ({ ...source, enabled }))
                }
            />
            <AssetText
                name="packId"
                value={binding.packId ?? ""}
                owner={binding.uuid}
                validate={(value) =>
                    value === "" || uuidSchema.safeParse(value).success
                        ? null
                        : "uuid"
                }
                onChange={(value) =>
                    update((source) => ({ ...source, packId: value || null }))
                }
            />
            <AssetText
                name="sha1"
                value={binding.sha1 ?? ""}
                owner={binding.uuid}
                validate={(value) =>
                    !binding.enabled ||
                    value === "" ||
                    /^[a-f0-9]{40}$/i.test(value)
                        ? null
                        : "sha1"
                }
                onChange={(value) =>
                    update((source) => ({
                        ...source,
                        sha1: value || null,
                    }))
                }
            />
            <AssetSelect
                name="assetProfile"
                value={binding.assetProfile}
                options={document.assetProfiles.map((entry) => ({
                    value: entry.id,
                    label: entry.id,
                }))}
                onChange={(assetProfile) =>
                    update((source) => ({ ...source, assetProfile }))
                }
            />
        </section>
    );
}

export function TooltipStyleForm({
    style,
    update,
}: {
    style: TooltipStyleNode;
    update(change: (source: TooltipStyleNode) => TooltipStyleNode): void;
}) {
    const { t } = useTranslation();
    return (
        <section>
            <h3>{t("assetAuthoring.tooltipStyle")}</h3>
            {(["expectedBackgroundSprite", "expectedFrameSprite"] as const).map(
                (name) => (
                    <div key={name}>
                        <AssetText
                            name={name}
                            value={style[name]}
                            owner={style.uuid}
                            validate={(value) =>
                                namespacedIdSchema.safeParse(value).success
                                    ? null
                                    : "namespacedId"
                            }
                            onChange={(value) =>
                                update((source) => ({
                                    ...source,
                                    [name]: value,
                                }))
                            }
                        />
                        {style[name] && (
                            <AssetTexture texture={style[name]} sprite />
                        )}
                    </div>
                ),
            )}
            <AssetSelect
                name="scaling"
                value={style.scaling}
                options={[
                    {
                        value: "nine-slice",
                        label: t("assetAuthoring.nineSlice"),
                    },
                    { value: "stretch", label: t("assetAuthoring.stretch") },
                ]}
                onChange={(value) =>
                    update((source) => ({
                        ...source,
                        scaling: value as TooltipStyleNode["scaling"],
                    }))
                }
            />
        </section>
    );
}
