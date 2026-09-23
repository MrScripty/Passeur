use core::fmt::Display;

pub struct Record<T = u16> { pub data: Option<T> }
pub enum Choice { A(i32), B(u8), C { n: u8 } }
pub type Label<'a> = &'a [u8];
pub trait Work { fn execute(&self, input: i32) -> i32; }
pub struct Worker;
impl Work for Worker { fn execute(&self, input: i32) -> i32 { input } }
pub async fn fetch<'a, T>(mut source: T, limit: usize) -> usize
where T: Iterator<Item = &'a str> + Clone { source.next().map_or(limit, |s| s.len()) }
pub unsafe extern "C" fn abi(x: i32) -> i32 { x }
pub fn r#gen() -> i32 { 2 }
macro_rules! token { () => { 2 } }
