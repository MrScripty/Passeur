// A standalone .kts route with the same order arithmetic as the JVM entrypoint.
fun scriptQuote(unitCents: Long, quantity: Int, discountBps: Int): String {
    require(unitCents in 0L..100_000L && quantity in 1..100 && discountBps in 0..10_000)
    val subtotal = unitCents * quantity
    val discount = subtotal * discountBps / 10_000L
    return "subtotal_cents=$subtotal discount_cents=$discount total_cents=${subtotal - discount}"
}

require(args.size == 3) { "usage: kotlinc -script quote.kts -- UNIT_CENTS QUANTITY DISCOUNT_BPS" }
val unitCents = args[0].toLong()
val quantity = args[1].toInt()
val discountBps = args[2].toInt()
println(scriptQuote(unitCents, quantity, discountBps))
