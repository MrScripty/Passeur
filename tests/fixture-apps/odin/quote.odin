package main

Quote :: struct {
	subtotal_cents: int,
	discount_cents: int,
	total_cents:    int,
}

calculate_quote :: proc(unit_cents, quantity, discount_bps: int) -> (result: Quote, ok: bool) {
	if unit_cents < 0 || unit_cents > 100000 || quantity < 1 || quantity > 100 ||
	   discount_bps < 0 || discount_bps > 10000 {
		return Quote{}, false
	}

	subtotal := unit_cents * quantity
	discount := subtotal * discount_bps / 10000
	return Quote{subtotal, discount, subtotal - discount}, true
}

test_quote :: proc() -> bool {
	regular, ok := calculate_quote(1200, 2, 500)
	if !ok || regular.subtotal_cents != 2400 || regular.discount_cents != 120 ||
	   regular.total_cents != 2280 {
		return false
	}
	free, free_ok := calculate_quote(0, 1, 10000)
	if !free_ok || free.total_cents != 0 {
		return false
	}
	rounded, rounded_ok := calculate_quote(101, 1, 333)
	if !rounded_ok || rounded.discount_cents != 3 {
		return false
	}
	_, bad_unit := calculate_quote(-1, 1, 0)
	_, bad_quantity := calculate_quote(1, 0, 0)
	_, bad_discount := calculate_quote(1, 1, 10001)
	return !bad_unit && !bad_quantity && !bad_discount
}
