package main

import "core:fmt"
import "core:os"
import "core:strconv"

main :: proc() {
	if len(os.args) == 2 && os.args[1] == "--self-test" {
		if !test_quote() {
			fmt.eprintln("quote self-test failed")
			os.exit(1)
		}
		fmt.println("ok")
		return
	}
	if len(os.args) != 4 {
		fmt.eprintln("usage: odin run . -- UNIT_CENTS QUANTITY DISCOUNT_BPS")
		os.exit(2)
	}

	unit_cents, unit_ok := strconv.parse_int(os.args[1], 10)
	quantity, quantity_ok := strconv.parse_int(os.args[2], 10)
	discount_bps, discount_ok := strconv.parse_int(os.args[3], 10)
	if !unit_ok || !quantity_ok || !discount_ok {
		invalid_order()
	}

	result, ok := calculate_quote(unit_cents, quantity, discount_bps)
	if !ok {
		invalid_order()
	}
	fmt.printfln("subtotal_cents=%d discount_cents=%d total_cents=%d",
		result.subtotal_cents, result.discount_cents, result.total_cents)
}

invalid_order :: proc() {
	fmt.eprintln("invalid order: expected unit_cents=0..100000 quantity=1..100 discount_bps=0..10000")
	os.exit(2)
}
