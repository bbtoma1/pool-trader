"""홈 화면용 PNG 아이콘 생성: 선택한 디자인(D: 물방울 + 상승선)으로 icon-180.png(아이폰), icon-192.png, icon-512.png 를 만든다.
icon.svg 는 같은 모양을 손으로 옮긴 파일이다. 디자인을 바꾸려면 tools/icon_designs.py 의 후보를 고쳐 `python tools/icon_designs.py apply <A~F>` 를 쓴다.
사용법: python tools/make_icons.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from icon_designs import apply  # noqa: E402

if __name__ == "__main__":
    apply("D")
