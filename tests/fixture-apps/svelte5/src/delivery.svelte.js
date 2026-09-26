export function createDeliverySelection(initialEnabled = false) {
  let enabled = $state(initialEnabled);
  return {
    get enabled() { return enabled; },
    toggle() { enabled = !enabled; }
  };
}

export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
