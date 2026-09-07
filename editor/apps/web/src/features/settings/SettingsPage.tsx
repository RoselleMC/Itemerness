import { useTranslation } from "react-i18next";
import { usePreferences } from "../../state/preferences.js";
import { describeContext } from "../../state/interface.js";

export function SettingsPage() {
    const { t } = useTranslation();
    const { autoSave, setAutoSave } = usePreferences();
    return (
        <section
            className="settings-section"
            data-testid="editor-settings"
            onContextMenu={(event) =>
                describeContext(event, {
                    label: t("sidebar.settings"),
                    items: [
                        {
                            id: "auto-save",
                            label: t("settings.autoSave"),
                            checked: autoSave,
                            run: () => setAutoSave(!autoSave),
                        },
                    ],
                })
            }
        >
            <h3>{t("settings.editing")}</h3>
            <label className="settings-row">
                <span>{t("settings.autoSave")}</span>
                <input
                    type="checkbox"
                    role="switch"
                    data-testid="auto-save-toggle"
                    checked={autoSave}
                    onChange={(event) => setAutoSave(event.target.checked)}
                />
            </label>
        </section>
    );
}
