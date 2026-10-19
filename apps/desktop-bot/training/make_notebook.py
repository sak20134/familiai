#!/usr/bin/env python3
"""Writes montex_finetune.ipynb (run on Google Colab with a free T4 GPU, or on Kaggle)."""
import json, pathlib

md = lambda s: {"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(True)}
code = lambda s: {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(True)}

cells = [
md("""
# Train your own Montex brain

This notebook teaches a small open model (Qwen2.5 1.5B Instruct, Apache-2.0) to use Montex's tools,
then **measures it before and after**, so you can see if the training really helped.

**Before you start:** Runtime → Change runtime type → **T4 GPU**. Then Runtime → Run all.
Upload `train.jsonl` and `test.jsonl` (from `apps/desktop-bot/training/data/`) when asked in step 2.
It takes roughly 20-40 minutes. Nothing here uses a paid service.
"""),
md("## 1. Install"),
code("""
!pip -q install -U transformers peft trl datasets accelerate
import torch
assert torch.cuda.is_available(), 'No GPU: use Runtime -> Change runtime type -> T4 GPU'
print(torch.cuda.get_device_name(0))
"""),
md("## 2. Upload the data"),
code("""
import os, json
if not (os.path.exists('train.jsonl') and os.path.exists('test.jsonl')):
    from google.colab import files
    files.upload()  # choose train.jsonl and test.jsonl
train = [json.loads(l) for l in open('train.jsonl')]
test = [json.loads(l) for l in open('test.jsonl')]
print(len(train), 'train examples,', len(test), 'test examples')
"""),
md("## 3. Load the base model"),
code("""
from transformers import AutoModelForCausalLM, AutoTokenizer
BASE = 'Qwen/Qwen2.5-1.5B-Instruct'
tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.float16, device_map='auto')
"""),
md("""
## 4. Measure the model BEFORE training

For each test request the model must pick the right tool and the right arguments (or no tool
for plain chat). Test requests are worded differently from the training ones, so this is a fair test.
"""),
code("""
import re
def norm(v):
    if isinstance(v, str): return re.sub(r'\\W+', ' ', v.lower()).strip()
    if isinstance(v, list): return [norm(x) for x in v]
    if isinstance(v, dict): return {k: norm(x) for k, x in v.items()}
    return v

def parse_call(text):
    m = re.search(r'<tool_call>\\s*(\\{.*?\\})\\s*</tool_call>', text, re.S)
    if not m: return None
    try: j = json.loads(m.group(1)); return j.get('name'), j.get('arguments') or {}
    except Exception: return ('?', {})

@torch.no_grad()
def ask(ex):
    prompt = tok.apply_chat_template(ex['messages'][:2], tools=ex['tools'], add_generation_prompt=True, tokenize=False)
    ids = tok(prompt, return_tensors='pt').to(model.device)
    out = model.generate(**ids, max_new_tokens=160, do_sample=False)
    return tok.decode(out[0][ids['input_ids'].shape[1]:], skip_special_tokens=False)

def evaluate(label):
    name_ok = args_ok = chat_ok = chat_n = call_n = 0
    wrong = []
    for ex in test:
        got = parse_call(ask(ex))
        if ex['tool'] is None:
            chat_n += 1; chat_ok += got is None
            if got: wrong.append((ex['messages'][1]['content'][-60:], 'no tool expected', got[0]))
        else:
            call_n += 1
            if got and got[0] == ex['tool']:
                name_ok += 1
                if norm(got[1]) == norm(ex['args']): args_ok += 1
                else: wrong.append((ex['messages'][1]['content'][-60:], ex['args'], got[1]))
            else: wrong.append((ex['messages'][1]['content'][-60:], ex['tool'], got[0] if got else None))
    r = dict(label=label, right_tool=round(name_ok / call_n, 3), exact_arguments=round(args_ok / call_n, 3), plain_chat_no_tool=round(chat_ok / max(1, chat_n), 3))
    print(r); return r, wrong

model.eval()
before, before_wrong = evaluate('BEFORE training')
"""),
md("## 5. Train (LoRA: small add-on layers, so it fits a free GPU)"),
code("""
from peft import LoraConfig
from trl import SFTConfig, SFTTrainer
from datasets import Dataset

def to_text(ex):
    return tok.apply_chat_template(ex['messages'], tools=ex['tools'], tokenize=False)
ds = Dataset.from_list([{'text': to_text(ex)} for ex in train])

cfg = SFTConfig(output_dir='montex-lora', num_train_epochs=2, per_device_train_batch_size=2, gradient_accumulation_steps=8,
                learning_rate=2e-4, lr_scheduler_type='cosine', warmup_ratio=0.05, logging_steps=10, save_strategy='no',
                fp16=True, max_length=3072, dataset_text_field='text', report_to='none')
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj'], task_type='CAUSAL_LM')
model.config.use_cache = False
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, peft_config=lora, processing_class=tok)
trainer.train()
"""),
md("## 6. Measure AFTER training and compare"),
code("""
model = trainer.model
model.config.use_cache = True
model.eval()
after, after_wrong = evaluate('AFTER training')
print()
for k in ('right_tool', 'exact_arguments', 'plain_chat_no_tool'):
    print(f'{k:20s} {before[k]:.0%} -> {after[k]:.0%}')
print('\\nStill wrong after training (first 10):')
for w in after_wrong[:10]: print(' ', w)
"""),
md("""
## 7. Save and convert to a file Montex can load (GGUF)

Only do this if the numbers above improved. This merges the training into the model and shrinks it to
about 1 GB. Then download `montex-brain.gguf` from the Files panel on the left.
"""),
code("""
merged = model.merge_and_unload()
merged = merged.to(torch.float16)
merged.save_pretrained('montex-merged'); tok.save_pretrained('montex-merged')
"""),
code("""
!git clone -q --depth 1 https://github.com/ggml-org/llama.cpp
!pip -q install -r llama.cpp/requirements/requirements-convert_hf_to_gguf.txt
!python llama.cpp/convert_hf_to_gguf.py montex-merged --outfile montex-f16.gguf --outtype f16
!cmake -S llama.cpp -B llama.cpp/build -DGGML_CUDA=OFF -DLLAMA_CURL=OFF > /dev/null && cmake --build llama.cpp/build --target llama-quantize -j 4 > /dev/null
!llama.cpp/build/bin/llama-quantize montex-f16.gguf montex-brain.gguf Q4_K_M
!ls -lh montex-brain.gguf
"""),
code("""
from google.colab import files
files.download('montex-brain.gguf')
"""),
]
nb = {"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"provenance": []}, "kernelspec": {"display_name": "Python 3", "name": "python3"}, "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
(pathlib.Path(__file__).parent / "montex_finetune.ipynb").write_text(json.dumps(nb, indent=1))
print("wrote montex_finetune.ipynb")
