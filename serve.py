import http.server
import mimetypes
import os
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ALLOWED_PROXY_HOSTS = {'7tv.io', 'api.betterttv.net', 'decapi.me'}
UPSTREAM_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
               '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')


def fetch_upstream(target):
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(target, headers={
                'User-Agent': UPSTREAM_UA,
                'Accept': 'application/json, text/plain, */*',
            })
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.headers.get('Content-Type', 'application/json'), r.read()
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code < 500 and e.code != 429:
                break  # 4xx is not transient, don't retry
        except Exception as e:  # network / TLS / timeout
            last_err = e
        time.sleep(1.5 * (attempt + 1))
    raise last_err
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path == '/proxy':
            return self.proxy_external(url)
        if url.path != '/local':
            return super().do_GET()

        qs = urllib.parse.parse_qs(url.query)
        path = qs.get('path', [''])[0].strip().strip('"').strip("'")
        if not path or not os.path.isfile(path):
            self.send_error(404, f'File not found: {path}')
            return
        self.serve_local_file(path)

    def proxy_external(self, url):
        target = urllib.parse.parse_qs(url.query).get('url', [''])[0]
        parts = urllib.parse.urlsplit(target)
        if parts.scheme != 'https' or (parts.hostname or '') not in ALLOWED_PROXY_HOSTS:
            self.send_error(403, 'Host not allowed')
            return
        try:
            ctype, body = fetch_upstream(target)
        except urllib.error.HTTPError as e:
            print(f'[proxy] {target} -> HTTP {e.code}', file=sys.stderr)
            self.send_error(e.code, f'Upstream returned HTTP {e.code}')
            return
        except Exception as e:
            print(f'[proxy] {target} -> {e}', file=sys.stderr)
            self.send_error(502, f'Upstream request failed: {e}')
            return
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_local_file(self, path):
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        start, end = 0, size - 1
        status = 200

        rng = self.headers.get('Range')
        if rng and rng.startswith('bytes='):
            spec = rng[6:].split(',')[0].strip()
            s, _, e = spec.partition('-')
            try:
                if s == '':
                    start = max(0, size - int(e))
                else:
                    start = int(s)
                    if e:
                        end = min(int(e), size - 1)
            except ValueError:
                start = 0
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            status = 206

        length = end - start + 1
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(length))
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()

        try:
            with open(path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    url = f'http://localhost:{PORT}/index.html'
    print(f'VOD chat replay running at {url}')
    print('Press Ctrl+C to stop.')
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
