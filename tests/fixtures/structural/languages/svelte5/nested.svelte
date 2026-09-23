{#snippet outer()}
  {#snippet row(item)}<i>{item}</i>{/snippet}
  {@render row(1)}
{/snippet}
{#snippet row(item)}<b>{item}</b>{/snippet}
