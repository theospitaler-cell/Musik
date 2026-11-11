# Instrumentenerkennung für NoteCode: Instrumenten-Spurentrennung (MVSep Mega 53 Stems, BS-Roformer, MIT-Lizenz,
# https://github.com/ZFTurbo/Music-Source-Separation-Training) und Pegel je Spur – ganze Aufnahme und je Fenster.
# Es werden keine Spuren gespeichert, nur Pegel (JSON auf stdout, Zeile „NOTECODE_RESULT {...}“).
#
#   python instruments.py --home <~/.notecode/instruments> --input <song.wav> [--device cuda|cpu] [--chunk 5] [--hop 3]
#
# Fortschritt: Zeilen „NOTECODE_PROGRESS 0.42“ auf stdout.
import argparse
import json
import os
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument('--home', required=True)
ap.add_argument('--input', required=True)
ap.add_argument('--device', default='cuda')
ap.add_argument('--chunk', type=float, default=5.0)
ap.add_argument('--hop', type=float, default=3.0)
a = ap.parse_args()

sys.path.insert(0, os.path.join(a.home, 'msst'))
import numpy as np
import soundfile as sf
import torch
import torchaudio

# torch.compile wird nur im Training gebraucht; unter Windows ohne Triton scheitert schon der Import
torch.compile = lambda f=None, *x, **k: (f if f is not None else (lambda g: g))
import utils.model_utils as mu
from utils.settings import get_model_from_config


class Progress:
    def __init__(self, total=1, **_):
        self.total = max(1, total)
        self.n = 0

    def update(self, k=1):
        self.n += k
        print('NOTECODE_PROGRESS %.3f' % min(1.0, 0.05 + 0.95 * self.n / self.total), flush=True)

    def close(self):
        pass


mu.tqdm = Progress
t0 = time.time()
dev = torch.device('cuda' if a.device == 'cuda' and torch.cuda.is_available() else 'cpu')
model, config = get_model_from_config('bs_roformer', os.path.join(a.home, 'mega53.yaml'))
sd = torch.load(os.path.join(a.home, 'mega53.ckpt'), map_location='cpu', weights_only=False)
if isinstance(sd, dict) and 'state_dict' in sd:
    sd = sd['state_dict']
model.load_state_dict(sd, strict=False)
model = model.to(dev).eval()
sr = config.audio.sample_rate
config.inference.chunk_size = int(a.chunk * sr)
config.inference.batch_size = 1
print('NOTECODE_PROGRESS 0.05', flush=True)
x, fsr = sf.read(a.input, dtype='float32', always_2d=True)
x = torch.from_numpy(x.T.copy())
if fsr != sr:
    x = torchaudio.functional.resample(x, fsr, sr)
if x.shape[0] == 1:
    x = x.repeat(2, 1)
with torch.no_grad():
    res = mu.demix(config, model, x, dev, model_type='bs_roformer', pbar=True)

mix = x.numpy()
H = int(a.hop * sr)
nW = max(1, int(np.ceil(mix.shape[1] / H)))


def win_db(y):
    p = y.astype(np.float64) ** 2
    p = p.mean(axis=0) if p.ndim == 2 else p
    out = []
    for w in range(nW):
        seg = p[w * H:(w + 1) * H]
        out.append(round(float(10 * np.log10(seg.mean() + 1e-12)), 1) if len(seg) else -120.0)
    return out


mix_p = float((mix.astype(np.float64) ** 2).mean() + 1e-12)
levels = {}
stems = {}
for name, y in res.items():
    p = float((y.astype(np.float64) ** 2).mean() + 1e-12)
    levels[name] = round(10 * np.log10(p / mix_p), 1)
    if levels[name] > -45:
        stems[name] = win_db(y)
result = dict(
    model='MVSep Mega 53 Stems (BS-Roformer)',
    device=str(dev),
    sec=round(time.time() - t0, 1),
    levels=levels,
    windows=dict(hop=a.hop, mix=win_db(mix), stems=stems),
)
print('NOTECODE_RESULT ' + json.dumps(result), flush=True)
