from PIL import Image, ImageDraw
import math
import os
import sys

def create_hexagon_icon(size, color, filename, has_halo=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    center_x, center_y = size // 2, size // 2
    radius = size // 2 - 1 # Leave a small border

    # Draw red halo if active
    if has_halo:
        halo_radius = radius + 2
        halo_points = []
        for i in range(6):
            angle_deg = 60 * i - 30
            angle_rad = math.radians(angle_deg)
            x = center_x + halo_radius * math.cos(angle_rad)
            y = center_y + halo_radius * math.sin(angle_rad)
            halo_points.append((x, y))
        draw.polygon(halo_points, fill=(255, 0, 0, 255), outline=(255, 0, 0, 255))

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

# Check if --active flag is provided
generate_active = '--active' in sys.argv

# Generate the icons
for size in sizes:
    if generate_active:
        filename = os.path.join(output_dir, f"icon{size}_active.png")
        create_hexagon_icon(size, green_color, filename, has_halo=True)
        print(f"Generated {filename}")
    else:
        filename = os.path.join(output_dir, f"icon{size}.png")
        create_hexagon_icon(size, green_color, filename)
        print(f"Generated {filename}")

if generate_active:
    print("All active state hexagon icons with red halo generated successfully.")
else:
    print("All hexagon icons generated successfully.")
