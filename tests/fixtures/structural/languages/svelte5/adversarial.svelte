<script lang="ts">let {title = "secret props"}: /* private type */ Props = $props();</script>
{#snippet malformed(item = secretValue + )}<b>{item}</b>{/snippet}
{#snippet commented(item /* confidential comment */ = "secret default")}<b>{item}</b>{/snippet}
{@render commented("shown")}
