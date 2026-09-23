// café 😀
const std = @import("std");
pub const Point = struct {
    x: i32,
    y: i32 = 5,

    pub fn move(self: *Point, dx: i32) void {
        self.x += dx;
    }
};

pub fn add(comptime T: type, x: T) T {
    return x + 1;
}

pub const Choice = enum { first, second };
