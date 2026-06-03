"""Oddiy PNG ikonkalar yaratish (PIL kerak)."""
try:
    from PIL import Image, ImageDraw
    for size in [192, 512]:
        img = Image.new('RGB', (size, size), '#0f172a')
        d = ImageDraw.Draw(img)
        m = size // 8
        d.ellipse([m, m, size-m, size-m], fill='#f43f5e')
        txt = '❤'
        d.text((size//2, size//2), txt, fill='white', anchor='mm',
               font=None)
        img.save(f'icon-{size}.png')
        print(f'icon-{size}.png yaratildi')
except ImportError:
    print('PIL yo\'q, ikonkalar yaratilmadi (muhim emas)')
