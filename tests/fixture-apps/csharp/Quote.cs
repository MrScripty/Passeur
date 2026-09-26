namespace FixtureQuote;

public readonly struct Quote
{
    public Quote(long subtotalCents, long discountCents)
    {
        SubtotalCents = subtotalCents;
        DiscountCents = discountCents;
    }

    public long SubtotalCents { get; }
    public long DiscountCents { get; }
    public long TotalCents => SubtotalCents - DiscountCents;
}
