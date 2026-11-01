const { chromium } = require("playwright");
const path = require("path");
(async () => {
  const dir = __dirname;
  const mode = process.argv[2];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on("pageerror", (e) => console.error("pageerror", e.message));
  await p.goto("file://" + path.join(dir, "teaser.html"));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  if (mode === "stills") {
    const times = process.argv.slice(3).map(Number);
    for (const t of times) { await p.evaluate((t) => window.render(t), t); await p.screenshot({ path: path.join(dir, `still-${t}.jpg`), type: "jpeg", quality: 80 }); }
  } else {
    const fps = 30, dur = Number(process.argv[3] || 45);
    const n = Math.round(dur * fps);
    for (let i = 0; i < n; i++) {
      await p.evaluate((t) => window.render(t), i / fps);
      await p.screenshot({ path: path.join(dir, "frames", String(i).padStart(5, "0") + ".jpg"), type: "jpeg", quality: 92 });
      if (i % 150 === 0) console.log("frame", i, "/", n);
    }
  }
  await b.close();
})();
