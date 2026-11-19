"""Generate the same Confam line in each YarnGPT2 male Nigerian voice, so the narrator can be chosen.

Run with the YarnGPT venv from the yarngpt repo folder (it imports `yarngpt.audiotokenizer`):
  cd ~/tools/yarngpt && ~/tools/yarngpt-venv/Scripts/python.exe <this file> <out_dir> [voice ...]
Settings follow the model card (https://huggingface.co/saheedniyi/YarnGPT2): temperature 0.1,
repetition_penalty 1.1, 24 kHz output.
"""
import os
import sys
import time

import torch
import torchaudio
from transformers import AutoModelForCausalLM

from yarngpt.audiotokenizer import AudioTokenizerV2

MODELS = os.path.expanduser("~/tools/yarngpt-models")
WAV_CONFIG = os.path.join(MODELS, "wavtokenizer_mediumdata_frame75_3s_nq1_code4096_dim512_kmeans200_attn.yaml")
WAV_MODEL = os.path.join(MODELS, "wavtokenizer_large_speech_320_24k.ckpt")
MALE_VOICES = ["jude", "emma", "umar", "osagie", "tayo"]  # model card's order of stability
LINE = (
    "This is Confam. E no land? You no pay. You pay for airtime, data and electricity with Bitcoin, "
    "and your payment only completes after the provider confirms delivery."
)


def main() -> None:
    out_dir = sys.argv[1]
    voices = sys.argv[2:] or MALE_VOICES
    os.makedirs(out_dir, exist_ok=True)
    torch.manual_seed(7)
    tokenizer = AudioTokenizerV2("saheedniyi/YarnGPT2", WAV_MODEL, WAV_CONFIG)
    # float32: bfloat16 matrix maths is very slow on most laptop CPUs.
    model = AutoModelForCausalLM.from_pretrained("saheedniyi/YarnGPT2", torch_dtype=torch.float32).to(tokenizer.device)
    print(f"model loaded on {tokenizer.device}", flush=True)
    for voice in voices:
        started = time.time()
        print(f"{voice}: generating…", flush=True)
        prompt = tokenizer.create_prompt(LINE, lang="english", speaker_name=voice)
        output = model.generate(input_ids=tokenizer.tokenize_prompt(prompt), temperature=0.1, repetition_penalty=1.1, max_length=4000)
        audio = tokenizer.get_audio(tokenizer.get_codes(output))
        path = os.path.join(out_dir, f"confam-{voice}.wav")
        torchaudio.save(path, audio, sample_rate=24000)
        print(f"{voice}: {audio.shape[-1] / 24000:.1f}s of audio in {time.time() - started:.0f}s -> {path}", flush=True)


if __name__ == "__main__":
    main()
