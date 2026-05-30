"""Build a LlamaIndex VectorStoreIndex from /root/corpus and persist it to
/root/storage. Embeddings run locally (sentence-transformers); no remote
embedding API is required.
"""

import os
import sys
import time

from llama_index.core import (
    Settings,
    SimpleDirectoryReader,
    StorageContext,
    VectorStoreIndex,
)
from llama_index.embeddings.huggingface import HuggingFaceEmbedding

CORPUS = "/root/corpus"
STORAGE = "/root/storage"
EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def main() -> int:
    t0 = time.time()
    Settings.embed_model = HuggingFaceEmbedding(model_name=EMBED_MODEL)
    # Chat model isn't needed for indexing — disable the default OpenAI
    # probe so this script never reaches out to the LLM endpoint.
    Settings.llm = None
    Settings.chunk_size = 256
    Settings.chunk_overlap = 32

    docs = SimpleDirectoryReader(CORPUS).load_data()
    print(f"loaded {len(docs)} documents from {CORPUS}")

    storage = StorageContext.from_defaults()
    index = VectorStoreIndex.from_documents(docs, storage_context=storage)
    os.makedirs(STORAGE, exist_ok=True)
    index.storage_context.persist(persist_dir=STORAGE)

    nodes = len(index.docstore.docs)
    print(f"indexed {nodes} nodes -> {STORAGE} in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
