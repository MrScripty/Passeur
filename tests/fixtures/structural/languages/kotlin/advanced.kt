package sample

// é 😀
interface Service {
    fun run(input: String): Boolean
}

class Holder private constructor(val value: String = "private") {
    constructor(size: Int): this(size.toString()) {}
}
