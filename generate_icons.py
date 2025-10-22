
from PIL import Image, ImageDraw
import math
import os

def create_hexagon_icon(size, color, filename):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    center_x, center_y = size // 2, size // 2
    radius = size // 2 - 1 # Leave a small border

    points = []
    for i in range(6):
        angle_deg = 60 * i - 30 # Start with a flat top
        angle_rad = math.radians(angle_deg)
        x = center_x + radius * math.cos(angle_rad)
        y = center_y + radius * math.sin(angle_rad)
        points.append((x, y))

    draw.polygon(points, fill=color)
    img.save(filename)

# Define the sizes and color
sizes = [16, 48, 128]
green_color = (0, 128, 0, 255) # RGBA for green

# Define the base path relative to where you run the script
# Assuming you run this script from /Users/peterlevi/dev/bggstats3/
output_dir = "assets/"
os.makedirs(output_dir, exist_ok=True)

# Generate the icons
for size in sizes:
    filename = os.path.join(output_dir, f"icon{size}.png")
    create_hexagon_icon(size, green_color, filename)
    print(f"Generated {filename}")

print("All hexagon icons generated successfully.")
