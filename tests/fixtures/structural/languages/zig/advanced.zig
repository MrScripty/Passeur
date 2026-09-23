// é 😀
pub fn load(reader: anytype) ![]const u8 {
    return error.NotFound;
}

pub fn copy(noalias dst: []u8, noalias src: []const u8) void {}

pub fn select(comptime T: type, ptr: *[4]T) ?T {
    return null;
}
