"""Load the persisted LlamaIndex store from /root/storage and answer a
question against it. The question is passed as argv[1]. Prints a JSON
envelope with the answer plus the top-k retrieved chunks so the host can
verify grounding.
"""

import json
import os
import sys

from llama_index.core import (
    Settings,
    StorageContext,
    load_index_from_storage,
)
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.llms.openai_like import OpenAILike

STORAGE = "/root/storage"
EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def main() -> int:
    question = sys.argv[1] if len(sys.argv) > 1 else "What is createos-sandbox?"

    api_base = os.environ["OPENAI_API_URL"]
    api_key = os.environ["OPENAI_API_KEY"]
    model = os.environ["OPENAI_MODEL"]

    Settings.embed_model = HuggingFaceEmbedding(model_name=EMBED_MODEL)
    Settings.llm = OpenAILike(
        model=model,
        api_base=api_base,
        api_key=api_key,
        is_chat_model=True,
        is_function_calling_model=False,
        max_tokens=512,
        temperature=0.0,
        timeout=120,
    )

    storage = StorageContext.from_defaults(persist_dir=STORAGE)
    index = load_index_from_storage(storage)
    qe = index.as_query_engine(similarity_top_k=3)

    resp = qe.query(question)
    sources = []
    for node in resp.source_nodes:
        sources.append(
            {
                "score": float(node.score) if node.score is not None else None,
                "file": node.node.metadata.get("file_name"),
                "excerpt": node.node.get_content()[:240].replace("\n", " "),
            }
        )
    out = {"question": question, "answer": str(resp), "sources": sources}
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
