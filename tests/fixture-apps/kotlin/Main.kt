import kotlin.system.exitProcess

fun main(args: Array<String>) {
    if (args.size != 3) {
        System.err.println("usage: java -jar quote.jar UNIT_CENTS QUANTITY DISCOUNT_BPS")
        exitProcess(2)
    }

    val unitCents = args[0].toLongOrNull()
    val quantity = args[1].toIntOrNull()
    val discountBps = args[2].toIntOrNull()
    if (unitCents == null || quantity == null || discountBps == null) {
        System.err.println("invalid order: arguments must be decimal integers")
        exitProcess(2)
    }

    try {
        println(calculateQuote(unitCents, quantity, discountBps).display())
    } catch (problem: IllegalArgumentException) {
        System.err.println("invalid order: ${problem.message}")
        exitProcess(2)
    }
}
