// Installed CommonJS source is parsed as text and never executed by the probe.
function baseline(value) {
  return value + 1;
}
module.exports = { baseline };
