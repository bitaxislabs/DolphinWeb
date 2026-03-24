#!/usr/bin/env python3
"""Simple HTTP server with COOP/COEP headers for SharedArrayBuffer support."""
import http.server
import sys

class COOPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def guess_type(self, path):
        if path.endswith('.wasm'):
            return 'application/wasm'
        if path.endswith('.worker.js'):
            return 'application/javascript'
        return super().guess_type(path)

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
print(f'Serving on http://localhost:{port} with COOP/COEP headers')
http.server.HTTPServer(('', port), COOPHandler).serve_forever()
