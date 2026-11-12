# Valorant-Game

A single-file browser FPS built on Three.js r128. Open the latest `(V1.x) valorant-fps.html` in a browser to play.

Earlier versions are kept as separate files.

## Controls

- **Keyboard and mouse:** press **P** in game for settings and keybinds.
- **Controller (PS4 / PS5 / Xbox):** connect it and press any button. The full layout is in **Settings → Controls → Controller**.

## Regression tests

The `tests/` folder holds headless browser tests. They need no GPU, because Chromium renders WebGL in software. They check:

- **Load:** the game loads without errors.
- **Shader compiles:** none happen after warm-up, including when switching quality.
- **Abilities:** every agent's abilities and ultimate cast, and ground effects stay circular.
- **Maps and modes:** all 6 maps × 3 atmosphere modes.
- **Controller:** input works through a simulated gamepad.
- **Game modes:** Wave, Retake and the 30-bot Range play through planting, defusing, detonation, round changes and the range scorecard.
- **HUD and settings:** the HUD has no overlapping panels at common window sizes, and settings survive a reload (and the opt-out sticks).
- **Audio and hit feedback:** 3D enemy audio and hit feedback work.

```bash
cd tests
npm ci
npx playwright install chromium
npm test
```

GitHub Actions runs these tests on every pull request and on pushes to `main`. To test a different file, set `GAME_FILE` (a path relative to the repo root).
