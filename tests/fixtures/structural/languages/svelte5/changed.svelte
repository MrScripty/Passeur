<!-- café 😀 -->
<script context = "module">function shared(x = 1) { return x; }</script>
<script lang="ts">export function hello(name: string): string { return name; } let {title = "welcome"}: Props = $props();</script>
{#snippet card(item: string = "goodbye")}<strong>{item}</strong>{/snippet}
{@render card("goodbye" as string)}
{#if title}<span>{title}</span>{/if}
{#each items as item}<i>{item}</i>{/each}
<style>.x { color: blue }</style>
