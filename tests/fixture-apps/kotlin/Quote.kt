data class Quote(
    val subtotalCents: Long,
    val discountCents: Long,
    val totalCents: Long,
) {
    fun display(): String =
        "subtotal_cents=$subtotalCents discount_cents=$discountCents total_cents=$totalCents"
}

fun calculateQuote(unitCents: Long, quantity: Int, discountBps: Int): Quote {
    require(unitCents in 0L..100_000L) { "unit_cents must be 0..100000" }
    require(quantity in 1..100) { "quantity must be 1..100" }
    require(discountBps in 0..10_000) { "discount_bps must be 0..10000" }

    val subtotal = unitCents * quantity
    val discount = subtotal * discountBps / 10_000L
    return Quote(subtotal, discount, subtotal - discount)
}
