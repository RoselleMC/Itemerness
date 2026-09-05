import { useTranslation } from "react-i18next";
import type { DataValue, ProjectDocument } from "@itemerness/protocol";
import { useEditorStore, type PackSimulation } from "../../state/store.js";
import { humanizePath } from "../common/messages.js";

/**
 * The previewed player, as a thing you can pose.
 *
 * Conditions and themes react to who is looking: their level, their class, whether they accepted
 * the resource pack. Editing those as "viewer fact preview values" would be schema-speak; posing a
 * persona — set the level to 15, watch the requirement line turn green — is how an editor actually
 * thinks about it. Values written here are preview-only and never published, same as sample values
 * on content rows.
 */
export function PersonaPanel({
    facts: available,
    open,
    onOpenChange,
}: {
    /**
     * Facts of the document being previewed, which for a RunoRPG item is the projection rather
     * than the draft. Reading the draft instead would leave the panel empty for exactly the items
     * whose conditions depend on the player.
     */
    facts: ProjectDocument["viewerFacts"];
    open: boolean;
    onOpenChange(open: boolean): void;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();

    // Gameplay facts only. The infrastructure facts (locale, pack status, asset profile) already
    // have first-class controls: the locale chips and the pack simulation below.
    const facts = available.filter(
        (fact) => !fact.id.startsWith("itemerness:") && fact.type !== "LOCALE",
    );

    const commit = (factId: string, value: DataValue | null) =>
        store.setFactPreview(factId, value);

    const current = (fact: (typeof facts)[number]): DataValue | null =>
        store.factPreviews[fact.id] ?? fact.previewValue ?? fact.defaultValue;

    return (
        <details
            className="persona-fold"
            data-testid="persona"
            open={open}
            onToggle={(event) => onOpenChange(event.currentTarget.open)}
        >
            <summary data-testid="open-persona">{t("stage.persona")}</summary>
            <div className="persona-body">
                <p className="field-label">{t("stage.personaPack")}</p>
                <div className="chip-group">
                    {(["auto", "loaded", "none"] as const).map(
                        (simulation: PackSimulation) => (
                            <button
                                key={simulation}
                                type="button"
                                className={`chip ${store.packSimulation === simulation ? "chip-on" : ""}`}
                                onClick={() =>
                                    store.setPackSimulation(simulation)
                                }
                                data-testid={`pack-sim-${simulation}`}
                            >
                                {t(`stage.packSim.${simulation}`)}
                            </button>
                        ),
                    )}
                </div>
                <p className="muted small">{t("stage.personaPackHint")}</p>

                <label className="field-inline">
                    {t("stage.personaProfile")}
                    <select
                        value={store.assetProfileOverride ?? ""}
                        onChange={(event) =>
                            store.setAssetProfileOverride(
                                event.target.value === ""
                                    ? null
                                    : event.target.value,
                            )
                        }
                        data-testid="asset-profile-simulation"
                    >
                        <option value="">
                            {t("stage.personaProfileAuto")}
                        </option>
                        {store.document.assetProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                                {profile.id}
                            </option>
                        ))}
                    </select>
                </label>
                <p className="muted small">{t("stage.personaProfileHint")}</p>

                <label className="toggle-row">
                    <input
                        type="checkbox"
                        checked={store.managesVanillaTooltipLines}
                        onChange={(event) =>
                            store.setManagesVanillaTooltipLines(
                                event.target.checked,
                            )
                        }
                        data-testid="managed-vanilla-lines-simulation"
                    />
                    {t("stage.personaManagedLines")}
                </label>
                <p className="muted small">
                    {t("stage.personaManagedLinesHint")}
                </p>

                {facts.map((fact) => {
                    const path = fact.id.split(":").pop() ?? fact.id;
                    const value = current(fact);
                    const testid = `fact-${fact.id.replace(":", "-")}`;
                    if (fact.type === "INTEGER" || fact.type === "LONG") {
                        return (
                            <label key={fact.id} className="field-inline">
                                {humanizePath(path)}
                                <input
                                    type="number"
                                    value={
                                        value?.kind === "integer"
                                            ? value.value
                                            : ""
                                    }
                                    onChange={(event) => {
                                        if (!/^-?\d+$/.test(event.target.value))
                                            return;
                                        commit(fact.id, {
                                            kind: "integer",
                                            value: event.target.value,
                                        });
                                    }}
                                    data-testid={testid}
                                />
                            </label>
                        );
                    }
                    if (fact.type === "BOOLEAN") {
                        return (
                            <label key={fact.id} className="toggle-row">
                                <input
                                    type="checkbox"
                                    checked={
                                        value?.kind === "boolean"
                                            ? value.value
                                            : false
                                    }
                                    onChange={(event) =>
                                        commit(fact.id, {
                                            kind: "boolean",
                                            value: event.target.checked,
                                        })
                                    }
                                    data-testid={testid}
                                />
                                {humanizePath(path)}
                            </label>
                        );
                    }
                    // Strings and namespaced keys: free text, empty clears back to the default.
                    return (
                        <label key={fact.id} className="field-inline">
                            {humanizePath(path)}
                            <input
                                value={
                                    value?.kind === "string" ? value.value : ""
                                }
                                placeholder={t("stage.personaUnset")}
                                onChange={(event) =>
                                    commit(
                                        fact.id,
                                        event.target.value === ""
                                            ? null
                                            : {
                                                  kind: "string",
                                                  value: event.target.value,
                                              },
                                    )
                                }
                                data-testid={testid}
                            />
                        </label>
                    );
                })}
            </div>
        </details>
    );
}
