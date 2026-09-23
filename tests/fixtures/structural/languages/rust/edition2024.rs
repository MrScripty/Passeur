unsafe extern "C" {
    pub fn native(x: i32) -> i32;
}

#[unsafe(no_mangle)]
pub extern "C" fn exported(x: i32) -> i32 {
    x
}
