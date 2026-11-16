"""홈 화면용 PNG 아이콘 생성(icon.svg 와 같은 모양): icon-180.png(아이폰), icon-192.png, icon-512.png.
PIL(Pillow)이 있는 환경에서 한 번 실행하면 되고, 결과 PNG 는 저장소에 포함한다.
사용법: python tools/make_icons.py
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEAL, WHITE, YELLOW = (15, 107, 107, 255), (255, 255, 255, 255), (255, 209, 102, 255)


def draw(size, rounded=True):
    s = 4  # 4배로 그린 뒤 줄여 가장자리를 부드럽게
    n = size * s
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 26 / 128), fill=TEAL)
    else:  # 아이폰은 모서리를 직접 둥글게 처리하므로 꽉 찬 사각형이어야 모서리가 검게 나오지 않는다
        d.rectangle([0, 0, n, n], fill=TEAL)
    k = n / 128.0
    pts = [(18 * k, 40 * k), (44 * k, 40 * k), (64 * k, 92 * k), (84 * k, 40 * k), (110 * k, 40 * k)]
    w = int(10 * k)
    d.line(pts, fill=WHITE, width=w, joint="curve")
    for p in (pts[0], pts[-1], pts[2]):  # 선 끝을 둥글게
        d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=WHITE)
    cx, cy, r = 64 * k, 92 * k, 8 * k
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=YELLOW)
    return im.resize((size, size), Image.LANCZOS)


def main():
    for size in (180, 192, 512):
        path = os.path.join(ROOT, "icon-%d.png" % size)
        draw(size, rounded=(size != 180)).save(path)
        print("저장:", path)


if __name__ == "__main__":
    main()
