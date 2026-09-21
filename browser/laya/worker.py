"""Local, version-pinned decision worker. JSON lines on stdout; diagnostics on stderr."""
import contextlib
import json
import os
import sys

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("USE_FLAX", "0")
REPO = "convaiinnovations/laya-multilingual"
REVISION = "052592a15d198d9ad47da779604259b10b47b7aa"


def load_agent(download=False):
    import laya
    import torch
    from huggingface_hub import snapshot_download

    torch.set_num_threads(min(4, os.cpu_count() or 1))
    directory = snapshot_download(
        REPO, revision=REVISION, local_files_only=not download,
        allow_patterns=["model.safetensors", "rl_agent_config.json", "encoder/*", "tokenizer/*"],
    )
    agent = laya.load(directory, device="cpu")
    agent.cfg["max_len"] = 1024
    agent.cfg["head_max_len"] = 512
    return agent


def predict(agent, request):
    state, questions = request["state"], request["questions"]
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 20:
        raise ValueError("Invalid question count")
    # Reject overflow rather than let build_sequence silently remove important options/state.
    from laya.common import render_options
    for question in questions.values():
        q = agent._to_internal(question)
        options = render_options(q)
        if not 2 <= len(options) <= 8:
            raise ValueError("Choose between 2 and 8 candidates per question")
        lengths = [len(agent.tok(" " + value, add_special_tokens=False)["input_ids"]) for value in options]
        head = len(agent.tok(f"choice question: {q['ins']}", add_special_tokens=False)["input_ids"])
        body = len(agent.tok(json.dumps(state, ensure_ascii=False), add_special_tokens=False)["input_ids"])
        if max(lengths) > 48 or head + sum(lengths) + len(options) > 512 or head + sum(lengths) + len(options) + body + 4 > 1024:
            raise ValueError("Laya context budget exceeded; ask Pi to shorten the step goal or page context")
    return agent.predict(state, questions)


def main():
    with contextlib.redirect_stdout(sys.stderr):
        agent = load_agent(download="--download" in sys.argv)
    if "--download" in sys.argv:
        print(json.dumps({"ready": True, "model": REPO, "revision": REVISION}))
        return
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 128 * 1024:
                raise ValueError("Request too large")
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = predict(agent, request)
            print(json.dumps({"id": request["id"], "result": result}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"id": request.get("id"), "error": str(error)[:500]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
