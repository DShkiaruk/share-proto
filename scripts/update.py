#!/usr/bin/env python3
"""Update the comment tool inside a project that already has it.

Usage: python3 update.py <project-dir> [--dry-run]

Copies the current `template/` over the project's copy of the tool and leaves
everything that belongs to the project alone: the prototype itself
(public/index.html), secrets, the Vercel link, anything the project added.
public/login.html carries the prototype's name, so it is rewritten with the
name already in use rather than the template's placeholder.

Which files an install needs depends on how it is served, and that is read off
the project rather than asked:

  api/ + middleware.js  → the Vercel edition
  server.js             → the zero-dependency local edition
  worker/               → the Cloudflare edition (redeploy it separately)

The point of a script rather than a list of paths in a runbook: the list drifts
every time the tool gains a file, and a missed file is a feature that silently
stops working in that one project.
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "template"

# Never overwritten: they are the project, not the tool.
KEEP = {"public/index.html"}
TITLED = "public/login.html"


def rel_files(base: Path):
    return sorted(p.relative_to(base).as_posix() for p in base.rglob("*") if p.is_file())


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    dry = "--dry-run" in sys.argv
    if len(args) != 1:
        sys.exit("usage: update.py <project-dir> [--dry-run]")
    target = Path(args[0]).expanduser().resolve()
    if not target.is_dir():
        sys.exit(f"ERROR: {target} is not a directory")

    has_api = (target / "api").is_dir()
    has_server = (target / "server.js").is_file()
    has_worker = (target / "worker").is_dir()
    if not (has_api or has_server):
        sys.exit(
            f"ERROR: {target} does not look like a share-proto project "
            "(no api/ and no server.js). Install it first — see SKILL.md."
        )

    # The local server only ships with the local edition; a Vercel project that
    # never had it should not grow one.
    skip = set(KEEP)
    if not has_server:
        skip.add("server.js")

    changed, added, kept = [], [], []
    for rel in rel_files(TEMPLATE):
        if rel in skip:
            kept.append(rel)
            continue
        src, dst = TEMPLATE / rel, target / rel
        if rel == TITLED:
            title = None
            if dst.is_file():
                m = re.search(r"<title>([^<]{1,80}) — protected prototype</title>", dst.read_text(encoding="utf-8"))
                title = m.group(1) if m else None
            if title is None:
                kept.append(rel + "  (no title found — left as it is)")
                continue
            new = src.read_text(encoding="utf-8").replace("{{PROTO_TITLE}}", title)
            if dst.read_text(encoding="utf-8") == new:
                continue
            if not dry:
                dst.write_text(new, encoding="utf-8")
            changed.append(f"{rel}  (kept the name “{title}”)")
            continue
        if not dst.exists():
            if not dry:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            added.append(rel)
        elif src.read_bytes() != dst.read_bytes():
            if not dry:
                shutil.copy2(src, dst)
            changed.append(rel)

    edition = "Vercel" if has_api else "local"
    print(f"{'Would update' if dry else 'Updated'} {target}  ({edition} edition"
          f"{' + worker' if has_worker else ''})")
    for label, items in (("updated", changed), ("added", added), ("left alone", kept)):
        if items:
            print(f"  {label}:")
            for i in items:
                print(f"    {i}")
    if not changed and not added:
        print("  already current — nothing to do")
        return
    print("\nNext:")
    if has_api:
        print("  vercel deploy --prod --yes")
        print(f"  bash {ROOT}/scripts/smoke.sh https://<domain> <team-password> <client-password>")
    else:
        print("  restart the server, then:")
        print(f"  bash {ROOT}/scripts/smoke.sh http://localhost:<port> <team-password> <client-password>")
    if has_worker:
        print("  cd worker && npx wrangler deploy   # the Worker edition ships separately")
    print("  Comments, screens and the learned map survive: they live in the store, not in these files.")


if __name__ == "__main__":
    main()
