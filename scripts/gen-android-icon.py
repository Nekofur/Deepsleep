"""生成占位应用图标：蓝色圆角方块 + 白色对话气泡 + DS 字样。

输出到 android/app/src/main/res 下的 mipmap-*dpi：
- ic_launcher.png / ic_launcher_round.png：Android 7.x（API 24-25）用的传统图标
- ic_launcher_foreground.png：Android 8+ 自适应图标的前景层（108dp 画布，中间约 66% 为安全区）

用法（需要 Pillow）：
    python scripts/gen-android-icon.py

换正式图标时更省事的做法是用 @capacitor/assets，本脚本只是没有设计稿时的占位方案。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

RES = Path(__file__).resolve().parent.parent / "android/app/src/main/res"
BG = (11, 87, 208, 255)
FG = (255, 255, 255, 255)

# 传统图标尺寸
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# 自适应图标前景层尺寸（108dp）
FOREGROUND = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\msyhbd.ttc",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def draw_bubble(size: int, *, background: bool) -> Image.Image:
    """画一个圆角方块（可选）+ 白色对话气泡 + DS。"""
    scale = 4  # 先大后缩，边缘更平滑
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if background:
        radius = int(s * 0.22)
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # 对话气泡占画面 62%，居中略偏上
    w = int(s * 0.62)
    h = int(s * 0.5)
    left = (s - w) // 2
    top = int(s * 0.2)
    d.rounded_rectangle([left, top, left + w, top + h], radius=int(h * 0.32), fill=FG)
    # 气泡下方的小尾巴
    tail_w = int(w * 0.18)
    d.polygon(
        [
            (left + int(w * 0.26), top + h),
            (left + int(w * 0.26) + tail_w, top + h),
            (left + int(w * 0.2), top + h + int(h * 0.24)),
        ],
        fill=FG,
    )

    # 气泡里的 DS
    font = load_font(int(h * 0.52))
    text = "DS"
    box = d.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    d.text(
        (left + (w - tw) // 2 - box[0], top + (h - th) // 2 - box[1]),
        text,
        font=font,
        fill=BG,
    )
    return img.resize((size, size), Image.LANCZOS)


def round_mask(img: Image.Image) -> Image.Image:
    size = img.size[0]
    scale = 4
    s = size * scale
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, s - 1, s - 1], fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = img.copy()
    out.putalpha(mask)
    return out


def main() -> None:
    for dpi, size in LEGACY.items():
        folder = RES / f"mipmap-{dpi}"
        folder.mkdir(parents=True, exist_ok=True)
        icon = draw_bubble(size, background=True)
        icon.save(folder / "ic_launcher.png")
        round_mask(icon).save(folder / "ic_launcher_round.png")

    for dpi, size in FOREGROUND.items():
        folder = RES / f"mipmap-{dpi}"
        folder.mkdir(parents=True, exist_ok=True)
        # 前景层不加背景色（背景由自适应图标的 background 层提供），内容缩到安全区内
        fg = draw_bubble(int(size * 0.62), background=False)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        offset = (size - fg.size[0]) // 2
        canvas.paste(fg, (offset, offset), fg)
        canvas.save(folder / "ic_launcher_foreground.png")

    print(f"icons written to {RES}")


if __name__ == "__main__":
    main()
