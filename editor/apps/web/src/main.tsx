import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initialiseI18n } from "./i18n/index.js";
import "./styles.css";
import { initializeAppearance } from "./window/appearance.js";

initializeAppearance();
initialiseI18n();

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
