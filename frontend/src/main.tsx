import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { IconSheet } from "./dev/IconSheet";

// `#icons` opens the icon contact sheet instead of the app. See dev/IconSheet.
const Root = window.location.hash === "#icons" ? IconSheet : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
