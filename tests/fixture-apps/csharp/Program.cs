using System.Globalization;
using FixtureQuote;

internal static class Program
{
    private static bool ParseInteger(string text, out long value) =>
        long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture,
            out value);

    private static int Main(string[] args)
    {
        if (args.Length != 3)
        {
            Console.Error.WriteLine("error: expected quantity unit_cents discount_bps");
            return 2;
        }

        if (!ParseInteger(args[0], out long quantity) ||
            !ParseInteger(args[1], out long unitCents) ||
            !ParseInteger(args[2], out long discountBps) ||
            !QuoteCalculator.TryCalculate(quantity, unitCents, discountBps,
                out Quote quote))
        {
            Console.Error.WriteLine("error: invalid quote input");
            return 2;
        }

        Console.WriteLine(FormattableString.Invariant(
            $"subtotal_cents={quote.SubtotalCents} discount_cents={quote.DiscountCents} total_cents={quote.TotalCents}"));
        return 0;
    }
}
