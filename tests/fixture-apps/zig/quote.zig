const std = @import("std");

pub const Quote = struct {
    subtotal_cents: u64,
    discount_cents: u64,
    total_cents: u64,
};

pub fn calculate(unit_cents: u32, quantity: u32, discount_bps: u32) error{InvalidOrder}!Quote {
    if (unit_cents > 100_000 or quantity < 1 or quantity > 100 or discount_bps > 10_000) {
        return error.InvalidOrder;
    }

    const subtotal: u64 = @as(u64, unit_cents) * quantity;
    const discount: u64 = subtotal * discount_bps / 10_000;
    return .{
        .subtotal_cents = subtotal,
        .discount_cents = discount,
        .total_cents = subtotal - discount,
    };
}

test "normal, zero, rounding, and invalid orders" {
    const regular = try calculate(1200, 2, 500);
    try std.testing.expectEqual(@as(u64, 2400), regular.subtotal_cents);
    try std.testing.expectEqual(@as(u64, 120), regular.discount_cents);
    try std.testing.expectEqual(@as(u64, 2280), regular.total_cents);

    const free = try calculate(0, 1, 10_000);
    try std.testing.expectEqual(@as(u64, 0), free.total_cents);

    const rounded = try calculate(101, 1, 333);
    try std.testing.expectEqual(@as(u64, 3), rounded.discount_cents);
    try std.testing.expectError(error.InvalidOrder, calculate(1, 0, 0));
    try std.testing.expectError(error.InvalidOrder, calculate(1, 1, 10_001));
    try std.testing.expectError(error.InvalidOrder, calculate(100_001, 1, 0));
}
