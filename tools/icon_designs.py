"""앱 아이콘 후보 디자인(Pillow). 후보 비교표 생성과, 선택한 디자인으로 홈 화면용 PNG 생성에 함께 쓴다.
사용법:
  python tools/icon_designs.py sheet <출력.png>      후보 6개를 한 장에 그려 비교표를 만든다
  python tools/icon_designs.py apply <A~F>           선택한 디자인으로 icon-180/192/512.png 와 icon.svg 를 다시 만든다(SVG 는 후보 A·B·E·F 만 지원 안 함 → 별도 처리)
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_BOLD = "C:/Windows/Fonts/malgunbd.ttf"
FONT_REG = "C:/Windows/Fonts/malgun.ttf"


def hexc(s, a=255):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), a)


def gradient(n, c1, c2, angle=135):
    """n x n 대각 그라데이션(c1 -> c2)."""
    # 2배 크기에서 회전한 뒤 가운데를 잘라 쓰면 모서리에 빈 곳이 생기지 않는다
    big = Image.linear_gradient("L").resize((n * 2, n * 2))  # 위(검정) -> 아래(흰색)
    big = big.rotate(angle - 90, resample=Image.BICUBIC, expand=False)
    base = big.crop((n // 2, n // 2, n // 2 + n, n // 2 + n))
    a, b = Image.new("RGBA", (n, n), c1), Image.new("RGBA", (n, n), c2)
    return Image.composite(b, a, base)


def mask_round(n, rounded):
    m = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(m)
    if rounded:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=255)
    else:
        d.rectangle([0, 0, n, n], fill=255)
    return m


def canvas(n, c1, c2, rounded, angle=135):
    bg = gradient(n, c1, c2, angle)
    out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask_round(n, rounded))
    return out


def thick_line(d, pts, w, fill):
    d.line(pts, fill=fill, width=int(w), joint="curve")
    for p in (pts[0], pts[-1]) + tuple(pts[1:-1]):
        d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=fill)


# --- 후보 A: 라인 차트 (민트 그라데이션 + 상승선) ---
def design_a(n, rounded):
    im = canvas(n, hexc("#0b8f82"), hexc("#3fd3bf"), rounded)
    d, k = ImageDraw.Draw(im), n / 128.0
    pts = [(22 * k, 92 * k), (46 * k, 64 * k), (62 * k, 78 * k), (98 * k, 36 * k)]
    thick_line(d, pts, 11 * k, hexc("#ffffff"))
    r = 12 * k
    d.ellipse([pts[-1][0] - r, pts[-1][1] - r, pts[-1][0] + r, pts[-1][1] + r], fill=hexc("#ffd166"))
    return im


# --- 후보 B: 캔들스틱 (한국 관례: 상승 빨강, 하락 파랑, 짙은 남색 배경) ---
def design_b(n, rounded):
    im = canvas(n, hexc("#0f2a43"), hexc("#1d4f73"), rounded)
    d, k = ImageDraw.Draw(im), n / 128.0
    red, blue, wick = hexc("#ff5b66"), hexc("#5b95ff"), hexc("#cfe0ee")
    candles = [(34, 46, 88, 62, 80, blue), (64, 38, 92, 52, 84, red), (94, 22, 78, 34, 66, red)]  # (x, 고, 저, 몸통 위, 몸통 아래, 색)
    for x, hi, lo, bt, bb, col in candles:
        d.line([(x * k, hi * k), (x * k, lo * k)], fill=wick, width=int(3 * k))
        d.rounded_rectangle([(x - 9) * k, bt * k, (x + 9) * k, bb * k], radius=int(3 * k), fill=col)
    return im


# --- 후보 C: '우' 모노그램 ---
def design_c(n, rounded):
    im = canvas(n, hexc("#0aa38f"), hexc("#14706f"), rounded)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT_BOLD, int(n * 0.62))
    bb = d.textbbox((0, 0), "우", font=f)
    d.text(((n - (bb[2] - bb[0])) / 2 - bb[0], (n - (bb[3] - bb[1])) / 2 - bb[1] - n * 0.03), "우", font=f, fill=hexc("#ffffff"))
    r = n * 0.045
    d.ellipse([n * 0.78 - r, n * 0.24 - r, n * 0.78 + r, n * 0.24 + r], fill=hexc("#ffd166"))
    return im


# --- 후보 D: 물방울 + 상승선 ('웅덩이' 이미지) ---
def design_d(n, rounded):
    im = canvas(n, hexc("#1aa6c9"), hexc("#0a6e8f"), rounded)
    d, k = ImageDraw.Draw(im), n / 128.0
    cx, cy, r, ay = 64 * k, 76 * k, 30 * k, 22 * k  # 원 중심·반지름, 꼭짓점 높이
    dist = cy - ay
    th = math.asin(r / dist)
    pts = []
    for sgn in (-1, 1):  # 접점
        ang = math.pi / 2 + sgn * (math.pi / 2 - th)
        pts.append((cx + r * math.cos(ang), cy - r * math.sin(ang)))
    d.polygon([(cx, ay), pts[1], pts[0]], fill=hexc("#ffffff"))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=hexc("#ffffff"))
    line = [(46 * k, 86 * k), (58 * k, 74 * k), (68 * k, 82 * k), (84 * k, 62 * k)]
    thick_line(d, line, 9 * k, hexc("#0a7f9c"))  # 작은 크기에서도 보이도록 굵게
    return im


# --- 후보 E: 성장 막대 (밝은 배경, 막대 3개) ---
def design_e(n, rounded):
    im = canvas(n, hexc("#ffffff"), hexc("#e3f5f1"), rounded, angle=90)
    d, k = ImageDraw.Draw(im), n / 128.0
    base = 104 * k
    for i, (h, c2) in enumerate([(26, "#3fbfae"), (46, "#0b9d8c"), (68, "#08756b")]):
        x0 = (24 + i * 28) * k
        d.rounded_rectangle([x0, base - h * k, x0 + 22 * k, base], radius=int(6 * k), fill=hexc(c2))
    r, cx, cy = 7 * k, (24 + 2 * 28 + 11) * k, 24 * k  # 가장 높은 막대 위의 주황 점
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=hexc("#ff9f43"))
    return im


# --- 후보 F: 골드 상승 화살표 (남색 배경, 고급스러운 느낌) ---
def design_f(n, rounded):
    im = canvas(n, hexc("#10243a"), hexc("#23496b"), rounded)
    d, k = ImageDraw.Draw(im), n / 128.0
    gold = hexc("#f6c453")
    thick_line(d, [(30 * k, 96 * k), (88 * k, 40 * k)], 13 * k, gold)
    d.polygon([(66 * k, 30 * k), (100 * k, 26 * k), (96 * k, 62 * k)], fill=gold)
    d.line([(26 * k, 106 * k), (102 * k, 106 * k)], fill=hexc("#5f86a8"), width=int(3 * k))
    return im


DESIGNS = {"A": ("라인 차트", design_a), "B": ("캔들스틱", design_b), "C": ("'우' 글자", design_c), "D": ("물방울+상승선", design_d), "E": ("성장 막대", design_e), "F": ("골드 화살표", design_f)}


def render(key, size, rounded=True):
    s = 4
    return DESIGNS[key][1](size * s, rounded).resize((size, size), Image.LANCZOS)


def sheet(out):
    cell, pad, lab = 256, 28, 40
    cols, rows = 3, 2
    W, H = cols * cell + (cols + 1) * pad, rows * (cell + lab) + (rows + 1) * pad
    im = Image.new("RGB", (W, H), (244, 247, 247))
    d = ImageDraw.Draw(im)
    fl, fs = ImageFont.truetype(FONT_BOLD, 24), ImageFont.truetype(FONT_REG, 16)
    for i, key in enumerate(DESIGNS):
        r, c = divmod(i, cols)
        x, y = pad + c * (cell + pad), pad + r * (cell + lab + pad)
        icon = render(key, cell)
        im.paste(icon, (x, y), icon)
        d.text((x + 4, y + cell + 6), "%s  %s" % (key, DESIGNS[key][0]), font=fl, fill=(20, 32, 40))
        small = render(key, 60)  # 홈 화면에서 보이는 작은 크기
        im.paste(small, (x + cell - 60, y + cell + 6 - 8), small)
    im.save(out)
    print("저장:", out, im.size)


def apply(key):
    for size in (180, 192, 512):
        path = os.path.join(ROOT, "icon-%d.png" % size)
        render(key, size, rounded=(size != 180)).save(path)
        print("저장:", path)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "sheet":
        sheet(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == "apply":
        apply(sys.argv[2].upper())
    else:
        print(__doc__)
