import { useState } from "react";
import { formatCents, quoteOrder, UNIT_PRICE_CENTS } from "./quote.js";

export default function QuoteForm({ initialQuantity = "2", initialDelivery = false }: {
  initialQuantity?: string;
  initialDelivery?: boolean;
}) {
  const [quantity, setQuantity] = useState(initialQuantity);
  const [delivery, setDelivery] = useState(initialDelivery);
  const quote = quoteOrder(quantity, delivery);

  return <main>
    <h1>React TSX order quote</h1>
    <p>Notebook price: {formatCents(UNIT_PRICE_CENTS)} each</p>
    <label htmlFor="tsx-quantity">Quantity</label>
    <input id="tsx-quantity" type="number" min="0" max="20" step="1" value={quantity}
      onChange={event => setQuantity(event.target.value)} />
    <label htmlFor="tsx-delivery">
      <input id="tsx-delivery" type="checkbox" checked={delivery}
        onChange={event => setDelivery(event.target.checked)} /> Add delivery
    </label>
    {"error" in quote ? <p role="alert">{quote.error}</p> : <section aria-label="Quote" aria-live="polite">
      <ul>
        <li>Merchandise: {formatCents(quote.merchandiseCents)}</li>
        <li>Delivery: {formatCents(quote.deliveryCents)}</li>
      </ul>
      <p>Total: <output>{formatCents(quote.totalCents)}</output></p>
    </section>}
  </main>;
}
