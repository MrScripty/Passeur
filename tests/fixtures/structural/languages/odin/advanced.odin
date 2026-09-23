package main

pair :: proc(x: int) -> (first: int, ok: bool) {
    return x, true
}

identity :: proc($T: typeid, value: T) -> T {
    return value
}

copy :: proc(#no_alias src: []u8, #no_alias dst: []u8) {}
group :: proc{pair, identity}
Blob :: union { int, string }
@(deprecated="private note") tagged :: proc() {}
