import { formatCents } from "./quote.js";

// This file deliberately contains JSX despite its .js suffix; the fixture build selects its dialect.
export function LineItem({ label, cents }) {
  return <li><span>{label}</span>: <strong>{formatCents(cents)}</strong></li>;
}
