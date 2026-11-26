#!/usr/bin/env python3
"""Synthesise a 60 s gamelan-inspired soundtrack for the trailer (no samples, no licences).

Instruments are additive-synthesis approximations: a bronze gong (inharmonic
partials with slow beating), saron and peking metallophones on a slendro-like
five-tone scale, a soft drum pulse and a low drone, through a simple reverb.
Section changes line up with the shots in capture.mjs.

    python3 -I music.py   ->  music.wav (44.1 kHz stereo)
"""
import wave
from pathlib import Path

import numpy as np

SR = 44100
DUR = 60.0
BEAT = 60 / 80  # 80 bpm
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)

# slendro-ish tuning (cents above the root); root A3
CENTS = [0, 231, 474, 717, 955]
ROOT = 220.0


def freq(deg, octave=0):
    deg_o, deg = divmod(deg, 5)
    return ROOT * 2 ** (octave + deg_o + CENTS[deg] / 1200)


def add(sig, t0, gain=1.0, pan=0.0):
    i = int(t0 * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    L[i:i + len(sig)] += sig * gain * l
    R[i:i + len(sig)] += sig * gain * r


def bell(f0, partials, amps, tau, dur, attack=0.004, detune=0.0):
    t = np.arange(int(dur * SR)) / SR
    s = np.zeros_like(t)
    for p, a in zip(partials, amps):
        f = f0 * p
        s += a * np.sin(2 * np.pi * f * t) * np.exp(-t / (tau / (0.6 + 0.4 * p ** 0.5)))
        if detune:  # bronze "ombak": a slightly detuned twin makes the slow beating
            s += a * 0.8 * np.sin(2 * np.pi * (f + detune) * t + 1.3) * np.exp(-t / (tau / (0.6 + 0.4 * p ** 0.5)))
    env = np.minimum(1, t / attack)
    return s * env


def gong(t0, f0=55.0, gain=1.0):
    g = bell(f0, [1, 2.0, 2.76, 4.1, 5.4], [1, 0.5, 0.35, 0.15, 0.08], tau=5.5, dur=9, attack=0.03, detune=0.55)
    add(g, t0, 0.55 * gain, pan=-0.1)


def kempul(t0, deg, gain=1.0):
    g = bell(freq(deg, -2), [1, 2.0, 2.92, 4.3], [1, 0.4, 0.25, 0.1], tau=2.2, dur=4, attack=0.01, detune=0.9)
    add(g, t0, 0.35 * gain, pan=0.15)


def saron(t0, deg, gain=1.0, octave=0):
    s = bell(freq(deg, octave), [1, 2.76, 5.4, 8.93], [1, 0.45, 0.2, 0.08], tau=1.1, dur=2.5)
    click = rng.normal(0, 1, int(0.012 * SR)) * np.exp(-np.arange(int(0.012 * SR)) / (0.002 * SR))
    s[: len(click)] += 0.15 * click
    add(s, t0, 0.22 * gain, pan=-0.35)


def peking(t0, deg, gain=1.0):
    s = bell(freq(deg, 1), [1, 2.76, 5.4], [1, 0.35, 0.12], tau=0.6, dur=1.4)
    add(s, t0, 0.11 * gain, pan=0.45)


def drum(t0, gain=1.0):
    t = np.arange(int(0.45 * SR)) / SR
    f = 55 + 90 * np.exp(-t / 0.03)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.12)
    s += 0.15 * rng.normal(0, 1, len(t)) * np.exp(-t / 0.01)
    add(s, t0, 0.32 * gain, pan=0.0)


def drone(t0, t1, gain=0.06):
    t = np.arange(int((t1 - t0) * SR)) / SR
    env = np.minimum(1, t / 3) * np.minimum(1, (t[-1] - t) / 3)
    trem = 1 + 0.25 * np.sin(2 * np.pi * 0.11 * t)
    s = (np.sin(2 * np.pi * freq(0, -2) * t) + 0.6 * np.sin(2 * np.pi * freq(3, -2) * t + 0.5)
         + 0.3 * np.sin(2 * np.pi * freq(0, -1) * t + 1.1)) * env * trem
    add(s, t0, gain, pan=0.0)


# ------------------------------------------------------------------ arrangement
# shot boundaries (s): title 0-5 | dive 5-12 | volcanoes 12-17 | pull back 17-21 |
# lenses 21-35 | advisors 35-48 | hover 48-54 | end card 54-60
A = [2, 3, 4, 3, 2, 1, 0, 1]
B = [1, 2, 1, 0, 3, 2, 1, 0]
MELODY = A + B + A + [2, 3, 2, 1, 0, 4 - 5, 0, 1]

drone(0.0, 60.0)
gong(0.25, gain=1.0)
for t in (5.0, 12.0, 17.0):
    kempul(t, 0)

beat = 0
t = 5.0
while t < 54.0:
    deg = MELODY[beat % len(MELODY)]
    sparse = t < 12.0 or t >= 48.0
    if not sparse or beat % 2 == 0:
        saron(t, deg, gain=0.8 if t < 12 else 1.0)
    if 21.0 <= t < 48.0:  # peking plays the "imbal" pattern twice per beat
        nxt = MELODY[(beat + 1) % len(MELODY)]
        peking(t, deg, 0.9)
        peking(t + BEAT / 2, nxt + 1, 0.7)
        if beat % 2 == 1:
            drum(t, 0.8)
        if beat % 8 == 4:
            kempul(t, 3, 0.8)
    elif 12.0 <= t < 21.0 and beat % 4 == 2:
        peking(t + BEAT / 2, deg + 2, 0.6)
    beat += 1
    t += BEAT

gong(21.0, gain=0.9)
gong(35.0, gain=0.9)
gong(54.0, f0=52.0, gain=1.1)
for k, deg in enumerate([2, 1, 0]):  # closing phrase over the end card
    saron(54.6 + k * BEAT * 1.5, deg, 0.7)

# ------------------------------------------------------------------ reverb + master
ir_len = int(2.4 * SR)
ir = rng.normal(0, 1, ir_len) * np.exp(-np.arange(ir_len) / (0.55 * SR))
ir[0] = 0
ir /= np.sqrt((ir ** 2).sum())


def reverb(x):
    n = 1 << int(np.ceil(np.log2(len(x) + ir_len)))
    y = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)[: len(x)]
    return x + 0.28 * y


L, R = reverb(L), reverb(R)
tt = np.arange(N) / SR
fade = np.minimum(1, tt / 0.8) * np.clip((DUR - tt) / 3.0, 0, 1)
L, R = L * fade, R * fade
peak = max(np.abs(L).max(), np.abs(R).max())
L, R = L / peak * 0.89, R / peak * 0.89  # about -1 dBFS

out = Path(__file__).with_name("music.wav")
pcm = (np.stack([L, R], axis=1) * 32767).astype("<i2")
with wave.open(str(out), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f"wrote {out} ({DUR:.0f} s)")
