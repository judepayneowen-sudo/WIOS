#!/usr/bin/env python3
"""WHOOP Core drop-box.

Receives capture dumps POSTed from the iPhone app ("Send to laptop" in the Setup tab)
over your local WiFi and writes them to ../captures/ so they can be read on the laptop
without any copy-paste from phone to laptop.

Run:
    python tools/whoop-dropbox.py

Then in the app's Setup tab set "laptop IP:port" to the address printed below and tap
"Send to laptop". Files land in whoop-ios/captures/whoop-capture-<timestamp>.txt

Notes:
- Phone and laptop must be on the same WiFi (no VPN on either).
- First run, Windows may pop a Firewall prompt — allow Python on Private networks.
- First send, the iPhone will ask to allow local-network access — tap Allow, then Send again.
"""
import http.server
import socketserver
import datetime
import pathlib
import socket

PORT = 8787
OUT = pathlib.Path(__file__).resolve().parent.parent / "captures"
OUT.mkdir(exist_ok=True)


def lan_ip():
    """Best-effort primary LAN IP (the address the phone should target)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class Handler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"WHOOP Core drop-box is running. POST captures to /capture\n")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(n) if n else b""
        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        path = OUT / f"whoop-capture-{ts}.txt"
        path.write_bytes(body)
        frames = body.count(b"\n") + (1 if body and not body.endswith(b"\n") else 0)
        print(f"[{datetime.datetime.now():%H:%M:%S}] saved {len(body)} bytes / ~{frames} frames -> {path}")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(f"stored as {path.name} ({frames} frames)".encode())

    def log_message(self, *args):  # silence default per-request noise
        pass


if __name__ == "__main__":
    ip = lan_ip()
    print("WHOOP Core drop-box")
    print(f"  saving captures to : {OUT}")
    print(f"  in the app Setup tab, set  laptop IP:port  to :  {ip}:{PORT}")
    print("  leave this window open; press Ctrl+C to stop.\n")
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Handler) as srv:
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped.")
