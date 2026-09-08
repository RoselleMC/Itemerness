import { useRef, type ReactNode } from "react";
import { Download, FileUp, Plus, Redo2, Trash2, Undo2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocalOperationsStore } from "../../state/localOperations.js";
import { confirmAction, describeContext } from "../../state/interface.js";
import { SelectField } from "../common/SelectField.js";
import {
    API_ACTIONS,
    NAMED_COLORS,
    configurationValue,
    numberInput,
    type ConfigurationPath,
} from "./localConfiguration.js";
import "./local-operations.css";
import { MAX_LOCAL_YAML_BYTES } from "./saveLocalExport.js";

export function LocalOperationsTool() {
    const { t } = useTranslation("localOperations");
    const state = useLocalOperationsStore();
    const input = useRef<HTMLInputElement>(null);
    const readEpoch = useRef(0);
    const config = state.session?.configuration;
    const currentId = state.session?.id;
    const discardPermission = async () =>
        !useLocalOperationsStore.getState().dirty ||
        confirmAction({
            title: t("discardTitle"),
            message: t("discardMessage"),
            accept: t("discard"),
        });
    const openFile = async (file: File) => {
        const epoch = ++readEpoch.current;
        const owner = useLocalOperationsStore.getState().session?.id;
        if (
            !(await discardPermission()) ||
            epoch !== readEpoch.current ||
            owner !== useLocalOperationsStore.getState().session?.id
        )
            return;
        const beforeRead =
            useLocalOperationsStore.getState().session?.configuration.text;
        try {
            if (file.size > MAX_LOCAL_YAML_BYTES) {
                useLocalOperationsStore.setState({
                    error: "FILE_SIZE_INVALID",
                });
                return;
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (
                epoch === readEpoch.current &&
                owner === useLocalOperationsStore.getState().session?.id
            ) {
                if (
                    beforeRead !==
                    useLocalOperationsStore.getState().session?.configuration
                        .text
                ) {
                    useLocalOperationsStore.setState({
                        error: "FILE_CHANGED_DURING_READ",
                    });
                    return;
                }
                useLocalOperationsStore.getState().open(file.name, bytes);
            }
        } catch {
            if (
                epoch === readEpoch.current &&
                owner === useLocalOperationsStore.getState().session?.id
            )
                useLocalOperationsStore.setState({ error: "FILE_READ_FAILED" });
        }
    };
    const closeFile = async () => {
        if (
            (await discardPermission()) &&
            currentId === useLocalOperationsStore.getState().session?.id
        ) {
            readEpoch.current++;
            state.discard();
        }
    };
    const value = (path: ConfigurationPath) =>
        config ? configurationValue(config, path) : undefined;
    const fieldId = (path: ConfigurationPath) => `local-${path.join("-")}`;
    const appendEntry = (path: ConfigurationPath, entry: unknown) => {
        const current = value(path);
        if (Array.isArray(current))
            state.edit([...path, current.length], entry, { discrete: true });
        else state.edit(path, [entry], { discrete: true });
    };
    const toggleAction = (
        path: ConfigurationPath,
        action: string,
        checked: boolean,
    ) => {
        const current = value(path);
        if (checked) appendEntry(path, action);
        else if (Array.isArray(current))
            state.edit([...path, current.indexOf(action)], undefined, {
                remove: true,
                discrete: true,
            });
    };
    const canEdit = (path: ConfigurationPath) => {
        if (!config?.editable) return false;
        for (let depth = 1; depth < path.length; depth++) {
            const parent = value(path.slice(0, depth));
            if (
                parent !== undefined &&
                !(parent instanceof Map) &&
                !Array.isArray(parent)
            )
                return false;
        }
        return !(value(path) instanceof Map) && !Array.isArray(value(path));
    };
    const display = (raw: unknown) =>
        raw === undefined || raw === null || typeof raw === "object"
            ? ""
            : String(raw);
    const field = (
        path: ConfigurationPath,
        label: string,
        options: {
            secret?: boolean;
            numeric?: boolean;
            multiline?: boolean;
        } = {},
    ) => {
        const common = {
            id: fieldId(path),
            "data-testid": fieldId(path),
            value: display(value(path)),
            disabled: !canEdit(path),
            spellCheck: false,
            onChange: (
                event: React.ChangeEvent<
                    HTMLInputElement | HTMLTextAreaElement
                >,
            ) =>
                state.edit(
                    path,
                    options.numeric
                        ? numberInput(event.target.value)
                        : event.target.value,
                ),
        };
        return (
            <label
                className={`local-field${options.secret || options.multiline ? " local-field-wide" : ""}`}
                key={fieldId(path)}
                htmlFor={fieldId(path)}
            >
                <span>{label}</span>
                {options.multiline ? (
                    <textarea {...common} rows={2} />
                ) : (
                    <input
                        {...common}
                        type={options.secret ? "password" : "text"}
                        inputMode={options.numeric ? "numeric" : undefined}
                        autoComplete="off"
                        autoCapitalize="none"
                        onCopy={
                            options.secret
                                ? (event) => event.preventDefault()
                                : undefined
                        }
                        onCut={
                            options.secret
                                ? (event) => event.preventDefault()
                                : undefined
                        }
                    />
                )}
            </label>
        );
    };
    const select = (
        path: ConfigurationPath,
        label: string,
        choices: readonly string[],
    ) => (
        <div className="local-field" key={fieldId(path)}>
            <span>{label}</span>
            <SelectField
                label={label}
                data-testid={fieldId(path)}
                value={display(value(path))}
                options={choices.map((choice) => ({
                    value: choice,
                    label: t(`values.${choice}`, { defaultValue: choice }),
                }))}
                disabled={!canEdit(path)}
                onValueChange={(next) =>
                    state.edit(path, next, { discrete: true })
                }
            />
        </div>
    );
    const icon = (
        label: string,
        child: ReactNode,
        run: () => void,
        disabled = false,
        testId?: string,
    ) => (
        <button
            type="button"
            className="local-icon"
            aria-label={label}
            data-tooltip={label}
            disabled={disabled}
            onClick={run}
            data-testid={testId}
        >
            {child}
        </button>
    );
    const list = (path: ConfigurationPath, label: string) => {
        const raw = value(path);
        const entries = Array.isArray(raw) ? raw : [];
        const editable =
            !!config?.editable &&
            (raw === undefined || raw === null || Array.isArray(raw));
        return (
            <fieldset className="local-list" key={fieldId(path)}>
                <legend>{label}</legend>
                {entries.map((_, index) => (
                    <div className="local-list-row" key={index}>
                        {field(
                            [...path, index],
                            t("entry", { index: index + 1 }),
                        )}
                        {icon(
                            t("removeEntry"),
                            <Trash2 size={15} />,
                            () =>
                                state.edit([...path, index], undefined, {
                                    remove: true,
                                    discrete: true,
                                }),
                            !editable,
                        )}
                    </div>
                ))}
                <button
                    type="button"
                    className="local-command"
                    disabled={!editable}
                    onClick={() => appendEntry(path, "")}
                >
                    <Plus size={15} />
                    {t("addEntry")}
                </button>
            </fieldset>
        );
    };
    const grants = value(["api", "grants"]);
    const legacy =
        value(["editor"]) instanceof Map &&
        (value(["editor"]) as Map<string, unknown>).has("url");
    return (
        <section
            className="settings-section local-operations"
            data-local-operations
            data-testid="local-operations"
            onKeyDown={(event) => {
                if (
                    (event.metaKey || event.ctrlKey) &&
                    ["z", "y"].includes(event.key.toLowerCase()) &&
                    !(event.target instanceof HTMLInputElement) &&
                    !(event.target instanceof HTMLTextAreaElement)
                ) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.shiftKey || event.key.toLowerCase() === "y")
                        state.redo();
                    else state.undo();
                }
            }}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: t("title"),
                    items: [
                        {
                            id: "local-open",
                            label: t("open"),
                            icon: FileUp,
                            disabled: state.busy,
                            run: () => input.current?.click(),
                        },
                        {
                            id: "local-undo",
                            label: t("undo"),
                            icon: Undo2,
                            disabled: !state.session?.past.length,
                            run: state.undo,
                        },
                        {
                            id: "local-redo",
                            label: t("redo"),
                            icon: Redo2,
                            disabled: !state.session?.future.length,
                            run: state.redo,
                        },
                        {
                            id: "local-export",
                            label: t("export"),
                            icon: Download,
                            disabled:
                                !config ||
                                state.busy ||
                                config.diagnostics.some(
                                    (issue) => !issue.warning,
                                ),
                            run: state.exportCurrent,
                        },
                        {
                            id: "local-close",
                            label: t("close"),
                            icon: X,
                            disabled: !config || state.busy,
                            run: closeFile,
                        },
                    ],
                })
            }
        >
            <header className="local-heading">
                <h3>{t("title")}</h3>
                <span className="local-state">
                    {state.busy
                        ? t("exporting")
                        : state.dirty
                          ? t("unsaved")
                          : config
                            ? t("unchanged")
                            : ""}
                </span>
            </header>
            <div className="local-toolbar">
                <input
                    hidden
                    ref={input}
                    type="file"
                    accept=".yml,.yaml,application/yaml,text/yaml"
                    aria-label={t("open")}
                    data-testid="local-file-input"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void openFile(file);
                    }}
                />
                <button
                    type="button"
                    className="local-command"
                    disabled={state.busy}
                    onClick={() => input.current?.click()}
                >
                    <FileUp size={16} />
                    {t("open")}
                </button>
                {config && (
                    <>
                        {icon(
                            t("undo"),
                            <Undo2 size={16} />,
                            state.undo,
                            !state.session?.past.length,
                            "local-undo",
                        )}
                        {icon(
                            t("redo"),
                            <Redo2 size={16} />,
                            state.redo,
                            !state.session?.future.length,
                            "local-redo",
                        )}
                        <button
                            type="button"
                            className="local-command"
                            data-testid="local-export"
                            disabled={
                                state.busy ||
                                config.diagnostics.some(
                                    (issue) => !issue.warning,
                                )
                            }
                            onClick={() => void state.exportCurrent()}
                        >
                            <Download size={16} />
                            {t("export")}
                        </button>
                        {icon(
                            t("close"),
                            <X size={16} />,
                            () => void closeFile(),
                            state.busy,
                            "local-close",
                        )}
                    </>
                )}
            </div>
            {state.error && (
                <p role="alert" className="local-error">
                    {t(`errors.${state.error}`)}
                </p>
            )}
            {config && (
                <>
                    <p className="local-file-name">{config.name}</p>
                    <p className="local-notice">
                        {t(
                            config.kind === "config"
                                ? "restartWarning"
                                : "accessWarning",
                        )}
                    </p>
                    <div className="local-fields">
                        {config.kind === "config" ? (
                            <>
                                <h4>{t("catalog")}</h4>
                                {field(
                                    ["catalog", "default-namespace"],
                                    t("namespace"),
                                )}
                                {field(["locale", "default"], t("locale"))}
                                {field(
                                    ["presentation", "default-layout"],
                                    t("defaultLayout"),
                                )}
                                {field(
                                    ["presentation", "default-theme"],
                                    t("defaultTheme"),
                                )}
                                <h4>{t("listener")}</h4>
                                {legacy ? (
                                    <button
                                        type="button"
                                        className="local-command"
                                        disabled={!config.editable}
                                        onClick={async () => {
                                            if (
                                                (await confirmAction({
                                                    title: t("migrateTitle"),
                                                    message:
                                                        t("migrateMessage"),
                                                    accept: t("migrate"),
                                                })) &&
                                                currentId ===
                                                    useLocalOperationsStore.getState()
                                                        .session?.id
                                            )
                                                state.edit(
                                                    ["editor"],
                                                    {
                                                        enabled: false,
                                                        "bind-host": "0.0.0.0",
                                                        port: 18087,
                                                        token: "",
                                                        "allowed-origins": [],
                                                    },
                                                    { discrete: true },
                                                );
                                        }}
                                    >
                                        {t("migrate")}
                                    </button>
                                ) : (
                                    <>
                                        <label className="settings-row">
                                            <span>{t("enabled")}</span>
                                            <input
                                                type="checkbox"
                                                role="switch"
                                                checked={
                                                    value([
                                                        "editor",
                                                        "enabled",
                                                    ]) === true
                                                }
                                                disabled={
                                                    !canEdit([
                                                        "editor",
                                                        "enabled",
                                                    ])
                                                }
                                                data-testid="local-editor-enabled"
                                                onChange={(event) =>
                                                    state.edit(
                                                        ["editor", "enabled"],
                                                        event.target.checked,
                                                        { discrete: true },
                                                    )
                                                }
                                            />
                                        </label>
                                        {field(
                                            ["editor", "bind-host"],
                                            t("host"),
                                        )}
                                        {field(["editor", "port"], t("port"), {
                                            numeric: true,
                                        })}
                                        {field(
                                            ["editor", "token"],
                                            t("token"),
                                            { secret: true },
                                        )}
                                        {list(
                                            ["editor", "allowed-origins"],
                                            t("origins"),
                                        )}
                                    </>
                                )}
                                <h4>{t("pendingName")}</h4>
                                {field(
                                    ["canonical-item", "pending-name", "text"],
                                    t("template"),
                                    { multiline: true },
                                )}
                                <fieldset className="local-colors">
                                    <legend>{t("color")}</legend>
                                    {Object.entries(NAMED_COLORS).map(
                                        ([name, color]) => (
                                            <button
                                                type="button"
                                                key={name}
                                                aria-label={t(`colors.${name}`)}
                                                data-tooltip={t(
                                                    `colors.${name}`,
                                                )}
                                                aria-pressed={
                                                    value([
                                                        "canonical-item",
                                                        "pending-name",
                                                        "color",
                                                    ]) === name
                                                }
                                                disabled={
                                                    !canEdit([
                                                        "canonical-item",
                                                        "pending-name",
                                                        "color",
                                                    ])
                                                }
                                                style={{
                                                    backgroundColor: color,
                                                }}
                                                onClick={() =>
                                                    state.edit(
                                                        [
                                                            "canonical-item",
                                                            "pending-name",
                                                            "color",
                                                        ],
                                                        name,
                                                        { discrete: true },
                                                    )
                                                }
                                            />
                                        ),
                                    )}
                                </fieldset>
                            </>
                        ) : (
                            <>
                                <h4>{t("defaults")}</h4>
                                {API_ACTIONS.map((action) =>
                                    select(
                                        ["api", "defaults", action],
                                        t(`actions.${action}`),
                                        [
                                            "allow",
                                            "deny",
                                            ...(action === "read-data"
                                                ? ["schema-policy"]
                                                : []),
                                        ],
                                    ),
                                )}
                                <h4>{t("grants")}</h4>
                                {Array.isArray(grants) &&
                                    grants.map((grant, index) => (
                                        <fieldset
                                            className="local-grant"
                                            key={index}
                                        >
                                            <legend>
                                                {t("grant", {
                                                    index: index + 1,
                                                })}
                                            </legend>
                                            <div className="local-grant-actions">
                                                {icon(
                                                    t("deleteGrant"),
                                                    <Trash2 size={15} />,
                                                    () => {
                                                        void confirmAction({
                                                            title: t(
                                                                "deleteGrant",
                                                            ),
                                                            message:
                                                                t(
                                                                    "deleteGrantMessage",
                                                                ),
                                                            accept: t("delete"),
                                                        }).then((accepted) => {
                                                            if (
                                                                accepted &&
                                                                currentId ===
                                                                    useLocalOperationsStore.getState()
                                                                        .session
                                                                        ?.id &&
                                                                configurationValue(
                                                                    useLocalOperationsStore.getState()
                                                                        .session!
                                                                        .configuration,
                                                                    [
                                                                        "api",
                                                                        "grants",
                                                                        index,
                                                                    ],
                                                                ) === grant
                                                            )
                                                                state.edit(
                                                                    [
                                                                        "api",
                                                                        "grants",
                                                                        index,
                                                                    ],
                                                                    undefined,
                                                                    {
                                                                        remove: true,
                                                                        discrete: true,
                                                                    },
                                                                );
                                                        });
                                                    },
                                                    !config.editable,
                                                )}
                                            </div>
                                            {field(
                                                [
                                                    "api",
                                                    "grants",
                                                    index,
                                                    "plugin",
                                                ],
                                                t("plugin"),
                                            )}
                                            <fieldset className="local-actions">
                                                <legend>
                                                    {t("actionsLabel")}
                                                </legend>
                                                {API_ACTIONS.map((action) => {
                                                    const path = [
                                                        "api",
                                                        "grants",
                                                        index,
                                                        "actions",
                                                    ];
                                                    const raw = value(path);
                                                    const selected =
                                                        Array.isArray(raw)
                                                            ? raw
                                                            : [];
                                                    return (
                                                        <label key={action}>
                                                            <input
                                                                type="checkbox"
                                                                checked={selected.includes(
                                                                    action,
                                                                )}
                                                                disabled={
                                                                    !config.editable ||
                                                                    !(
                                                                        grant instanceof
                                                                        Map
                                                                    ) ||
                                                                    (raw !==
                                                                        undefined &&
                                                                        !Array.isArray(
                                                                            raw,
                                                                        ))
                                                                }
                                                                onChange={(
                                                                    event,
                                                                ) =>
                                                                    toggleAction(
                                                                        path,
                                                                        action,
                                                                        event
                                                                            .target
                                                                            .checked,
                                                                    )
                                                                }
                                                            />
                                                            {t(
                                                                `actions.${action}`,
                                                            )}
                                                        </label>
                                                    );
                                                })}
                                            </fieldset>
                                            {[
                                                "item-namespaces",
                                                "data-namespaces",
                                                "viewer-fact-namespaces",
                                            ].map((key) =>
                                                list(
                                                    [
                                                        "api",
                                                        "grants",
                                                        index,
                                                        key,
                                                    ],
                                                    t(key),
                                                ),
                                            )}
                                        </fieldset>
                                    ))}
                                <button
                                    type="button"
                                    className="local-command"
                                    data-testid="local-add-grant"
                                    disabled={
                                        !config.editable ||
                                        !Array.isArray(grants)
                                    }
                                    onClick={() =>
                                        appendEntry(["api", "grants"], {
                                            plugin: "",
                                            actions: [],
                                            "item-namespaces": [],
                                            "data-namespaces": [],
                                            "viewer-fact-namespaces": [],
                                        })
                                    }
                                >
                                    <Plus size={15} />
                                    {t("addGrant")}
                                </button>
                            </>
                        )}
                    </div>
                    {config.diagnostics.length > 0 && (
                        <ul
                            className="local-diagnostics"
                            aria-label={t("diagnosticsLabel")}
                        >
                            {config.diagnostics.map((issue, index) => (
                                <li
                                    key={index}
                                    className={
                                        issue.warning
                                            ? "local-warning"
                                            : "local-error"
                                    }
                                >
                                    <code>{issue.path}</code>
                                    <span>
                                        {t(`diagnostics.${issue.code}`)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </section>
    );
}
