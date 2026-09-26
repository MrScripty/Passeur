# L06 Kotlin quote app

Source target: Kotlin/JVM command-line compiler (`kotlinc`, target 2.2.x),
JDK 17, and the Kotlin standard library bundled by `-include-runtime`.
The local Kotlin toolchain has not been qualified. Run from this directory in
a disposable copy; the JAR outputs belong only to that copy:

```sh
kotlinc -version
java -version
kotlinc Quote.kt Main.kt -include-runtime -d quote.jar
java -jar quote.jar 1200 2 500
kotlinc Quote.kt QuoteTest.kt -include-runtime -d quote-test.jar
java -jar quote-test.jar
kotlinc -script quote.kts -- 1200 2 500
```

Both sample entrypoints should print exactly:

```text
subtotal_cents=2400 discount_cents=120 total_cents=2280
```

The test JAR should print `ok`. Arguments are decimal integer unit cents
(0..100000), quantity (1..100), and discount basis points (0..10000).
Discount rounds down to whole cents. The JVM CLI exits 2 on invalid input.
`quote.kts` is a standalone script route with its own entrypoint; it is not a
dependency of the compiled app.
