"""Original soundtrack for the AuraPay teaser: 120 BPM amapiano-style groove + UI foley.
Everything is synthesised here (no samples, no whooshes). Beat grid matches teaser.html."""
import numpy as np, wave, sys

SR = 44100
BEAT = 0.5
DUR = 45.0
N = int(SR * DUR)
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(7)

def midi(m): return 440.0 * 2 ** ((m - 69) / 12)
def at(beat): return int(beat * BEAT * SR)

def add(sig, beat, gain=1.0, pan=0.0):
    i = at(beat)
    if i >= N: return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    R[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))

def env(n, a=0.005, d=0.2, s=0.0, sl=0.0):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    rel = np.exp(-np.maximum(0, t - a) / max(d, 1e-4))
    return e * (s + (1 - s) * rel) if sl == 0 else e * rel

def lowpass(x, fc):
    a = np.exp(-2 * np.pi * fc / SR); y = np.zeros_like(x); acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc; y[i] = acc
    return y

def onepole_hp(x, fc):
    return x - lowpass(x, fc)

# ---------------------------------------------------------------- instruments
def pad(notes, beats, bright=900):
    n = int(beats * BEAT * SR); t = np.arange(n) / SR; s = np.zeros(n)
    for m in notes:
        f = midi(m)
        for det in (-0.12, 0.0, 0.12):
            ph = rng.uniform(0, 2 * np.pi)
            ff = f * 2 ** (det / 12)
            # soft saw (few harmonics)
            s += sum(np.sin(2 * np.pi * ff * k * t + ph) / k for k in range(1, 6)) / 3
    e = np.minimum(1, t / 0.35) * np.minimum(1, (t[-1] - t + 1e-3) / 0.3)
    return lowpass(s * e, bright) / len(notes) * 0.5

def marimba(m, length=0.6):
    n = int(length * SR); t = np.arange(n) / SR; f = midi(m)
    s = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.35) + 0.35 * np.sin(2 * np.pi * f * 4 * t) * np.exp(-t / 0.06) + 0.12 * np.sin(2 * np.pi * f * 9.2 * t) * np.exp(-t / 0.02)
    return s * np.minimum(1, t / 0.002)

def logdrum(m, length=0.45):
    n = int(length * SR); t = np.arange(n) / SR; f = midi(m)
    fr = f * (1 + 0.9 * np.exp(-t / 0.025))          # pitch drop = the "log drum" knock
    ph = 2 * np.pi * np.cumsum(fr) / SR
    s = np.sin(ph) + 0.45 * np.sin(2 * ph) + 0.2 * np.sin(3 * ph)
    s = np.tanh(2.2 * s) * np.exp(-t / 0.22)
    return s * np.minimum(1, t / 0.002)

def kick(length=0.35):
    n = int(length * SR); t = np.arange(n) / SR
    fr = 48 + 110 * np.exp(-t / 0.03); ph = 2 * np.pi * np.cumsum(fr) / SR
    return np.sin(ph) * np.exp(-t / 0.12)

def noise_burst(length, decay, hp=2000, lp=None):
    n = int(length * SR); x = rng.standard_normal(n)
    x = onepole_hp(x, hp)
    if lp: x = lowpass(x, lp)
    return x * np.exp(-np.arange(n) / SR / decay)

def clap():
    s = np.zeros(int(0.25 * SR))
    for k, d in enumerate((0, 0.009, 0.019)):
        b = noise_burst(0.2, 0.03 if k < 2 else 0.09, hp=900, lp=5000); i = int(d * SR); s[i:i + len(b)] += b[: len(s) - i]
    return s * 0.5

def shaker(): return noise_burst(0.08, 0.018, hp=6000) * 0.5
def tick():   # keypad / typing
    n = int(0.05 * SR); t = np.arange(n) / SR
    return (0.6 * np.sin(2 * np.pi * 2400 * t) * np.exp(-t / 0.006) + 0.4 * noise_burst(0.05, 0.004, hp=3000)[:n])
def click():  # cursor click
    n = int(0.06 * SR); t = np.arange(n) / SR
    return np.sin(2 * np.pi * 1700 * t) * np.exp(-t / 0.01) + 0.5 * np.sin(2 * np.pi * 3400 * t) * np.exp(-t / 0.004)
def plop():   # card dropped into the bin
    n = int(0.22 * SR); t = np.arange(n) / SR
    fr = 180 + 520 * np.exp(-t / 0.03); ph = 2 * np.pi * np.cumsum(fr) / SR
    return np.sin(ph) * np.exp(-t / 0.07)
def pop(m=84):
    n = int(0.15 * SR); t = np.arange(n) / SR; f = midi(m)
    return np.sin(2 * np.pi * f * t * (1 + 0.15 * np.exp(-t / 0.01))) * np.exp(-t / 0.05)

# ---------------------------------------------------------------- harmony
PROG = [  # (pad notes, log-drum root) per bar, A minor
    ([57, 60, 64, 67], 45),   # Am7
    ([53, 57, 60, 64], 41),   # Fmaj7
    ([55, 60, 64, 71], 48),   # Cmaj7 (voiced)
    ([55, 59, 62, 64], 43),   # G6
]
def bar_chord(beat): return PROG[int(beat // 4) % 4]

# Pads through the whole piece (brighter after the drop, gone at the very end)
for bar in range(0, 22):
    b0 = bar * 4
    notes, _ = bar_chord(b0)
    bright = 700 if b0 < 28 else 1500
    gain = 0.30 if b0 < 28 else 0.22
    if b0 >= 76: bright, gain = 1100, 0.30
    add(pad(notes, 4.2, bright), b0, gain)

# Intro: shaker from beat 4, a gentle marimba motif
for b in np.arange(4, 14, 0.5): add(shaker(), b, 0.25 if b % 1 else 0.15, pan=0.3)
for b, m in [(0, 69), (1.5, 72), (3, 76), (4, 74), (5.5, 72), (8, 69), (9.5, 72), (11, 76), (12, 79)]:
    add(marimba(m), b, 0.22, pan=-0.2)

# Problems: soft heartbeat kick, rim on 2 & 4, sparse log drum = tension
for b in range(14, 24):
    add(kick(), b, 0.45)
    if b % 2 == 1: add(clap(), b, 0.22)
for b in np.arange(14, 24, 0.5): add(shaker(), b, 0.18, pan=0.3)
for bar0 in (16, 20):
    _, root = bar_chord(bar0)
    for off in (0, 2.5): add(logdrum(root), bar0 + off, 0.55)

# Breakdown 24-28: hush, then a rising marimba build into the drop (no riser/whoosh)
for i, m in enumerate([57, 60, 64, 67, 69, 72, 76, 79]): add(marimba(m, 0.4), 26 + i * 0.25, 0.20 + i * 0.02, pan=(-0.3 + i * 0.08))

# THE DROP 28-76: full amapiano-style groove
LOG_PATTERN = [(0, 0), (0.75, 0), (1.5, 7), (2.5, 0), (3.0, 3), (3.5, 0)]   # (beat offset, semitones)
def groove(b_from, b_to, full=True):
    for b in range(b_from, b_to):
        add(kick(), b, 0.55)
        if b % 2 == 1: add(clap(), b, 0.35, pan=0.1)
    for b in np.arange(b_from, b_to, 0.25):
        sw = 0.04 if (b * 4) % 2 == 1 else 0           # 16th swing
        add(shaker(), b + sw, 0.30 if (b * 4) % 2 else 0.18, pan=0.35)
    for bar0 in range(b_from, b_to, 4):
        notes, root = bar_chord(bar0)
        for off, semi in LOG_PATTERN:
            if bar0 + off < b_to: add(logdrum(root + semi), bar0 + off, 0.62)
        if full:  # light chord stabs on the offbeats
            for off in (1.5, 3.5):
                for m in notes[1:]: add(marimba(m + 12, 0.25), bar0 + off, 0.06, pan=-0.25)

groove(28, 58)
groove(62, 76)
# 58-62 "BORDERLESS": strip back to log drum + claps, then a clean stop before the wave
for b in range(58, 61): add(kick(), b, 0.5)
for b in (59, 61): add(clap(), b, 0.3)
for off, semi in LOG_PATTERN[:4]: add(logdrum(45 + semi), 58 + off, 0.6)
for i in range(10): add(pop(81 + (i % 5) * 2), 59 + i * 0.12, 0.10, pan=-0.5 + i * 0.1)

# Logo reveal accent
for m in (69, 76, 81, 84): add(marimba(m, 1.2), 28, 0.16, pan=0)

# ---------------------------------------------------------------- foley (synced to visuals)
for i in range(4):
    a = 16 + 1.8 * i
    add(pop(88), a, 0.14, pan=0.2)          # card appears
    add(plop(), a + 1.55, 0.45, pan=0)      # card lands in the bin
add(click(), 26.5, 0.5)                     # cursor clicks "AuraPay"
for b in (40, 40.5, 41, 41.5): add(tick(), b, 0.45, pan=0.35)   # keypad
add(pop(84), 42.4, 0.18, pan=0.35)          # review screen
for i, m in enumerate((69, 72, 76, 81)): add(marimba(m, 0.35), 43.5 + i * 0.5, 0.20, pan=0.35)  # slide to pay
for i, m in enumerate((84, 88, 91)): add(marimba(m, 0.9), 45.5 + i * 0.12, 0.22, pan=0.35)       # success chime
for i in range(5): add(tick(), 51 + i * 0.25, 0.35, pan=0)        # typing @amaka
add(pop(91), 52.4, 0.15)                    # username found
add(pop(86), 52.9, 0.15)                    # amount
for i, m in enumerate((88, 95)): add(marimba(m, 0.7), 54.5 + i * 0.14, 0.24, pan=0.45)            # notification ping
for i, b in enumerate((62.6, 64.4, 66.2)): add(marimba(76 + i * 3, 0.6), b, 0.16)
for i in range(4): add(pop(79 + i * 3), 68.3 + i * 0.9, 0.20)    # stats
for i in range(4): add(pop(91), 72.4 + i * 0.35, 0.10, pan=-0.3 + i * 0.2)  # country chips

# Outro: logo hit, then breathe out
for m in (57, 64, 69, 76, 81): add(marimba(m, 2.0), 76, 0.14)
add(logdrum(45), 76, 0.6); add(kick(), 76, 0.5)
for b in np.arange(77, 88, 0.5): add(shaker(), b, 0.12, pan=0.3)
add(logdrum(41), 80, 0.45)
add(click(), 81.6, 0.5)
for i, m in enumerate((81, 84, 88)): add(marimba(m, 1.4), 81.7 + i * 0.1, 0.18)
add(pad([57, 64, 69, 72, 76], 6.5, 1300), 84, 0.30)

# ---------------------------------------------------------------- master
mix = np.stack([L, R])
mix = np.tanh(mix * 1.15)                                   # gentle glue/saturation
fade = np.ones(N); fl = int(1.6 * SR); fade[-fl:] = np.linspace(1, 0, fl) ** 1.5
fade[: int(0.02 * SR)] = np.linspace(0, 1, int(0.02 * SR))
mix *= fade
mix *= 0.89 / np.max(np.abs(mix))                           # peak ≈ -1 dBFS
pcm = (mix.T * 32767).astype(np.int16)
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print("ok", pcm.shape)
