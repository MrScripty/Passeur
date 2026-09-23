// Ω source
namespace N {
template<class T> requires Good<T>
auto choose(T value = T{}) -> T { return value; }
class Worker {
public:
  Worker(int id);
  ~Worker();
  auto run(int x) const -> int { return x + 2; }
  auto operator()(int x) -> int;
  static int operator[](int x) { return x; }
};
using Callback = int(*)(int);
}
