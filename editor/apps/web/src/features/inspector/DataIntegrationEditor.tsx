import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    Check,
    Plus,
    RotateCcw,
    Trash2,
    X,
} from "lucide-react";
import type {
    DataKeyIntegration,
    DataKeyNode,
    ProjectDocument,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { SelectField } from "../common/SelectField.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import {
    emptyReviewPolicy,
    formatAcceptsType,
    integrationIssues,
    isScalarKey,
    mergeIntegrationEdit,
    pdcCandidateIssue,
    primaryReadSource,
    upgradeWithReviewedPolicies,
    writerIssue,
    type ReviewedPolicy,
} from "./dataIntegrationEditing.js";
import "./data-integration.css";

function IntegrationAction({
    label,
    icon: Icon,
    disabled,
    onClick,
    testId,
}: {
    label: string;
    icon: typeof Plus;
    disabled?: boolean;
    onClick(): void;
    testId?: string;
}) {
    return (
        <button
            type="button"
            className="icon-button"
            aria-label={label}
            data-tooltip={label}
            data-testid={testId}
            disabled={disabled}
            onClick={onClick}
        >
            <Icon size={15} />
        </button>
    );
}

function IntegrationFields({
    document,
    dataKey,
    policy,
    onChange,
    commit = commitInlineEditor,
    readChosen = true,
    onChooseRead,
}: {
    document: ProjectDocument;
    dataKey: DataKeyNode;
    policy: DataKeyIntegration;
    onChange(policy: DataKeyIntegration): void;
    commit?(): boolean;
    readChosen?: boolean;
    onChooseRead?(): void;
}) {
    const { t } = useTranslation();
    const [newPdc, setNewPdc] = useState("");
    const [newPlugin, setNewPlugin] = useState("");
    const [pendingError, setPendingError] = useState(false);
    const localAction = useRef(false);
    const pending = useRef(false);
    pending.current = newPdc !== "" || newPlugin !== "";
    useEffect(() => {
        const guard = (event: Event) => {
            if (pending.current && !localAction.current) {
                event.preventDefault();
                setPendingError(true);
            }
        };
        window.addEventListener("itemerness:commit-inline", guard);
        return () =>
            window.removeEventListener("itemerness:commit-inline", guard);
    }, []);
    useEffect(() => {
        window.dispatchEvent(new Event("itemerness:inline-dirty"));
        if (!newPdc && !newPlugin) setPendingError(false);
        return () => {
            queueMicrotask(() =>
                window.dispatchEvent(new Event("itemerness:inline-dirty")),
            );
        };
    }, [newPdc, newPlugin]);
    const setSources = (readSources: DataKeyIntegration["readSources"]) =>
        onChange({ ...policy, readSources });
    const setWriters = (write: string[]) =>
        onChange({ ...policy, access: { ...policy.access, write } });
    const pdcError = pdcCandidateIssue(document, dataKey, policy, newPdc);
    const pluginError = writerIssue(
        dataKey,
        `plugin:${newPlugin}`,
        policy.access.write,
    );
    const issues = integrationIssues(document, dataKey, policy);
    const act = (run: () => void) => {
        localAction.current = true;
        const ready = commit();
        localAction.current = false;
        if (ready) run();
    };
    return (
        <div className="integration-fields" data-testid="integration-fields">
            <h4>{t("dataIntegration.readSources")}</h4>
            {policy.readSources.map((source, index) => (
                <div className="integration-source" key={index}>
                    <span className="integration-order">{index + 1}</span>
                    <div className="integration-source-value">
                        {source.kind === "pdc" ? (
                            <>
                                <BufferedInput
                                    label={t("dataIntegration.pdcKey")}
                                    owner={`${dataKey.uuid}-pdc-${index}`}
                                    value={source.key}
                                    testId={`integration-pdc-${index}`}
                                    validate={(raw) => {
                                        const error = pdcCandidateIssue(
                                            document,
                                            dataKey,
                                            policy,
                                            raw,
                                            index,
                                        );
                                        return error
                                            ? t(
                                                  `dataIntegration.errors.${error}`,
                                              )
                                            : null;
                                    }}
                                    onCommit={(key) =>
                                        setSources(
                                            policy.readSources.map(
                                                (entry, position) =>
                                                    position === index
                                                        ? {
                                                              kind: "pdc",
                                                              key,
                                                              mode: "FALLBACK_READ_ONLY",
                                                          }
                                                        : entry,
                                            ),
                                        )
                                    }
                                />
                                <span className="muted small">
                                    {t("dataIntegration.readOnlyFallback")}
                                </span>
                            </>
                        ) : (
                            <span>{t(`dataIntegration.${source.kind}`)}</span>
                        )}
                    </div>
                    <div className="integration-actions">
                        {index > 0 && (
                            <>
                                <IntegrationAction
                                    icon={ArrowUp}
                                    label={t("values.moveUp")}
                                    disabled={index <= 1}
                                    testId={`integration-source-${index}-up`}
                                    onClick={() =>
                                        act(() => {
                                            const next = [
                                                ...policy.readSources,
                                            ];
                                            [next[index - 1], next[index]] = [
                                                next[index]!,
                                                next[index - 1]!,
                                            ];
                                            setSources(next);
                                        })
                                    }
                                />
                                <IntegrationAction
                                    icon={ArrowDown}
                                    label={t("values.moveDown")}
                                    disabled={
                                        index === policy.readSources.length - 1
                                    }
                                    testId={`integration-source-${index}-down`}
                                    onClick={() =>
                                        act(() => {
                                            const next = [
                                                ...policy.readSources,
                                            ];
                                            [next[index], next[index + 1]] = [
                                                next[index + 1]!,
                                                next[index]!,
                                            ];
                                            setSources(next);
                                        })
                                    }
                                />
                                <IntegrationAction
                                    icon={Trash2}
                                    label={t("dataIntegration.removeSource")}
                                    testId={`integration-source-${index}-remove`}
                                    onClick={() =>
                                        act(() =>
                                            setSources(
                                                policy.readSources.filter(
                                                    (_, position) =>
                                                        position !== index,
                                                ),
                                            ),
                                        )
                                    }
                                />
                            </>
                        )}
                    </div>
                </div>
            ))}
            {policy.readSources[0]?.kind !== primaryReadSource(dataKey) && (
                <button
                    type="button"
                    className="integration-command"
                    data-testid="integration-repair-primary"
                    onClick={() =>
                        act(() =>
                            setSources([
                                { kind: primaryReadSource(dataKey) },
                                ...policy.readSources.slice(1),
                            ]),
                        )
                    }
                >
                    <RotateCcw size={14} />
                    {t("dataIntegration.repairPrimary")}
                </button>
            )}
            {dataKey.scope === "INSTANCE" && isScalarKey(dataKey) && (
                <div className="integration-add-row">
                    <input
                        aria-label={t("dataIntegration.newPdc")}
                        data-testid="integration-new-pdc"
                        data-buffered-value
                        data-dirty={newPdc !== ""}
                        placeholder={t("dataIntegration.newPdc")}
                        value={newPdc}
                        onKeyDown={(event) => {
                            if (event.key === "Escape" && newPdc) {
                                event.preventDefault();
                                event.stopPropagation();
                                setNewPdc("");
                            }
                        }}
                        onChange={(event) => setNewPdc(event.target.value)}
                    />
                    <IntegrationAction
                        icon={Plus}
                        label={t("dataIntegration.addSource")}
                        testId="integration-add-pdc"
                        disabled={!!pdcError}
                        onClick={() =>
                            act(() => {
                                setSources([
                                    ...policy.readSources,
                                    {
                                        kind: "pdc",
                                        key: newPdc,
                                        mode: "FALLBACK_READ_ONLY",
                                    },
                                ]);
                                setNewPdc("");
                            })
                        }
                    />
                </div>
            )}
            {newPdc && pdcError && (
                <p className="error small" role="alert">
                    {t(`dataIntegration.errors.${pdcError}`)}
                </p>
            )}
            <h4>{t("dataIntegration.access")}</h4>
            <label className="integration-field">
                <span>{t("dataIntegration.readAccess")}</span>
                <SelectField
                    label={t("dataIntegration.readAccess")}
                    value={readChosen ? policy.access.read : ""}
                    data-testid="integration-read"
                    options={[
                        ...(!readChosen
                            ? [
                                  {
                                      value: "",
                                      label: t("dataIntegration.chooseRead"),
                                      disabled: true,
                                  },
                              ]
                            : []),
                        { value: "PUBLIC", label: t("dataIntegration.PUBLIC") },
                        {
                            value: "INTERNAL",
                            label: t("dataIntegration.INTERNAL"),
                            disabled: policy.placeholderApi.exposed,
                        },
                        {
                            value: "OWNER_ONLY",
                            label: t("dataIntegration.OWNER_ONLY"),
                            disabled: true,
                        },
                    ]}
                    onValueChange={(read) =>
                        act(() => {
                            onChooseRead?.();
                            onChange({
                                ...policy,
                                access: {
                                    ...policy.access,
                                    read: read as DataKeyIntegration["access"]["read"],
                                },
                            });
                        })
                    }
                />
            </label>
            <span className="field-label">
                {t("dataIntegration.writeAccess")}
            </span>
            {policy.access.write.map((writer, index) => (
                <div
                    className="integration-add-row"
                    key={`${index}-${writer.startsWith("plugin:") ? "plugin" : writer}`}
                >
                    {writer === "definition" &&
                    dataKey.scope === "DEFINITION" ? (
                        <code className="integration-fixed">definition</code>
                    ) : (
                        <BufferedInput
                            label={t("dataIntegration.writer")}
                            value={writer}
                            owner={`${dataKey.uuid}-writer-${index}`}
                            testId={`integration-writer-${index}`}
                            validate={(raw) => {
                                const error = writerIssue(
                                    dataKey,
                                    raw,
                                    policy.access.write.filter(
                                        (_, position) => position !== index,
                                    ),
                                );
                                return error
                                    ? t(`dataIntegration.errors.${error}`)
                                    : null;
                            }}
                            onCommit={(next) =>
                                setWriters(
                                    policy.access.write.map((old, position) =>
                                        position === index ? next : old,
                                    ),
                                )
                            }
                        />
                    )}
                    <IntegrationAction
                        icon={Trash2}
                        label={t("dataIntegration.removeWriter")}
                        testId={`integration-writer-${index}-remove`}
                        disabled={policy.access.write.length <= 1}
                        onClick={() =>
                            act(() =>
                                setWriters(
                                    policy.access.write.filter(
                                        (_, position) => position !== index,
                                    ),
                                ),
                            )
                        }
                    />
                </div>
            ))}
            {dataKey.scope === "DEFINITION" &&
                !policy.access.write.includes("definition") && (
                    <button
                        type="button"
                        className="integration-command"
                        data-testid="integration-definition-writer"
                        onClick={() =>
                            act(() =>
                                setWriters([
                                    ...policy.access.write,
                                    "definition",
                                ]),
                            )
                        }
                    >
                        <Plus size={14} />
                        definition
                    </button>
                )}
            {dataKey.scope === "INSTANCE" && (
                <>
                    {!policy.access.write.includes("internal") && (
                        <button
                            type="button"
                            className="integration-command"
                            data-testid="integration-add-internal"
                            onClick={() =>
                                act(() =>
                                    setWriters([
                                        ...policy.access.write,
                                        "internal",
                                    ]),
                                )
                            }
                        >
                            <Plus size={14} />
                            {t("dataIntegration.addInternal")}
                        </button>
                    )}
                    <div className="integration-add-row">
                        <span className="muted small">plugin:</span>
                        <input
                            aria-label={t("dataIntegration.pluginName")}
                            data-testid="integration-new-plugin"
                            data-buffered-value
                            data-dirty={newPlugin !== ""}
                            value={newPlugin}
                            onKeyDown={(event) => {
                                if (event.key === "Escape" && newPlugin) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setNewPlugin("");
                                }
                            }}
                            onChange={(event) =>
                                setNewPlugin(event.target.value)
                            }
                        />
                        <IntegrationAction
                            icon={Plus}
                            label={t("dataIntegration.addPlugin")}
                            testId="integration-add-plugin"
                            disabled={!!pluginError}
                            onClick={() =>
                                act(() => {
                                    setWriters([
                                        ...policy.access.write,
                                        `plugin:${newPlugin}`,
                                    ]);
                                    setNewPlugin("");
                                })
                            }
                        />
                    </div>
                    {newPlugin && pluginError && (
                        <p className="error small" role="alert">
                            {t(`dataIntegration.errors.${pluginError}`)}
                        </p>
                    )}
                </>
            )}
            <p className="muted small">{t("dataIntegration.localTrust")}</p>
            <h4>PlaceholderAPI</h4>
            <label className="toggle-row">
                <input
                    type="checkbox"
                    data-testid="integration-placeholder-exposed"
                    checked={policy.placeholderApi.exposed}
                    disabled={
                        !policy.placeholderApi.exposed &&
                        (!readChosen ||
                            policy.access.read !== "PUBLIC" ||
                            !isScalarKey(dataKey))
                    }
                    onChange={(event) =>
                        act(() =>
                            onChange({
                                ...policy,
                                placeholderApi: {
                                    ...policy.placeholderApi,
                                    exposed: event.target.checked,
                                },
                            }),
                        )
                    }
                />
                {t("dataIntegration.exposed")}
            </label>
            <label className="integration-field">
                <span>{t("dataIntegration.formatter")}</span>
                <SelectField
                    label={t("dataIntegration.formatter")}
                    data-testid="integration-formatter"
                    value={policy.placeholderApi.formatter ?? ""}
                    options={[
                        { value: "", label: t("dataIntegration.noFormatter") },
                        ...document.formats
                            .filter((format) =>
                                formatAcceptsType(
                                    document,
                                    format.id,
                                    dataKey.type,
                                ),
                            )
                            .map((format) => ({
                                value: format.id,
                                label: format.id,
                            })),
                    ]}
                    onValueChange={(formatter) =>
                        act(() =>
                            onChange({
                                ...policy,
                                placeholderApi: {
                                    ...policy.placeholderApi,
                                    formatter: formatter || null,
                                },
                            }),
                        )
                    }
                />
            </label>
            {pendingError && (
                <p className="error small" role="alert">
                    {t("dataIntegration.errors.pendingEntry")}
                </p>
            )}
            {issues.length > 0 && (
                <div data-testid="integration-issues">
                    {issues.map((issue) => (
                        <p
                            className="error small"
                            key={`${issue.code}:${issue.detail ?? ""}`}
                        >
                            {t(`dataIntegration.errors.${issue.code}`, {
                                detail: issue.detail ?? "",
                            })}
                        </p>
                    ))}
                </div>
            )}
        </div>
    );
}

export function DataIntegrationEditor({
    document,
    dataKey,
}: {
    document: ProjectDocument;
    dataKey: DataKeyNode;
}) {
    const { t } = useTranslation();
    if (document.schemaVersion === 1)
        return (
            <section className="data-integration">
                <h3>{t("dataIntegration.heading")}</h3>
                <p className="muted small">{t("dataIntegration.legacy")}</p>
                <IntegrationUpgradeButton document={document} />
            </section>
        );
    return (
        <section className="data-integration" data-testid="data-integration">
            <h3>{t("dataIntegration.heading")}</h3>
            {dataKey.integration ? (
                <IntegrationFields
                    key={dataKey.uuid}
                    document={document}
                    dataKey={dataKey}
                    policy={dataKey.integration}
                    onChange={(integration) =>
                        useEditorStore
                            .getState()
                            .updateDataKey(dataKey.uuid, (current) => ({
                                ...current,
                                integration: mergeIntegrationEdit(
                                    current.integration!,
                                    dataKey.integration!,
                                    integration,
                                ),
                            }))
                    }
                />
            ) : (
                <p className="error small">
                    {t("dataIntegration.errors.missingPolicy")}
                </p>
            )}
        </section>
    );
}

export function IntegrationUpgradeButton({
    document,
}: {
    document: ProjectDocument;
}) {
    const { t } = useTranslation();
    const [reviewing, setReviewing] = useState(false);
    const supported = useConnectionStore(
        (state) => state.info?.documentSchemas.includes(2) ?? false,
    );
    useEffect(() => setReviewing(false), [document]);
    if (document.schemaVersion !== 1) return null;
    return (
        <>
            <button
                type="button"
                className="integration-command"
                data-testid="integration-review-upgrade"
                disabled={!supported}
                data-tooltip={
                    !supported
                        ? t("dataIntegration.errors.serverVersion")
                        : undefined
                }
                onClick={() => {
                    if (commitInlineEditor()) setReviewing(true);
                }}
            >
                <ArrowUp size={15} />
                {t("dataIntegration.reviewUpgrade")}
            </button>
            {!supported && (
                <p className="muted small">
                    {t("dataIntegration.errors.serverVersion")}
                </p>
            )}
            {reviewing && (
                <UpgradeReview
                    document={document}
                    onClose={() => setReviewing(false)}
                />
            )}
        </>
    );
}

function UpgradeReview({
    document: source,
    onClose,
}: {
    document: ProjectDocument;
    onClose(): void;
}) {
    const { t } = useTranslation();
    const keys = source.dataSchemas.flatMap((schema) =>
        schema.keys.map((key) => ({ schema, key })),
    );
    const [index, setIndex] = useState(0);
    const [policies, setPolicies] = useState<Record<string, ReviewedPolicy>>(
        () =>
            Object.fromEntries(
                keys.map(({ key }) => [
                    key.uuid,
                    {
                        policy: emptyReviewPolicy(key),
                        readChosen: false,
                        confirmed: false,
                    },
                ]),
            ),
    );
    const [error, setError] = useState<string | null>(null);
    const completing = useRef(false);
    const latestPolicies = useRef(policies);
    latestPolicies.current = policies;
    const dialog = useRef<HTMLDivElement>(null);
    const sourceRef = useRef(source);
    const step = keys[index];
    const entry = step ? policies[step.key.uuid]! : null;
    const commitReview = () => {
        completing.current = true;
        const result = commitInlineEditor();
        completing.current = false;
        return result;
    };
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        dialog.current?.focus();
        const guard = (event: Event) => {
            if (!completing.current) event.preventDefault();
        };
        window.addEventListener("itemerness:commit-inline", guard);
        return () => {
            window.removeEventListener("itemerness:commit-inline", guard);
            if (previous?.isConnected) previous.focus({ preventScroll: true });
        };
    }, []);
    const setEntry = (next: ReviewedPolicy) => {
        if (!step) return;
        const entries = { ...latestPolicies.current, [step.key.uuid]: next };
        latestPolicies.current = entries;
        setPolicies(entries);
        setError(null);
    };
    const draftDocument = {
        ...source,
        dataSchemas: source.dataSchemas.map((schema) => ({
            ...schema,
            keys: schema.keys.map((key) => ({
                ...key,
                integration: policies[key.uuid]?.policy,
            })),
        })),
    };
    const stepIssues =
        step && entry
            ? integrationIssues(draftDocument, step.key, entry.policy)
            : [];
    const confirmed = keys.filter(
        ({ key }) => policies[key.uuid]?.confirmed,
    ).length;
    return (
        <div className="unsaved-backdrop integration-upgrade-backdrop">
            <div
                ref={dialog}
                tabIndex={-1}
                role="dialog"
                aria-modal="false"
                aria-labelledby="integration-upgrade-title"
                data-testid="integration-upgrade-dialog"
                className="unsaved-dialog integration-upgrade-dialog"
                data-ui-popup
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        onClose();
                    }
                    if (event.key === "Tab") {
                        const fields = [
                            ...document.querySelectorAll<HTMLElement>(
                                ".integration-upgrade-dialog button:not(:disabled),.integration-upgrade-dialog input:not(:disabled),.window-controls button:not(:disabled)",
                            ),
                        ].filter((element) => element.getClientRects().length);
                        const current = fields.indexOf(
                            document.activeElement as HTMLElement,
                        );
                        if (event.shiftKey && current <= 0) {
                            event.preventDefault();
                            fields.at(-1)?.focus();
                        } else if (
                            !event.shiftKey &&
                            current === fields.length - 1
                        ) {
                            event.preventDefault();
                            fields[0]?.focus();
                        }
                    }
                }}
            >
                <div className="integration-review-header">
                    <h2 id="integration-upgrade-title">
                        {t("dataIntegration.reviewUpgrade")}
                    </h2>
                    <IntegrationAction
                        icon={X}
                        label={t("settings.cancel")}
                        testId="integration-upgrade-cancel"
                        onClick={onClose}
                    />
                </div>
                <p className="muted small">
                    {t("dataIntegration.upgradeNotice")}
                </p>
                <p className="muted small">
                    {t("dataIntegration.measurementMigration")}
                </p>
                <div className="integration-review-heading">
                    <strong>
                        {t("dataIntegration.reviewProgress", {
                            current: keys.length ? index + 1 : 0,
                            total: keys.length,
                        })}
                    </strong>
                    <span className="muted small">
                        {t("dataIntegration.confirmedProgress", {
                            count: confirmed,
                            total: keys.length,
                        })}
                    </span>
                </div>
                {step && entry && (
                    <>
                        <SelectField
                            label={t("dataIntegration.reviewKey")}
                            data-testid="integration-review-key"
                            value={step.key.uuid}
                            options={keys.map(({ schema, key }, position) => ({
                                value: key.uuid,
                                label: `${position + 1}. ${schema.id}@${schema.version} / ${key.id}`,
                                group: t(
                                    policies[key.uuid]?.confirmed
                                        ? "dataIntegration.confirmed"
                                        : "dataIntegration.needsReview",
                                ),
                            }))}
                            onValueChange={(uuid) => {
                                if (commitReview())
                                    setIndex(
                                        keys.findIndex(
                                            ({ key }) => key.uuid === uuid,
                                        ),
                                    );
                            }}
                        />
                        <div className="integration-review-body">
                            <IntegrationFields
                                key={step.key.uuid}
                                document={draftDocument}
                                dataKey={step.key}
                                policy={entry.policy}
                                readChosen={entry.readChosen}
                                commit={commitReview}
                                onChooseRead={() => {
                                    const current =
                                        latestPolicies.current[step.key.uuid]!;
                                    setEntry({
                                        ...current,
                                        readChosen: true,
                                        confirmed: false,
                                    });
                                }}
                                onChange={(policy) => {
                                    const current =
                                        latestPolicies.current[step.key.uuid]!;
                                    setEntry({
                                        ...current,
                                        policy: mergeIntegrationEdit(
                                            current.policy,
                                            entry.policy,
                                            policy,
                                        ),
                                        confirmed: false,
                                    });
                                }}
                            />
                        </div>
                        <div className="integration-review-navigation">
                            <IntegrationAction
                                icon={ArrowLeft}
                                label={t("dataIntegration.previous")}
                                testId="integration-review-previous"
                                disabled={index === 0}
                                onClick={() => {
                                    if (commitReview()) setIndex(index - 1);
                                }}
                            />
                            <button
                                type="button"
                                className="integration-command"
                                data-testid="integration-confirm-policy"
                                disabled={
                                    !entry.readChosen || stepIssues.length > 0
                                }
                                onClick={() => {
                                    if (!commitReview()) return;
                                    const current =
                                        latestPolicies.current[step.key.uuid]!;
                                    setEntry({ ...current, confirmed: true });
                                    if (index < keys.length - 1)
                                        setIndex(index + 1);
                                }}
                            >
                                <Check size={15} />
                                {t("dataIntegration.confirmPolicy")}
                            </button>
                            <IntegrationAction
                                icon={ArrowRight}
                                label={t("dataIntegration.next")}
                                testId="integration-review-next"
                                disabled={index >= keys.length - 1}
                                onClick={() => {
                                    if (commitReview()) setIndex(index + 1);
                                }}
                            />
                        </div>
                    </>
                )}
                {error && (
                    <p className="error small" role="alert">
                        {error}
                    </p>
                )}
                <div className="dialog-actions">
                    <button type="button" onClick={onClose}>
                        {t("settings.cancel")}
                    </button>
                    <button
                        type="button"
                        data-testid="integration-upgrade-apply"
                        disabled={confirmed !== keys.length}
                        onClick={() => {
                            if (!commitReview()) return;
                            const current = useEditorStore.getState();
                            if (
                                current.document !== sourceRef.current ||
                                !useConnectionStore
                                    .getState()
                                    .info?.documentSchemas.includes(2)
                            ) {
                                onClose();
                                return;
                            }
                            try {
                                const upgraded = upgradeWithReviewedPolicies(
                                    source,
                                    latestPolicies.current,
                                );
                                current.updateDocument(() => upgraded);
                                onClose();
                            } catch {
                                setError(
                                    t(
                                        "dataIntegration.errors.upgradeValidation",
                                    ),
                                );
                            }
                        }}
                    >
                        {t("dataIntegration.applyUpgrade")}
                    </button>
                </div>
            </div>
        </div>
    );
}
