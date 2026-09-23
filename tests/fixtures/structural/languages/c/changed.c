// café before declarations
[[nodiscard]] int sum(int a, int b) { return a - b; }
int sum(int a, int b);
typedef int (*Handler)(int);
struct Point { int x; int y; };
#define FEATURE 1
#if FEATURE
int selected(void) { return 1; }
#else
int selected(void) { return 2; }
#endif
