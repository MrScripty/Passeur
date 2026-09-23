pub struct Packet<T = i64> { value: Option<T> }
pub trait Read { fn read(&self, len: usize) -> usize; }
pub fn transform(x: i32) -> i32 { x + 2 }
