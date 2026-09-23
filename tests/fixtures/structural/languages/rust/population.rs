use core::fmt::Debug;

pub struct Record<T = u8> { pub data: T }
pub enum Choice { A, B(u8), C { n: u8 } }
pub type Label<'a> = &'a str;
pub trait Work { fn execute(&self, input: i32) -> i32; }
pub struct Worker;
impl Work for Worker { fn execute(&self, input: i32) -> i32 { input } }
pub async fn fetch<'a, T>(mut source: T) -> usize
where T: Iterator<Item = &'a str> + Clone { source.next().map_or(0, |s| s.len()) }
pub unsafe extern "C" fn abi(x: i32) -> i32 { x }
pub fn r#gen() -> i32 { 1 }
macro_rules! token { () => { 1 } }
