import { Text, type Component } from "@earendil-works/pi-tui";

/**
 * The single pi-tui touchpoint for Orca's custom rendering. The transcript entry
 * renderer (`registerEntryRenderer` for delegation records) and the delegate
 * tool's `renderResult` both delegate their content to PURE line functions
 * (`renderRecordLines`, `delegateResultLines`) and hand the result here to be
 * wrapped in a component. Keeping the only `new Text(...)` here means the pure
 * renderers stay unit-testable as `string[]` without a TUI, and nothing else in
 * the codebase depends on pi-tui.
 */
export function linesComponent(lines: string[]): Component {
  return new Text(lines.join("\n"));
}
