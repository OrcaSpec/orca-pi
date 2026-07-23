import { Button } from "../components/Button";

/** The web application shell. Owned by the `web` domain agent. */
export function App(): JSX.Element {
  return (
    <main>
      <h1>orca-dogfood</h1>
      <Button label="Get started" />
    </main>
  );
}
