import "./tokens.css";

export interface ButtonProps {
  label: string;
}

/** Reusable button. Owned by `design-system` (nested inside apps/web/). */
export function Button({ label }: ButtonProps): JSX.Element {
  return <button className="ds-button">{label}</button>;
}
