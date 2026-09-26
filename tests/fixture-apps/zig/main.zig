const std = @import("std");
const quote = @import("quote.zig");

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    if (args.len != 4) {
        std.debug.print("usage: zig run main.zig -- UNIT_CENTS QUANTITY DISCOUNT_BPS\n", .{});
        std.process.exit(2);
    }

    const unit_cents = std.fmt.parseInt(u32, args[1], 10) catch return invalid();
    const quantity = std.fmt.parseInt(u32, args[2], 10) catch return invalid();
    const discount_bps = std.fmt.parseInt(u32, args[3], 10) catch return invalid();
    const result = quote.calculate(unit_cents, quantity, discount_bps) catch return invalid();

    try std.io.getStdOut().writer().print(
        "subtotal_cents={} discount_cents={} total_cents={}\n",
        .{ result.subtotal_cents, result.discount_cents, result.total_cents },
    );
}

fn invalid() void {
    std.debug.print("invalid order: expected unit_cents=0..100000 quantity=1..100 discount_bps=0..10000\n", .{});
    std.process.exit(2);
}
