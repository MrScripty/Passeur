package main
// café 😀
import "core:fmt"

Point :: struct {
    x: int,
    y: int,
}

add :: proc(x: int, y: int = 2) -> int {
    return x + y
}

(Point) .move :: proc(self: ^Point, dx: int) {
    self.x += dx
}

Id :: int
Color :: enum { Red, Blue }
