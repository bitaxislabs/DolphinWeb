# Dolphin for Web

GameCube and Wii emulation in your browser, powered by WebAssembly.

**Live:** [dolphinweb.bitaxislabs.com](https://dolphinweb.bitaxislabs.com)

## Features

- Dolphin emulator compiled to WebAssembly via Emscripten
- Software renderer (WebGL2 canvas output)
- Zero-copy ROM loading (files never leave your browser)
- On-screen GameCube touch controls with virtual analog sticks
- Nintendo Switch 2 NSO GameCube controller support via Web Bluetooth
- iOS Safari support (HTTPS + SharedArrayBuffer)
- Responsive layout for desktop and mobile

## Requirements

- A modern browser with WebAssembly, SharedArrayBuffer, and Web Workers
- Chrome 85+, Safari 17+, Firefox 105+
- HTTPS required (for SharedArrayBuffer / COOP+COEP headers)
- Your own GameCube/Wii ROM files (not included)

## Running Locally

The `web/` directory contains everything needed to run. You just need an HTTP server that sets the correct headers.

```bash
cd web
python3 server.py
```

Then open `http://localhost:8080` in your browser. The included `server.py` sets the required `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers.

For iOS Safari testing (requires HTTPS):

```bash
cd web
# Generate a self-signed cert first:
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj '/CN=localhost'
python3 server_https.py
```

## Building from Source

### Prerequisites

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) (3.1.x+)
- CMake 3.20+
- Python 3

### Build Steps

```bash
# Clone with submodules
git clone --recursive https://github.com/bitaxislabs/DolphinWeb.git
cd DolphinWeb

# Activate Emscripten
source ~/emsdk/emsdk_env.sh

# Configure
cd dolphin
emcmake cmake -B build-wasm -S . \
  -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_HEADLESS=ON \
  -DENABLE_NOGUI=ON \
  -DENABLE_QT=OFF \
  -DENABLE_TESTS=OFF \
  -DUSE_DISCORD_PRESENCE=OFF \
  -DWITH_OPTIM=OFF

# Build
cmake --build build-wasm -j$(nproc)

# Copy output to web directory
cp build-wasm/Binaries/dolphin-emu-nogui.{js,wasm,data} ../web/
```

### Emscripten Link Flags

The key Emscripten flags are configured in `dolphin/Source/Core/DolphinNoGUI/CMakeLists.txt`:

- `-pthread` / `-sUSE_PTHREADS=1` for multithreading
- `-sOFFSCREENCANVAS_SUPPORT=1` for GL context on worker threads
- `-sALLOW_MEMORY_GROWTH=1` for dynamic memory
- `-sEXPORTED_FUNCTIONS` for the controller input bridge
- `--preload-file` for Dolphin system files

## Architecture

- **CPU:** CachedInterpreter backend (no native JIT in WASM)
- **Video:** Software Renderer with EGL/WebGL2 canvas output
- **Audio:** Not yet implemented
- **Input:** Web Bluetooth (NSW2 controllers) + on-screen touch controls
- **Frontend:** DolphinNoGUI with custom Emscripten platform layer

### Key Source Modifications

All Emscripten-specific changes are guarded with `#ifdef __EMSCRIPTEN__`:

- `DolphinNoGUI/PlatformEmscripten.cpp` - Main loop via `emscripten_set_main_loop`
- `DolphinNoGUI/EmscriptenInput.cpp` - Web controller state bridge
- `DolphinNoGUI/EmscriptenStubs.cpp` - Platform stubs
- `Common/MemArenaEmscripten.cpp` - malloc-backed memory arena
- `Core/System.cpp` - Force single-core mode
- `VideoCommon/VideoBackendBase.cpp` - Force Software Renderer

## Deploying

For Cloudflare Pages or similar static hosting, set the build output directory to `web/` and ensure these response headers are set on all routes:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

A `_headers` file for Cloudflare Pages is included in `web/`.

## Legal

This project does not include any Nintendo ROMs, BIOS files, or copyrighted game data. You must provide your own legally obtained game files.

Dolphin is licensed under GPL-2.0-or-later. See the [dolphin](https://github.com/dolphin-emu/dolphin) submodule for full license.

## Credits

Built by [Bit-Axis Labs](https://bitaxislabs.com)
