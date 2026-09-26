use fixture_rust_quote::{calculate_quote, format_quote, parse_order};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_order(&args)
        .and_then(|(unit, quantity, discount)| calculate_quote(unit, quantity, discount))
    {
        Ok(quote) => println!("{}", format_quote(&quote)),
        Err(reason) => {
            eprintln!("error: {reason}");
            std::process::exit(2);
        }
    }
}
