fun main() {
    check(calculateQuote(1200, 2, 500).display() ==
        "subtotal_cents=2400 discount_cents=120 total_cents=2280")
    check(calculateQuote(0, 1, 10_000).totalCents == 0L)
    check(calculateQuote(101, 1, 333).discountCents == 3L)
    check(runCatching { calculateQuote(-1, 1, 0) }.isFailure)
    check(runCatching { calculateQuote(1, 0, 0) }.isFailure)
    check(runCatching { calculateQuote(1, 1, 10_001) }.isFailure)
    println("ok")
}
