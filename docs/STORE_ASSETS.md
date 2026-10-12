# Store images and icon assets

Version 0.1.13 uses the official Midea lifestyle photograph recommended by the
Athom reviewer on 12 October 2026. It shows an air conditioner installed in a
room with visible airflow. The published cover is a 10:7 crop of that photograph,
converted to PNG and resized without generating, repainting or compositing any
objects. The complete air conditioner remains visible in all three sizes.

The indoor driver retains the MI2 duct product photograph on its original white
background, resized square. The cover illustrates Midea climate control, not an
additional supported model; the driver and setup documentation continue to
specify the CCM15 local gateway. These are brand/product images, not photographs
of the owner's home or proof of an exact serial/model match.

| Asset | Dimensions | File |
|---|---|---|
| App small | 250 × 175 | assets/images/small.png |
| App large | 500 × 350 | assets/images/large.png |
| App xlarge | 1000 × 700 | assets/images/xlarge.png |
| Indoor small | 75 × 75 | drivers/indoor/assets/images/small.png |
| Indoor large | 500 × 500 | drivers/indoor/assets/images/large.png |
| Indoor xlarge | 1000 × 1000 | drivers/indoor/assets/images/xlarge.png |

The app icon is a monochrome SVG derived from the official Midea Free Logo Black RGB vector. It has a transparent 960 × 960 canvas and complete logo contours. The driver icon is a distinct 960 × 960 line drawing created in code. Both icons and final image variants were visually inspected. The submitted brand assets are not covered by the code's MIT grant and do not imply Midea endorsement.

## Primary sources

- [Midea lifestyle image recommended by the reviewer](https://web-res.midea.com/content/dam/midea-aem/global/official/pcp-h-c/splitac/ez2/turboject-engine-cover-1920x800-pc.jpg/jcr:content/renditions/turboject-engine-cover-1920x800-pc.webp): 1920 × 800 source, SHA-256 `997bfc318ec8748ec4ae82cdd0aaa696d342ffc97ea6a7a98b0efcc2d6352547`.
- [Midea MI2 medium static pressure duct](https://mbt.midea.com/global/hvac-goods/midea-products-category/vrfs/vrf-idu/medium-static-pressure-duct-a5-duct): gallery1.jpg.
- [Midea professional brand resources](https://www.mideacomfortna.ca/forpros.html): Midea Logos download, Midea Free Logo Black RGB vector.

Athom reviews images and brand presentation individually. Local validator success does not constitute image or trademark approval. No Homey device, logo, app screenshot or invented model label appears in these assets.

## Private prototype history

Earlier representative images were created with the built-in image generation tool. They were replaced by official product imagery for this submission. Their exact prompts, six former final paths and retained originals are recorded in [history/STORE_ASSETS-generated-prototypes.md](history/STORE_ASSETS-generated-prototypes.md). Those generated prototypes are excluded from the installed and public source packages. No CLI generation fallback was used.

Build 4 / v0.1.12 used a wall-mounted indoor product photo on white as its app
cover. Athom rejected that presentation on 12 October 2026, requesting a
lifestyle or brand image. Version 0.1.13 replaces only the three app cover PNGs;
driver images and SVG icons retain their previous bytes.
