"""Export meowdoku boards as a printable A4 PDF.

Only the coloured region blocks are drawn — no cats, no marks, no frames — on a
white page, so a level can be printed and solved with a pencil. --label adds the
level number in each board's corner, and is the only text this tool ever draws.

    python tools/gen-pdf.py --set 6 --level 1..10,51..60 --per-page 4

No third-party dependencies: the PDF is assembled by hand (see PdfDocument).
A board is nothing but filled rounded rectangles, so this costs far less than
pulling in a rendering library, and the output is a few KB per page.

Adding a black-and-white style later means subclassing BoardRenderer and
registering it in RENDERERS — colour is the only thing that distinguishes two
regions here, so a mono version has to replace the visualization itself
(hatching, outlines or letters) rather than tweak this one. Everything else —
level lookup, page layout, paging, the CLI — is style-agnostic on purpose.
"""

from __future__ import annotations

import argparse
import re
import zlib
from pathlib import Path
from typing import Iterator, List, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
LEVELS_DIR = ROOT / "levels"
GAME_JS = ROOT / "web" / "game.js"

# A4 portrait in PostScript points (1/72"), the unit every PDF coordinate uses.
PAGE_W, PAGE_H = 595.276, 841.890
MARGIN = 42.5   # 15mm — inside every consumer printer's unprintable edge
GUTTER = 20.0   # blank strip between two boards on the same page

# Boards per page -> (rows, cols). A4 is taller than it is wide, so the tall
# side always takes the extra row; that keeps each slot close to square, which
# is the shape a board wants.
GRIDS: dict[int, Tuple[int, int]] = {1: (1, 1), 2: (2, 1), 4: (2, 2), 6: (3, 2)}

Rgb = Tuple[float, float, float]


# ── Level loading ───────────────────────────────────────────────────────────

class Board:
    """One level's region grid. The solution line in the file is ignored —
    this tool prints puzzles, not answers."""

    def __init__(self, pack: str, index: int, n: int, regions: List[List[int]]):
        self.pack = pack
        self.index = index
        self.n = n
        self.regions = regions


def level_path(pack: str, index: int) -> Path:
    return LEVELS_DIR / pack / f"level_{pack}_{index:08d}.txt"


def load_board(pack: str, index: int) -> Board:
    path = level_path(pack, index)
    lines = [ln.rstrip("\n") for ln in path.read_text(encoding="utf-8").splitlines()
             if ln.strip() and not ln.startswith("#")]
    n = int(lines[0].strip())
    rows = lines[1:1 + n]
    if len(rows) != n or any(len(row) != n for row in rows):
        raise ValueError(f"{path}: expected {n} rows of {n} letters")
    regions = [[ord(ch) - ord("A") for ch in row] for row in rows]
    return Board(pack, index, n, regions)


def parse_level_spec(spec: str, count: int) -> List[int]:
    """"1..10,51..60" -> [1..10, 51..60]. Also accepts "5", "5-9" and "all"."""
    if spec.strip().lower() == "all":
        return list(range(1, count + 1))
    out: List[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d+)(?:\s*(?:\.\.|-)\s*(\d+))?", part)
        if not m:
            raise ValueError(f"cannot read level range {part!r}")
        lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))
        if hi < lo:
            raise ValueError(f"level range {part!r} runs backwards")
        out.extend(range(lo, hi + 1))
    return list(dict.fromkeys(out))  # keep order, drop repeats


def load_palette() -> List[Rgb]:
    """Read DEFAULT_REGION_COLORS out of game.js so print and screen can never
    drift apart. Parsing the JS beats keeping a second copy of the list here."""
    src = GAME_JS.read_text(encoding="utf-8")
    m = re.search(r"const DEFAULT_REGION_COLORS = \[(.*?)\];", src, re.S)
    if not m:
        raise SystemExit(f"{GAME_JS}: DEFAULT_REGION_COLORS not found")
    hexes = re.findall(r'"(#[0-9a-fA-F]{6})"', m.group(1))
    if len(hexes) < 12:
        raise SystemExit(f"{GAME_JS}: expected 12 region colours, found {len(hexes)}")
    return [(int(h[1:3], 16) / 255, int(h[3:5], 16) / 255, int(h[5:7], 16) / 255)
            for h in hexes]


# ── Minimal PDF writer ──────────────────────────────────────────────────────

class PdfDocument:
    """Filled paths on white pages — the whole PDF feature set this needs.

    Coordinates are given top-left origin, y growing downwards, and flipped on
    the way out; PDF's own bottom-left origin never leaks past this class.
    """

    KAPPA = 0.5523  # circle-to-bezier constant, for rounded corners

    def __init__(self, width: float = PAGE_W, height: float = PAGE_H):
        self.width = width
        self.height = height
        self._pages: List[List[str]] = []
        self._ops: List[str] | None = None
        self._uses_text = False

    def new_page(self) -> None:
        self._ops = []
        self._pages.append(self._ops)
        self.fill_color((1.0, 1.0, 1.0))
        self.rect(0, 0, self.width, self.height)

    def fill_color(self, rgb: Rgb) -> None:
        self._emit(f"{rgb[0]:.4f} {rgb[1]:.4f} {rgb[2]:.4f} rg")

    def rect(self, x: float, y: float, w: float, h: float) -> None:
        self._emit(f"{x:.2f} {self._flip(y, h):.2f} {w:.2f} {h:.2f} re f")

    def round_rect(self, x: float, y: float, w: float, h: float, r: float) -> None:
        r = min(r, w / 2, h / 2)
        if r <= 0:
            self.rect(x, y, w, h)
            return
        k = r * self.KAPPA
        x0, y0 = x, self._flip(y, h)        # bottom-left corner in PDF space
        x1, y1 = x + w, y0 + h              # top-right
        self._emit(
            f"{x0 + r:.2f} {y0:.2f} m "
            f"{x1 - r:.2f} {y0:.2f} l "
            f"{x1 - r + k:.2f} {y0:.2f} {x1:.2f} {y0 + r - k:.2f} {x1:.2f} {y0 + r:.2f} c "
            f"{x1:.2f} {y1 - r:.2f} l "
            f"{x1:.2f} {y1 - r + k:.2f} {x1 - r + k:.2f} {y1:.2f} {x1 - r:.2f} {y1:.2f} c "
            f"{x0 + r:.2f} {y1:.2f} l "
            f"{x0 + r - k:.2f} {y1:.2f} {x0:.2f} {y1 - r + k:.2f} {x0:.2f} {y1 - r:.2f} c "
            f"{x0:.2f} {y0 + r:.2f} l "
            f"{x0:.2f} {y0 + r - k:.2f} {x0 + r - k:.2f} {y0:.2f} {x0 + r:.2f} {y0:.2f} c "
            "h f"
        )

    def text(self, x: float, y: float, s: str, size: float) -> None:
        """Draw `s` left-aligned at x with its baseline at y, in Helvetica —
        one of the 14 fonts every PDF reader ships, so nothing is embedded."""
        self._uses_text = True
        esc = s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        self._emit(f"BT /F1 {size:.1f} Tf {x:.2f} {self.height - y:.2f} Td "
                   f"({esc}) Tj ET")

    def _flip(self, y: float, h: float) -> float:
        return self.height - (y + h)

    def _emit(self, op: str) -> None:
        if self._ops is None:
            raise RuntimeError("new_page() must come before any drawing")
        self._ops.append(op)

    def save(self, path: Path) -> None:
        # Object 1 is the catalog, 2 the page tree; each page then takes two
        # objects (the page dict and its content stream).
        objects: List[bytes] = []

        def add(body: bytes) -> int:
            objects.append(body)
            return len(objects)  # object numbers are 1-based

        add(b"<< /Type /Catalog /Pages 2 0 R >>")
        add(b"")  # placeholder, rewritten below once the kids are known
        resources = b""
        if self._uses_text:
            font_num = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
            resources = b"/Font << /F1 %d 0 R >>" % font_num
        kids = []
        for ops in self._pages:
            stream = zlib.compress("\n".join(ops).encode("ascii"))
            content_num = add(
                b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(stream)
                + stream + b"\nendstream")
            page_num = add(
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.3f %.3f] "
                b"/Resources << %s >> /Contents %d 0 R >>"
                % (self.width, self.height, resources, content_num))
            kids.append(page_num)
        objects[1] = (b"<< /Type /Pages /Count %d /Kids [%s] >>"
                      % (len(kids), b" ".join(b"%d 0 R" % k for k in kids)))

        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for num, body in enumerate(objects, start=1):
            offsets.append(len(out))
            out += b"%d 0 obj\n" % num + body + b"\nendobj\n"

        xref_at = len(out)
        out += b"xref\n0 %d\n" % (len(objects) + 1)
        out += b"0000000000 65535 f \n"
        for off in offsets:
            out += b"%010d 00000 n \n" % off
        out += (b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
                % (len(objects) + 1, xref_at))
        path.write_bytes(bytes(out))


# ── Board renderers ─────────────────────────────────────────────────────────

class BoardRenderer:
    """Draws one board into a square slot at (x, y) with the given side.

    Subclasses own the whole visualization; the caller only promises a white
    page and a square of space to fill (plus LABEL_SPACE underneath it when
    --label is on).
    """

    LABEL_SPACE = 14.0            # band reserved under a board for its number
    LABEL_SIZE = 9.0
    LABEL_COLOR: Rgb = (0.45, 0.45, 0.45)

    def draw(self, pdf: PdfDocument, board: Board, x: float, y: float, side: float) -> None:
        raise NotImplementedError

    def draw_label(self, pdf: PdfDocument, board: Board, x: float, y: float,
                   side: float) -> None:
        """The level number, under the board's bottom-left corner — so it stays
        with its puzzle when a page is cut apart. Part of the renderer so a
        future style can restyle it (a mono print would want plain black)."""
        pdf.fill_color(self.LABEL_COLOR)
        pdf.text(x, y + side + self.LABEL_SIZE + 1, str(board.index), self.LABEL_SIZE)


class ColorRenderer(BoardRenderer):
    """One flat colour block per cell, matching the web board: separate rounded
    squares on white, with the gaps — not any drawn line — dividing the grid."""

    GAP_RATIO = 0.10     # of one cell pitch; the app uses 4px on a ~40px cell
    RADIUS_RATIO = 0.22  # of the cell side; the app uses border-radius: 10px

    def __init__(self, palette: Sequence[Rgb]):
        self.palette = list(palette)

    def draw(self, pdf: PdfDocument, board: Board, x: float, y: float, side: float) -> None:
        n = board.n
        gap = side * self.GAP_RATIO / n
        cell = (side - (n - 1) * gap) / n  # gaps sit between cells only, as in CSS grid
        radius = cell * self.RADIUS_RATIO
        for r in range(n):
            for c in range(n):
                pdf.fill_color(self.palette[board.regions[r][c] % len(self.palette)])
                pdf.round_rect(x + c * (cell + gap), y + r * (cell + gap), cell, cell, radius)


RENDERERS = {"color": ColorRenderer}


# ── Page layout ─────────────────────────────────────────────────────────────

def slots(per_page: int, label_space: float = 0.0) -> Iterator[Tuple[float, float, float]]:
    """Yield (x, y, side) for each board slot on a page, top row first.

    `label_space` is reserved under every board, so turning labels on shrinks
    the boards a little instead of pushing text into the page margin.
    """
    rows, cols = GRIDS[per_page]
    # Boards are square, so whichever page axis runs out first sets the size.
    side = min((PAGE_W - 2 * MARGIN - (cols - 1) * GUTTER) / cols,
               (PAGE_H - 2 * MARGIN - (rows - 1) * (GUTTER + label_space)
                - label_space) / rows)
    # Centre the whole block rather than each board inside an oversized slot:
    # every gap between boards is then exactly GUTTER and the slack left over
    # on the long axis splits evenly between the two margins.
    pitch = side + label_space + GUTTER
    x0 = (PAGE_W - (cols * side + (cols - 1) * GUTTER)) / 2
    y0 = (PAGE_H - (rows * pitch - GUTTER)) / 2
    for r in range(rows):
        for c in range(cols):
            yield (x0 + c * (side + GUTTER), y0 + r * pitch, side)


def render(boards: Sequence[Board], renderer: BoardRenderer, per_page: int,
           label: bool = False) -> PdfDocument:
    pdf = PdfDocument()
    layout = list(slots(per_page, renderer.LABEL_SPACE if label else 0.0))
    for start in range(0, len(boards), per_page):
        pdf.new_page()
        for board, (x, y, side) in zip(boards[start:start + per_page], layout):
            renderer.draw(pdf, board, x, y, side)
            if label:
                renderer.draw_label(pdf, board, x, y, side)
    return pdf


# ── CLI ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export meowdoku boards as a printable A4 PDF (colour blocks only).",
        epilog="example: python tools/gen-pdf.py --set 6 --level 1..10,51..60 --per-page 4")
    parser.add_argument("--set", "--pack", dest="pack", required=True,
                        help="pack directory under levels/ (6..12, hard, bad)")
    parser.add_argument("--level", required=True,
                        help="levels to print: 1..10,51..60 or 5 or all")
    parser.add_argument("--per-page", type=int, default=4, choices=sorted(GRIDS),
                        help="boards per A4 page (default: 4)")
    parser.add_argument("--style", default="color", choices=sorted(RENDERERS),
                        help="print style (default: color)")
    parser.add_argument("--label", action="store_true",
                        help="print each board's level number in its corner")
    parser.add_argument("--out", type=Path, default=None,
                        help="output path (default: meowdoku_<set>.pdf)")
    args = parser.parse_args()

    pack_dir = LEVELS_DIR / args.pack
    if not pack_dir.is_dir():
        parser.error(f"no such pack: {pack_dir}")
    count = len(list(pack_dir.glob(f"level_{args.pack}_*.txt")))

    try:
        indices = parse_level_spec(args.level, count)
    except ValueError as e:
        parser.error(str(e))
    if not indices:
        parser.error("--level selected nothing")
    missing = [i for i in indices if not level_path(args.pack, i).exists()]
    if missing:
        shown = ", ".join(str(i) for i in missing[:10])
        more = f" (+{len(missing) - 10} more)" if len(missing) > 10 else ""
        parser.error(f"pack {args.pack} has {count} levels; missing: {shown}{more}")

    boards = [load_board(args.pack, i) for i in indices]
    renderer = RENDERERS[args.style](load_palette())
    pdf = render(boards, renderer, args.per_page, label=args.label)

    out = args.out or Path(f"meowdoku_{args.pack}.pdf")
    pdf.save(out)
    pages = (len(boards) + args.per_page - 1) // args.per_page
    print(f"wrote {out}: {len(boards)} level(s) from pack {args.pack}, "
          f"{pages} page(s) at {args.per_page} per page, {args.style} style"
          + (", labelled" if args.label else ""))


if __name__ == "__main__":
    main()
