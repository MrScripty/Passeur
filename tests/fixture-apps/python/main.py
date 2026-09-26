import sys

from display import format_quote
from quote import calculate_quote, parse_order


def main(args: list[str]) -> int:
    try:
        order = parse_order(args)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(format_quote(calculate_quote(order)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
