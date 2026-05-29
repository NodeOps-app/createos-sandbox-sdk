from fastapi import FastAPI
from typing import Optional

app = FastAPI(title="FC FastAPI Demo")


@app.get("/")
def root():
    return {"status": "ok", "message": "FastAPI running in an FC sandbox"}


@app.get("/items/{item_id}")
def read_item(item_id: int, q: Optional[str] = None):
    return {"item_id": item_id, "q": q}
