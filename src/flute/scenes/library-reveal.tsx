import { Surface } from "@webprodigies/flute";
import App from "../../../ui/src/App";
import { installTauriStub } from "../tauri-stub";

/**
 * The real Track2Mix window, placed in the void as spatial material.
 *
 * The stub is installed before React renders so the app's own data hooks
 * resolve normally — this is the shipped component tree, not a mock of it.
 */
installTauriStub();

export default function LibraryReveal() {
  return (
    <Surface id="app" style={{ width: 1400, height: 900 }}>
      <App />
    </Surface>
  );
}
