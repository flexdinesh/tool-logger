import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { ViewerProvider } from "./state/viewer-provider.tsx";
import { applyTheme, preferredTheme } from "./theme.ts";
import "./styles.css";

applyTheme(preferredTheme());
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <ViewerProvider><App /></ViewerProvider>
  </StrictMode>,
);
