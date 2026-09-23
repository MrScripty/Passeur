pub struct Packet<T = i32> { value: T }
pub trait Read { fn read(&self, len: usize) -> usize; }
pub fn transform(x: i32) -> i32 { x + 1 }
