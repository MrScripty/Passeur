<script lang="ts">
  import { createDeliverySelection, formatCents } from "./delivery.svelte.js";
  import { quoteOrder, UNIT_PRICE_CENTS } from "./quote.svelte.ts";

  let { initialQuantity = "2", initialDelivery = false } = $props();
  let quantity = $state(initialQuantity);
  const delivery = createDeliverySelection(initialDelivery);
  let quote = $derived(quoteOrder(quantity, delivery.enabled));
</script>

<main>
  <h1>Svelte 5 order quote</h1>
  <p>Notebook price: {formatCents(UNIT_PRICE_CENTS)} each</p>
  <label for="quantity">Quantity</label>
  <input id="quantity" type="text" inputmode="numeric" pattern="[0-9]*" bind:value={quantity} />
  <button type="button" aria-pressed={delivery.enabled} onclick={() => delivery.toggle()}>
    {delivery.enabled ? "Remove delivery" : "Add delivery"}
  </button>
  {#if "error" in quote}
    <p role="alert">{quote.error}</p>
  {:else}
    <section aria-label="Quote" aria-live="polite">
      <ul>
        <li>Merchandise: {formatCents(quote.merchandiseCents)}</li>
        <li>Delivery: {formatCents(quote.deliveryCents)}</li>
      </ul>
      <p>Total: <output>{formatCents(quote.totalCents)}</output></p>
    </section>
  {/if}
</main>
