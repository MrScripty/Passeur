use std::process::Command;

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_fixture_rust_quote"))
        .args(args)
        .output()
        .expect("quote executable runs")
}

#[test]
fn normal_quote() {
    let output = run(&["1250", "3", "1000"]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "subtotal_cents=3750\ndiscount_cents=375\ntotal_cents=3375\n"
    );
}

#[test]
fn zero_quote() {
    let output = run(&["1250", "0", "1000"]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "subtotal_cents=0\ndiscount_cents=0\ntotal_cents=0\n"
    );
}

#[test]
fn invalid_quote() {
    let output = run(&["1250", "-1", "1000"]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "error: expected unsigned decimal integer\n"
    );
}

#[test]
fn boundary_quote() {
    let output = run(&["1000000", "1000", "0"]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "subtotal_cents=1000000000\ndiscount_cents=0\ntotal_cents=1000000000\n"
    );
}
