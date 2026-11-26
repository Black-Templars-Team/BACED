"""Stage the public damage sim, optionally publishing it to GitHub Pages."""

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SITE = HERE / "site"
PAGES_URL = "https://black-templars-team.github.io/BACED/"
PAGES_REF = "refs/heads/gh-pages"
BODY = Path("data/body_geometry.js")
ACE_IMAGES = "data/ace_body_images.js"
FILES = (
    "index.html",
    "damage_model.js",
    "app.js",
    "balance_points.js",
    "balance.js",
    "data/page_data.js",
    "data/roster.js",
    ACE_IMAGES,
)


def read_assignment(path, name):
    prefix = f"window.{name} ="
    text = path.read_text(encoding="utf-8").lstrip()
    if not text.startswith(prefix):
        raise ValueError(f"{path.name}: expected {prefix}")
    # page_data.js appends a loader after the initial assignment.
    obj, _ = json.JSONDecoder().raw_decode(text[len(prefix):].lstrip())
    if not isinstance(obj, dict):
        raise ValueError(f"{path.name}: expected a JSON object")
    return obj


def build_site():
    if not all((HERE / path).is_file() for path in ("index.html", "data/page_data.js")):
        raise ValueError("run extract.py and build_page.py first")

    with tempfile.TemporaryDirectory(dir=HERE) as tmp:
        staging = Path(tmp)
        (staging / "data").mkdir()
        for path in FILES:
            shutil.copyfile(HERE / path, staging / path)
        (staging / ".nojekyll").touch()

        image = None
        if (HERE / BODY).is_file():
            geometry = read_assignment(HERE / BODY, "BODY_GEOMETRY")
            image = geometry.pop("image", None)
            (staging / BODY).write_text(
                "window.BODY_GEOMETRY = " + json.dumps(geometry, separators=(",", ":")) + ";\n",
                encoding="utf-8",
            )

        private_uri = image.encode("utf-8") if image else None
        for path in staging.rglob("*"):
            if not path.is_file():
                continue
            content = path.read_bytes()
            # ACE medical menu images are public; the aim figure's picture is not.
            if ((path.relative_to(staging).as_posix() != ACE_IMAGES and b"data:image/png;base64" in content)
                    or (private_uri and private_uri in content)):
                raise ValueError(f"private body picture found in {path.relative_to(staging)}")

        if SITE.exists():
            shutil.rmtree(SITE)
        staging.rename(SITE)


def git(*args, cwd=HERE, capture=False, check=True):
    return subprocess.run(["git", *args], cwd=cwd, check=check, text=True,
                          stdout=subprocess.PIPE if capture else None)


def publish(generated):
    remote = git("ls-remote", "--refs", "origin", PAGES_REF, capture=True).stdout.strip()
    if remote:
        git("fetch", "--no-tags", "origin", PAGES_REF)
        base = "FETCH_HEAD"
    else:
        local = git("show-ref", "--verify", "--quiet", PAGES_REF, check=False)
        base = PAGES_REF if local.returncode == 0 else None

    with tempfile.TemporaryDirectory(prefix="damage-sim-pages-") as tmp:
        worktree = Path(tmp) / "worktree"
        git("worktree", "add", "--detach", "--no-checkout", str(worktree), base or "HEAD")
        try:
            if base is None:
                git("switch", "--orphan", "gh-pages", cwd=worktree)
            else:
                # Load the previous tree into the temp index so absent files are staged as deletions.
                git("read-tree", "HEAD", cwd=worktree)
            shutil.copytree(SITE, worktree, dirs_exist_ok=True)
            git("add", "--all", "--force", cwd=worktree)
            if git("status", "--porcelain", capture=True, cwd=worktree).stdout:
                git("commit", "-m", f"Damage sim: publish {generated}", cwd=worktree)
            git("push", "origin", f"HEAD:{PAGES_REF}", cwd=worktree)
        finally:
            git("worktree", "remove", "--force", str(worktree))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--push", action="store_true", help="publish to origin/gh-pages")
    args = parser.parse_args()
    try:
        build_site()
        print("Publishing:" if args.push else "Would publish:", flush=True)
        for path in sorted(SITE.rglob("*")):
            if path.is_file():
                print(f"  {path.relative_to(SITE).as_posix()} ({path.stat().st_size:,} bytes)")
        if args.push:
            generated = read_assignment(SITE / "data/page_data.js", "GAME_DATA").get("generated")
            if not isinstance(generated, str) or not generated.strip():
                raise ValueError("data/page_data.js has no game data generated time")
            publish(generated)
    except (OSError, ValueError, subprocess.CalledProcessError) as err:
        parser.exit(1, f"{parser.prog}: {err}\n")
    print(PAGES_URL)


if __name__ == "__main__":
    main()
