local quote = require("quote")

local regular = assert(quote.calculate(1200, 2, 500))
assert(quote.format(regular) == "subtotal_cents=2400 discount_cents=120 total_cents=2280")

local free = assert(quote.calculate(0, 1, 10000))
assert(free.total_cents == 0)

local rounded = assert(quote.calculate(101, 1, 333))
assert(rounded.discount_cents == 3 and rounded.total_cents == 98)

assert(quote.calculate(-1, 1, 0) == nil)
assert(quote.calculate(1, 0, 0) == nil)
assert(quote.calculate(1, 1, 10001) == nil)
assert(quote.calculate(1.5, 1, 0) == nil)

print("ok")
