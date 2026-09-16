#!/usr/bin/env python3
"""Assemble a shareable prototype project from the template.

Usage: python3 assemble.py <prototype.html> <target-dir>
                           [--comments <https://worker-host>] [--room <name>]

- copies the template into <target-dir>
- puts the prototype at public/index.html with the comment overlay injected
- ensures viewport-fit=cover so safe-area insets work on iOS
- fills the login page title from the prototype's <title>

--comments points the overlay at a comments host that is not this deployment —
a Cloudflare Worker, typically, because Vercel's free Blob quota is counted per
account and runs out (see docs/CLOUDFLARE.md). The page is still served and
gated here; only the comments live there. --room names the room on that host,
so one Worker can hold several prototypes; it defaults to the target directory's
name. Editing the tag by hand afterwards does the same thing and is easier to
get subtly wrong.
"""
import json
import re
import shutil
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / "template"


COMMENTS_HOST_DOC = """/* Where this deployment's comments live, when they do not live here.

   Written by assemble.py (from --comments/--room) and by update.py (read off
   the overlay tag on public/index.html, so an older install gets it too). Empty
   means the comments are served by this deployment itself and there is nothing
   to bridge to. */
export const COMMENTS_HOST = {host};
export const COMMENTS_ROOM = {room};
"""


def write_comments_host(target: Path, host: str, room: str) -> None:
    (target / "lib" / "comments-host.js").write_text(
        COMMENTS_HOST_DOC.format(host=json.dumps(host), room=json.dumps(room)), encoding="utf-8"
    )


def opt(args: list[str], name: str) -> str | None:
    flag = f"--{name}"
    return args[args.index(flag) + 1] if flag in args and args.index(flag) + 1 < len(args) else None


def main() -> None:
    args = sys.argv[1:]
    comments = opt(args, "comments")
    room = opt(args, "room")
    positional = []
    skip = False
    for i, a in enumerate(args):
        if skip:
            skip = False
            continue
        if a.startswith("--"):
            skip = True
            continue
        positional.append(a)
    if len(positional) != 2:
        sys.exit("usage: assemble.py <prototype.html> <target-dir> [--comments <url>] [--room <name>]")
    src = Path(positional[0]).expanduser()
    target = Path(positional[1]).expanduser()
    html = src.read_text(encoding="utf-8")
    if target.exists() and any(target.iterdir()):
        sys.exit(f"ERROR: {target} already exists and is not empty")

    shutil.copytree(TEMPLATE, target, dirs_exist_ok=True)

    if comments:
        host = comments.rstrip("/")
        # The room defaults to the project's own name: a Worker holds many, and
        # two prototypes sharing one room is the mistake this prevents.
        name = room or target.name
        overlay_tag = f'<script src="{host}/overlay.js" data-room="{name}" defer></script>'
    else:
        overlay_tag = '<script src="/overlay.js" defer></script>'
    if "overlay.js" not in html:
        # AI-generated prototypes are often fragment-style (no <body> at all);
        # appending at the end is equivalent — browsers auto-place it in body.
        if "</body>" in html:
            html = html.replace("</body>", f"  {overlay_tag}\n</body>", 1)
        else:
            html = html.rstrip() + f"\n{overlay_tag}\n"

    viewport = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />'
    meta = re.search(r'<meta[^>]*name="viewport"[^>]*>', html)
    if meta and "viewport-fit" not in meta.group(0):
        patched = re.sub(r'content="([^"]*)"', r'content="\1, viewport-fit=cover"', meta.group(0), count=1)
        html = html.replace(meta.group(0), patched, 1)
    elif not meta:
        if "<head>" in html:
            html = html.replace("<head>", f"<head>\n{viewport}", 1)
        else:
            charset = re.search(r'<meta[^>]*charset[^>]*>', html)
            if charset:
                html = html.replace(charset.group(0), charset.group(0) + "\n" + viewport, 1)
            else:
                html = viewport + "\n" + html
    if 'rel="icon"' not in html and "rel='icon'" not in html:
        favicon = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'
        html = html.replace(viewport, viewport + "\n" + favicon, 1) if viewport in html else favicon + "\n" + html

    (target / "public" / "index.html").write_text(html, encoding="utf-8")

    m = re.search(r"<title>([^<]{1,60})</title>", html)
    title = (m.group(1).strip() if m else src.stem) or src.stem
    login = target / "public" / "login.html"
    # The gate signs the reviewer in to the comments host as well, so one
    # password is typed once. Without this line the panel asks for it again.
    meta = (
        f'<meta name="fp-comments" content="{comments.rstrip("/")}" data-room="{room or target.name}" />'
        if comments
        else ""
    )
    login.write_text(
        login.read_text(encoding="utf-8")
        .replace("{{PROTO_TITLE}}", title)
        .replace("{{COMMENTS_META}}", meta),
        encoding="utf-8",
    )
    # The same two facts on the server side, for /api/comments-token: a reader
    # already past the gate gets a comments session without typing anything.
    write_comments_host(target, comments.rstrip("/") if comments else "", (room or target.name) if comments else "")
    where = f", comments on {comments.rstrip('/')} in room \"{room or target.name}\"" if comments else ""
    print(f"OK: assembled at {target} (title: {title}{where})")


if __name__ == "__main__":
    main()
