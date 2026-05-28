"""Hello world over TigerFS.

TigerFS turns Postgres into a transactional filesystem. This script reads a
markdown note that was written via the mount, writes a new one through the
same path, and lists the directory — proving the filesystem-as-API model
end-to-end from a plain Python program.
"""

from pathlib import Path

NOTES = Path("/mnt/db/notes")

hello = NOTES / "hello.md"
print(f"[hello.py] reading {hello}:")
print("---8<---")
print(hello.read_text(), end="")
print("--->8---")

new = NOTES / "from-python.md"
new.write_text(
    "---\n"
    "title: Greetings from Python\n"
    "author: python\n"
    "---\n"
    "# Hello from inside the sandbox\n"
    "\n"
    "This file was written by hello.py through the TigerFS mount.\n"
    "It now lives as a row in the Postgres `tigerfs.notes` table.\n"
)
print(f"[hello.py] wrote {new}")

entries = sorted(p.name for p in NOTES.iterdir())
print(f"[hello.py] {NOTES} now contains: {entries}")
