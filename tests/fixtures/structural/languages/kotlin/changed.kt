// café 😀
@Deprecated("internal note")
class Box<T>(val item: T) {
    fun get(fallback: T = this.item): T = fallback
    val current: T = item
}

fun String.repeat2(times: Int = 2): String {
    return this.repeat(times + 1)
}

typealias Names = List<String>
