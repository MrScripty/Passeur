import { useState } from "react";
import { LineItem } from "./LineItem.js";
import { formatCents, quoteOrder, UNIT_PRICE_CENTS } from "./quote.js";

export default function QuoteForm({ initialQuantity = "2", initialDelivery = false }) {
  const [quantity, setQuantity] = useState(initialQuantity);
  const [delivery, setDelivery] = useState(initialDelivery);
  const quote = quoteOrder(quantity, delivery);

  return <main>
    <h1>React JSX order quote</h1>
    <p>Notebook price: {formatCents(UNIT_PRICE_CENTS)} each</p>
    <label htmlFor="jsx-quantity">Quantity</label>
    <input id="jsx-quantity" type="number" min="0" max="20" step="1" value={quantity}
      onChange={event => setQuantity(event.target.value)} />
    <label htmlFor="jsx-delivery">
      <input id="jsx-delivery" type="checkbox" checked={delivery}
        onChange={event => setDelivery(event.target.checked)} /> Add delivery
    </label>
    {"error" in quote ? <p role="alert">{quote.error}</p> : <section aria-label="Quote" aria-live="polite">
      <ul>
        <LineItem label="Merchandise" cents={quote.merchandiseCents} />
        <LineItem label="Delivery" cents={quote.deliveryCents} />
      </ul>
      <p>Total: <output>{formatCents(quote.totalCents)}</output></p>
    </section>}
  </main>;
}
