import { App } from "./app";

/** Entry point. Owned by `web`. */
export function mount(root: HTMLElement): void {
  root.dataset.app = "orca-dogfood-web";
  void App;
}
