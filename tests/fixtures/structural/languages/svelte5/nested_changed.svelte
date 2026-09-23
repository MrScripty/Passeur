{#snippet outer()}
  {#snippet row(item)}<strong>{item}</strong>{/snippet}
  {@render row(1)}
{/snippet}
{#snippet row(item)}<b>{item}</b>{/snippet}
