# AuraPay teaser (45 s, 1920×1080, 30 fps)

`AuraPay-teaser.mp4`: kinetic-type teaser with an original synthesised soundtrack (120 BPM amapiano-style groove + UI foley, no stock sounds). No website link.

Rebuild:
```bash
node render.cjs frames 45            # renders frames/00000.jpg… from teaser.html (time-driven, deterministic)
python3 score.py score.wav           # synthesises the soundtrack on the same beat grid
ffmpeg -framerate 30 -i frames/%05d.jpg -i score.wav -c:v libx264 -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -af loudnorm=I=-14:TP=-1.5 -shortest -movflags +faststart AuraPay-teaser.mp4
```
