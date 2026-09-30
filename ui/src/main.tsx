import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

/**
 * Flute — cinematic capture of the real UI, used to produce demo footage.
 *
 * Two gates, both deliberate. It only mounts in a dev build AND only when the
 * page carries ?flute-preview=1, so a normal `bun tauri dev` session is
 * untouched. And it is imported lazily, so the production bundle that ships
 * inside the desktop app never pulls Flute in at all — a marketing tool has no
 * business in a binary users install.
 */
const fluteRequested =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).has("flute-preview");

const root = ReactDOM.createRoot(document.getElementById("root")!);

function mount(wrap: (node: React.ReactNode) => React.ReactNode = (n) => n) {
  root.render(<React.StrictMode>{wrap(<App />)}</React.StrictMode>);
}

if (fluteRequested) {
  import("../../src/flute/ProjectPreview.jsx")
    .then(({ FluteProjectPreview }) => {
      mount((node) => (
        <FluteProjectPreview enabled>{node}</FluteProjectPreview>
      ));
    })
    .catch((error) => {
      // Never silently fall back to a plain render: if the preview was asked
      // for and could not load, that is the thing worth knowing.
      console.error(
        "Flute preview was requested but failed to load. Rendering the app without it.",
        error,
      );
      mount();
    });
} else {
  mount();
}
