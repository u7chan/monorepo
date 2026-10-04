import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ConfirmProvider } from "./components/ConfirmProvider";
import { ThemeProvider } from "./theme/ThemeProvider";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ThemeProvider>
  </StrictMode>,
);
