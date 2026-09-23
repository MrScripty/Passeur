// emoji 😀 before declaration
namespace N;
public partial record Box<T>(T Value) where T : class {
    public Box(int seed = 2) { }
    [Route("private")]
    public int Run(ref int x, int offset = 3) => x + offset;
    public string Name { get; init; } = "secret";
    public int Count { get => field; set => field = value; }
    public int Seed = 17;
}
