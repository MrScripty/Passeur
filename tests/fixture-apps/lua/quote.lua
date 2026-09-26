local quote = {}

local function whole_in_range(value, minimum, maximum)
  return type(value) == "number"
    and math.type(value) == "integer"
    and value >= minimum
    and value <= maximum
end

function quote.calculate(unit_cents, quantity, discount_bps)
  if not whole_in_range(unit_cents, 0, 100000)
      or not whole_in_range(quantity, 1, 100)
      or not whole_in_range(discount_bps, 0, 10000) then
    return nil, "invalid order: expected unit_cents=0..100000 quantity=1..100 discount_bps=0..10000"
  end

  local subtotal = unit_cents * quantity
  local discount = subtotal * discount_bps // 10000
  return {
    subtotal_cents = subtotal,
    discount_cents = discount,
    total_cents = subtotal - discount,
  }
end

function quote.format(result)
  return string.format(
    "subtotal_cents=%d discount_cents=%d total_cents=%d",
    result.subtotal_cents,
    result.discount_cents,
    result.total_cents
  )
end

return quote
