# Unicode before declarations: é😀
@audit("private decorator argument")
async def run[T = private_type](a: int, /, b: str = changed_secret, *, flag: bool = True) -> str:
    return b + "!"

class Box[T = private_type]:
    value: T = private_field
    def get(self) -> T:
        return self.value

type Alias[T = private_type] = tuple[T]
