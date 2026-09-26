namespace FixtureQuote;

public static class QuoteCalculator
{
    public static bool TryCalculate(long quantity, long unitCents,
        long discountBps, out Quote quote)
    {
        quote = default;
        if (quantity is < 0 or > 1000 || unitCents is < 0 or > 1000000 ||
            discountBps is < 0 or > 10000)
        {
            return false;
        }

        long subtotalCents = quantity * unitCents;
        long discountCents = subtotalCents * discountBps / 10000;
        quote = new Quote(subtotalCents, discountCents);
        return true;
    }
}
