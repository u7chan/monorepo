import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SpacesApp } from "./SpacesApp";
import { ThemeProvider } from "./theme/ThemeProvider";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <SpacesApp />
    </ThemeProvider>
  </StrictMode>,
);
