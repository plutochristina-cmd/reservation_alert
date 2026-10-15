from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, output_path):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Background rounded rect with vibrant gradient
    padding = size // 16
    corner_radius = size // 4
    
    # Base background #0B0F19
    draw.rounded_rectangle(
        [(padding, padding), (size - padding, size - padding)],
        radius=corner_radius,
        fill=(11, 15, 25, 255)
    )
    
    # Vibrant border & inner glow (#03C75A)
    border_width = max(2, size // 48)
    draw.rounded_rectangle(
        [(padding, padding), (size - padding, size - padding)],
        radius=corner_radius,
        outline=(3, 199, 90, 255),
        width=border_width
    )
    
    # Central Bell / N logo
    center = size // 2
    r = size // 4
    # Draw bell shape or stylized 'N'
    # Stylized Naver 'N' in glowing green
    n_w = size // 3
    n_h = int(size * 0.45)
    x1 = center - n_w // 2
    y1 = center - n_h // 2
    x2 = center + n_w // 2
    y2 = center + n_h // 2
    
    bar_w = n_w // 3
    
    # Left bar
    draw.rectangle([(x1, y1), (x1 + bar_w, y2)], fill=(3, 199, 90, 255))
    # Right bar
    draw.rectangle([(x2 - bar_w, y1), (x2, y2)], fill=(3, 199, 90, 255))
    # Diagonal
    draw.polygon([(x1, y1), (x1 + bar_w, y1), (x2, y2), (x2 - bar_w, y2)], fill=(0, 230, 118, 255))
    
    # Small notification dot at top right
    dot_r = size // 10
    dot_cx = x2 + dot_r // 2
    dot_cy = y1
    draw.ellipse([(dot_cx - dot_r, dot_cy - dot_r), (dot_cx + dot_r, dot_cy + dot_r)], fill=(255, 61, 0, 255))
    
    img.save(output_path, "PNG")
    print(f"Created {output_path} ({size}x{size})")

os.makedirs("public", exist_ok=True)
create_icon(192, "public/icon-192.png")
create_icon(512, "public/icon-512.png")
