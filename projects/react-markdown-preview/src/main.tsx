import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// import "./index.css";
// import App from './App.tsx'
import { Preview } from "./Preview.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
