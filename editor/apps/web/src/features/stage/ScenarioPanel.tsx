import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    contentHash,
    previewParameterField,
    type PreviewProviders,
    type PreviewScenario,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { SelectField } from "../common/SelectField.js";
import { DataValueEditor } from "../common/DataValueEditor.js";
import { initialDataValue, valueKindForType } from "../common/typedValues.js";
import type { PreviewBundle } from "../preview/usePreview.js";

const NONE = "";
const optionValue = (plugin: string, id: string) => `${plugin}\u0000${id}`;

/**
 * Chooses the preview data provider scenario for the previewed item and edits its parameters.
 * The choice is viewer state: it never enters the document and is cleared with the session.
 */
export function ScenarioPanel({ preview }: { preview: PreviewBundle }) {
    const { t } = useTranslation();
    const document = useEditorStore((state) => state.document);
    const locale = useEditorStore((state) => state.viewerLocale);
    const itemId = preview.targetItemId;
    const choice = useEditorStore((state) =>
        itemId ? state.previewScenarios[itemId] : undefined,
    );
    const setChoice = useEditorStore((state) => state.setPreviewScenario);
    const client = useConnectionStore((state) => state.client);
    const [listing, setListing] = useState<{
        key: string;
        result: PreviewProviders | null;
        error: string | null;
    } | null>(null);
    const listingKey = JSON.stringify([itemId, contentHash(document), locale]);

    useEffect(() => {
        if (!client || !itemId) return;
        const abort = new AbortController();
        client
            .previewScenarios(document, itemId, locale, abort.signal)
            .then((result) => {
                if (abort.signal.aborted) return;
                setListing({ key: listingKey, result, error: null });
                // A reload changes a provider's revision; keep the choice but key previews to the new one.
                const offered = result.providers.find(
                    (provider) => provider.plugin === choice?.plugin,
                );
                if (
                    choice &&
                    offered?.revision &&
                    offered.revision !== choice.revision
                )
                    setChoice(itemId, { ...choice, revision: offered.revision });
            })
            .catch((error: Error) => {
                if (!abort.signal.aborted)
                    setListing({
                        key: listingKey,
                        result: null,
                        error: error.message,
                    });
            });
        return () => abort.abort();
        // The choice is read for its revision only; changing parameters must not refetch the listing.
    }, [client, listingKey]);

    if (!itemId) return null;
    const current = listing?.key === listingKey ? listing : null;
    const providers = current?.result?.providers ?? [];
    const offered = providers.flatMap((provider) =>
        provider.scenarios.map((scenario) => ({ provider, scenario })),
    );
    const selected = choice
        ? offered.find(
              (entry) =>
                  entry.provider.plugin === choice.plugin &&
                  entry.scenario.id === choice.id,
          )
        : undefined;
    const provenance =
        preview.server.status === "verified"
            ? preview.server.artifact.previewData
            : null;

    const choose = (value: string) => {
        if (value === NONE) return setChoice(itemId, null);
        const entry = offered.find(
            (candidate) =>
                optionValue(candidate.provider.plugin, candidate.scenario.id) ===
                value,
        );
        if (!entry) return;
        // Required parameters start from their hint or an empty value, so the first preview can run.
        const parameters = Object.fromEntries(
            entry.scenario.parameters
                .filter((parameter) => !parameter.optional)
                .map((parameter) => {
                    const { type } = previewParameterField(parameter);
                    return [
                        parameter.id,
                        parameter.defaultValue ??
                            initialDataValue(valueKindForType(type), type),
                    ];
                }),
        );
        setChoice(itemId, {
            plugin: entry.provider.plugin,
            id: entry.scenario.id,
            revision: entry.provider.revision ?? "",
            parameters,
        });
    };

    return (
        <div className="footer-scenario" data-testid="scenario-panel">
            <p className="muted">{t("stage.scenario.description")}</p>
            {current === null ? (
                <p className="muted" data-testid="scenario-loading">
                    {t("stage.scenario.loading")}
                </p>
            ) : current.error ? (
                <p className="error" role="alert">
                    {t("stage.scenario.listFailed", { reason: current.error })}
                </p>
            ) : (
                <>
                    <SelectField
                        value={
                            choice ? optionValue(choice.plugin, choice.id) : NONE
                        }
                        options={[
                            { value: NONE, label: t("stage.scenario.none") },
                            ...offered.map(({ provider, scenario }) => ({
                                value: optionValue(provider.plugin, scenario.id),
                                label: `${provider.plugin} · ${scenario.label}`,
                            })),
                            // An unavailable provider keeps its choice visible rather than silently dropping it.
                            ...(choice && !selected
                                ? [
                                      {
                                          value: optionValue(
                                              choice.plugin,
                                              choice.id,
                                          ),
                                          label: t("stage.scenario.unavailable", {
                                              plugin: choice.plugin,
                                              scenario: choice.id,
                                          }),
                                      },
                                  ]
                                : []),
                        ]}
                        label={t("stage.scenario.label")}
                        data-testid="scenario-select"
                        onValueChange={choose}
                    />
                    {offered.length === 0 && (
                        <p className="muted" data-testid="scenario-empty">
                            {t("stage.scenario.empty")}
                        </p>
                    )}
                    {providers
                        .filter((provider) => provider.failure)
                        .map((provider) => (
                            <p
                                key={provider.plugin}
                                className="error"
                                data-testid="scenario-provider-failure"
                            >
                                {t("stage.scenario.providerFailed", {
                                    plugin: provider.plugin,
                                    code: provider.failure!.code,
                                    detail: provider.failure!.detail,
                                })}
                            </p>
                        ))}
                    {selected && choice && (
                        <Parameters
                            itemId={itemId}
                            scenario={selected.scenario}
                        />
                    )}
                </>
            )}
            {choice && provenance && (
                <div data-testid="scenario-status" data-status={provenance.status}>
                    {provenance.status === "applied" ? (
                        <p>
                            {t("stage.scenario.applied", {
                                count: provenance.providedKeys.length,
                                plugin: provenance.plugin,
                            })}
                            {provenance.overriddenKeys.length > 0 && (
                                <>
                                    {" "}
                                    {t("stage.scenario.overridden", {
                                        keys: provenance.overriddenKeys.join(", "),
                                    })}
                                </>
                            )}
                        </p>
                    ) : (
                        <p className="error" role="alert">
                            {t("stage.scenario.failed", {
                                plugin: provenance.plugin,
                                code: provenance.failure?.code ?? "",
                                detail: provenance.failure?.detail ?? "",
                            })}
                        </p>
                    )}
                    {provenance.messages.map((message, index) => (
                        <p className="muted" key={index}>
                            {message}
                        </p>
                    ))}
                </div>
            )}
        </div>
    );
}

function Parameters({
    itemId,
    scenario,
}: {
    itemId: string;
    scenario: PreviewScenario;
}) {
    const { t } = useTranslation();
    const choice = useEditorStore((state) => state.previewScenarios[itemId]);
    const setChoice = useEditorStore((state) => state.setPreviewScenario);
    if (!choice || scenario.parameters.length === 0) return null;
    return (
        <div className="footer-scenario-parameters">
            {scenario.description && (
                <p className="muted">{scenario.description}</p>
            )}
            {scenario.parameters.map((parameter) => {
                const field = previewParameterField(parameter);
                const value = choice.parameters[parameter.id] ?? {
                    kind: "null" as const,
                };
                return (
                    <div key={parameter.id} className="footer-scenario-parameter">
                        <DataValueEditor
                            value={value}
                            label={
                                parameter.optional
                                    ? t("stage.scenario.optional", {
                                          label: parameter.label,
                                      })
                                    : parameter.label
                            }
                            type={field.type}
                            constraints={field.constraints}
                            nullable={parameter.optional}
                            allowNull={parameter.optional}
                            testId={`scenario-parameter-${parameter.id}`}
                            onChange={(next) => {
                                const { [parameter.id]: _old, ...rest } =
                                    choice.parameters;
                                setChoice(itemId, {
                                    ...choice,
                                    parameters:
                                        next.kind === "null"
                                            ? rest
                                            : { ...rest, [parameter.id]: next },
                                });
                            }}
                        />
                        {value.kind === "null" && parameter.defaultValue && (
                            <button
                                type="button"
                                className="link-button"
                                data-testid={`scenario-parameter-${parameter.id}-default`}
                                onClick={() =>
                                    setChoice(itemId, {
                                        ...choice,
                                        parameters: {
                                            ...choice.parameters,
                                            [parameter.id]: parameter.defaultValue!,
                                        },
                                    })
                                }
                            >
                                {t("stage.scenario.useDefault")}
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
