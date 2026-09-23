"""Supervised browser-search fine-tune of Laya on a single CUDA GPU.

Usage: python eval/train-laya-search.py TRAIN_JSONL BASE_CHECKPOINT OUTPUT_DIR
LAYA_SEARCH_TRAIN_ENCODER=1 also updates the encoder with gradient checkpointing.
The output is a normal Laya checkpoint that browser/laya/worker.py can load.
"""
import json
import hashlib
import os
import random
import shutil
import sys
from pathlib import Path

import torch
from laya.common import QTYPES, build_sequence, render_options
from safetensors.torch import save_file


def read_items(path, agent):
    items = []
    with open(path, encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            q = agent._to_internal(row["question"])
            options = list(row["question"]["criteria"])
            if row["answer"] not in options:
                raise ValueError("Training label is missing from question options")
            ids, markers = build_sequence(agent.tok, row["state"], q, 1024, 512)
            if len(markers) != len(render_options(q)):
                raise ValueError("Training question exceeds Laya's option budget")
            items.append((ids, markers, options.index(row["answer"])))
    if not items:
        raise ValueError("No training items")
    return items


def batch_one(item, device):
    ids, markers, label = item
    return (
        torch.tensor([ids], device=device),
        torch.ones((1, len(ids)), dtype=torch.long, device=device),
        torch.tensor([markers], device=device),
        torch.ones((1, len(markers)), dtype=torch.bool, device=device),
        torch.tensor([QTYPES["choice"]], device=device),
        torch.tensor([label], device=device),
    )


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    source, base, output = sys.argv[1:]
    if not torch.cuda.is_available():
        raise RuntimeError("Run training on the Workstation CUDA GPU")
    if Path(output).exists():
        raise FileExistsError(f"Output already exists: {output}")
    import laya

    random.seed(23)
    torch.manual_seed(23)
    agent = laya.load(base, device="cpu")
    agent.cfg["max_len"] = 1024
    agent.cfg["head_max_len"] = 512
    items = read_items(source, agent)
    model = agent.model
    full = os.environ.get("LAYA_SEARCH_TRAIN_ENCODER") == "1"
    if full:
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    else:
        model.encoder.requires_grad_(False)
    model.to("cuda")
    trainable = [p for p in model.parameters() if p.requires_grad]
    if full:
        encoder = [p for name, p in model.named_parameters() if name.startswith("encoder.")]
        head = [p for name, p in model.named_parameters() if not name.startswith("encoder.")]
        optimizer = torch.optim.AdamW([{"params": encoder, "lr": 1e-5}, {"params": head, "lr": 6e-5}],
                                      weight_decay=0.01, foreach=False)
    else:
        optimizer = torch.optim.AdamW(trainable, lr=6e-5, weight_decay=0.01, foreach=False)
    epochs = int(os.environ.get("LAYA_SEARCH_EPOCHS", "3"))
    if not 1 <= epochs <= 8:
        raise ValueError("LAYA_SEARCH_EPOCHS must be 1..8")
    accum = 16
    step = 0
    for epoch in range(epochs):
        random.shuffle(items)
        model.train()
        if not full:
            model.encoder.eval()
        optimizer.zero_grad(set_to_none=True)
        total_loss = 0.0
        correct = 0
        for i, item in enumerate(items):
            ids, attention, markers, mask, qtype, label = batch_one(item, "cuda")
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits, _ = model(ids, attention, markers, mask, qtype)
            loss = torch.nn.functional.cross_entropy(logits.float(), label)
            (loss / accum).backward()
            total_loss += loss.item()
            correct += int(logits.argmax(-1).item() == label.item())
            if (i + 1) % accum == 0 or i + 1 == len(items):
                torch.nn.utils.clip_grad_norm_(trainable, 1.0)
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                step += 1
        print(json.dumps({"epoch": epoch + 1, "items": len(items), "train_top1": correct / len(items),
                          "train_loss": total_loss / len(items), "updates": step}), flush=True)
    model.eval()
    out = Path(output)
    out.mkdir(parents=True)
    save_file({k: v.detach().half().contiguous().cpu() for k, v in model.state_dict().items()}, str(out / "model.safetensors"))
    shutil.copytree(Path(base) / "encoder", out / "encoder")
    shutil.copytree(Path(base) / "tokenizer", out / "tokenizer")
    config = dict(agent.cfg)
    data_name = os.environ.get("LAYA_SEARCH_DATA_NAME", "synthetic-search-v1")
    config.update(fine_tuned=True, model_name="zen-pi-laya-search", temperature=[1.0, 1.0, 1.0],
                  temperature_by_options={}, head_max_len_train=512,
                  zen_pi_training=f"{data_name}-{'full' if full else 'head-only'}")
    (out / "rl_agent_config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    manifest = {"source_sha256": hashlib.sha256(Path(source).read_bytes()).hexdigest(), "base": str(Path(base).resolve()),
                "epochs": epochs, "items": len(items), "encoder_frozen": not full,
                "device": torch.cuda.get_device_name(0), "torch": torch.__version__, "seed": 23}
    (out / "zen_pi_training.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"checkpoint": str(out), "train_items": len(items), "encoder_frozen": not full}), flush=True)


if __name__ == "__main__":
    main()
