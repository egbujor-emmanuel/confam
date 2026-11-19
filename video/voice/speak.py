"""Nigerian-accent narration with YarnGPT2, checked by Whisper.

YarnGPT2 rushes and drops words on long sentences, so each line is split into short chunks (sentence
and comma boundaries, at most MAX_WORDS words), each chunk is generated, transcribed with Whisper and
compared with the script; a chunk that loses words is regenerated with another seed (up to TRIES).
Chunks are joined with short pauses into one WAV per line, and a JSON report records every score.

Run from ~/tools with the YarnGPT venv (the cloned repo folder is the `yarngpt` package):
  PYTHONPATH=~/tools ~/tools/yarngpt-venv/Scripts/python.exe speak.py <lines.json> <out_dir> <voice>
lines.json: [{"id": "s01", "text": "..."}, ...]   (TTS spelling; captions keep the real spelling)
"""
import json
import os
import re
import sys
import time
import warnings
from difflib import SequenceMatcher

import torch
import torchaudio
import whisper
from transformers import AutoModelForCausalLM

from yarngpt.audiotokenizer import AudioTokenizerV2

warnings.filterwarnings("ignore")
MODELS = os.path.expanduser("~/tools/yarngpt-models")
WAV_CONFIG = os.path.join(MODELS, "wavtokenizer_mediumdata_frame75_3s_nq1_code4096_dim512_kmeans200_attn.yaml")
WAV_MODEL = os.path.join(MODELS, "wavtokenizer_large_speech_320_24k.ckpt")
RATE = 24000
MAX_WORDS = 12
TRIES = 3
MIN_SCORE = 0.8  # word-level similarity between the script chunk and what Whisper heard
PAUSE_COMMA_S = 0.18
PAUSE_SENTENCE_S = 0.35


def chunk(text: str) -> list[tuple[str, float]]:
    """Split into (chunk, pause after) pieces at sentence ends, then commas, then every MAX_WORDS words."""
    pieces: list[tuple[str, float]] = []
    for sentence in re.findall(r"[^.?!]+[.?!]?", text):
        sentence = sentence.strip()
        if not sentence:
            continue
        parts = [p.strip() for p in re.split(r"(?<=,)\s+", sentence) if p.strip()]
        merged: list[str] = []
        for part in parts:  # keep commas together while the chunk stays short
            if merged and len((merged[-1] + " " + part).split()) <= MAX_WORDS:
                merged[-1] = f"{merged[-1]} {part}"
            else:
                merged.append(part)
        for i, part in enumerate(merged):
            words = part.split()
            for j in range(0, len(words), MAX_WORDS):
                piece = " ".join(words[j : j + MAX_WORDS])
                last = i == len(merged) - 1 and j + MAX_WORDS >= len(words)
                pieces.append((piece, PAUSE_SENTENCE_S if last else PAUSE_COMMA_S))
    return pieces


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower().replace("-", ""))


def score(expected: str, heard: str) -> float:
    return SequenceMatcher(None, words(expected), words(heard)).ratio()


def main() -> None:
    lines_path, out_dir, voice = sys.argv[1], sys.argv[2], sys.argv[3]
    lines = json.load(open(lines_path, encoding="utf-8"))
    os.makedirs(out_dir, exist_ok=True)
    tokenizer = AudioTokenizerV2("saheedniyi/YarnGPT2", WAV_MODEL, WAV_CONFIG)
    # float32: bfloat16 matrix maths is very slow on most laptop CPUs.
    model = AutoModelForCausalLM.from_pretrained("saheedniyi/YarnGPT2", dtype=torch.float32).to(tokenizer.device)
    asr = whisper.load_model("base")
    report = []
    for line in lines:
        out_path = os.path.join(out_dir, f"{line['id']}.wav")
        if os.path.exists(out_path):
            print(f"{line['id']}: exists, skipped", flush=True)
            continue
        audio_parts = []
        for piece, pause in chunk(line["text"]):
            best = None
            for attempt in range(TRIES):
                torch.manual_seed(1000 * attempt + len(piece))
                started = time.time()
                prompt = tokenizer.create_prompt(piece, lang="english", speaker_name=voice)
                output = model.generate(
                    input_ids=tokenizer.tokenize_prompt(prompt),
                    do_sample=attempt > 0,  # first try greedy (as the model card), retries sample
                    temperature=0.1,
                    repetition_penalty=1.1,
                    max_length=4000,
                )
                audio = tokenizer.get_audio(tokenizer.get_codes(output))
                heard = asr.transcribe(audio.squeeze().numpy().astype("float32"), language="en", fp16=False)["text"].strip()
                s = score(piece, heard)
                print(f"{line['id']} try {attempt + 1}: {s:.2f} in {time.time() - started:.0f}s | {piece!r} -> {heard!r}", flush=True)
                if best is None or s > best[0]:
                    best = (s, audio, heard)
                if s >= MIN_SCORE:
                    break
            report.append({"id": line["id"], "chunk": piece, "heard": best[2], "score": round(best[0], 2)})
            audio_parts += [best[1], torch.zeros(1, int(RATE * pause))]
        torchaudio.save(out_path, torch.cat(audio_parts, dim=1), sample_rate=RATE)
        json.dump(report, open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8"), indent=2)
        print(f"{line['id']}: saved {out_path}", flush=True)


if __name__ == "__main__":
    main()
