def is_prime(n):
    if n < 2:
        return False
    for i in range(2, int(n**0.5) + 1):
        if n % i == 0:
            return False
    return True

def fibonacci(count):
    fibs = []
    a, b = 0, 1
    for _ in range(count):
        fibs.append(a)
        a, b = b, a + b
    return fibs

fibs = fibonacci(20)
print(f"First 20 Fibonacci numbers: {fibs}\n")
print("Prime Fibonacci numbers:")
for i, f in enumerate(fibs):
    if is_prime(f):
        print(f"  index {i}: {f}")
