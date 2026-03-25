#!/usr/bin/env python3
"""HTTPS server with COOP/COEP headers for SharedArrayBuffer."""
import http.server, ssl, sys, os

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def guess_type(self, path):
        if path.endswith('.wasm'): return 'application/wasm'
        return super().guess_type(path)

# Generate self-signed cert if needed
cert = 'cert.pem'
key = 'key.pem'
if not os.path.exists(cert):
    os.system(f'openssl req -x509 -newkey rsa:2048 -keyout {key} -out {cert} -days 365 -nodes -subj "/CN=localhost" 2>/dev/null')
    print(f'Generated self-signed cert: {cert}')

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
server = http.server.HTTPServer(('', port), Handler)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
print(f'HTTPS server on https://0.0.0.0:{port} with COOP/COEP')
server.serve_forever()
