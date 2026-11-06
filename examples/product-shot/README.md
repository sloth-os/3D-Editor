# Vellune: a perfume product shot built through MCP

![Final path-traced still](render.png)

An original product visualisation of an invented eau de parfum called **Vellune**. The name and
the crescent-moon emblem were made up for this scene ("lune" is French for moon); they do not
depict any real brand or product. Every object, material, light, the camera, the animation and the
renders are made by [`build.mjs`](build.mjs) calling the editor's MCP server, the same way an
external AI agent would. The script only does arithmetic (profile points, label layout, camera
placement), checks the results it reads back and saves the files the server returns.

| File | What it is |
| --- | --- |
| `build.mjs` | Reproducible build: deletes and recreates the `product-shot` project, builds and verifies the scene, renders the outputs |
| `render.png` | Final still, 1280×720, path traced and denoised |
| `contact_sheet.png` | Turntable check: 12 of the 36 loop frames, path traced |
| `preview.gif` | The full 36-frame turntable loop, 480×270 at 12 fps, path traced at low samples and denoised |
| `scene.glb` | glTF 2.0 export of the scene (written by `--export-only`, see below) |

## The scene

Everything is built at real-world scale (metres, Z up). The bottle is 8.4 cm wide, 7 cm deep and
12.9 cm tall with its cap; the plinth is 17 cm across and 5 cm high.

* **Bottle.** A thick-walled glass flacon with an elongated octagonal cross-section. Its profile
  (outer wall, domed shoulder, neck lip, inner cavity, thick glass base) is a POLY curve made with
  `curve.add_from_points`. A **SCREW** modifier with 8 steps revolves this wire profile directly;
  the 8 steps are the facets. The profile lies in the vertical plane at 22.5° so that a flat
  facet faces the camera, and the object is scaled 1.2× along X to widen that front facet for the
  label. A **SMOOTH_BY_ANGLE** modifier keeps the facet edges sharp and the shoulder smooth. The
  glass has a faint cool tint (transmission 1, IOR 1.5, roughness 0). The bottle stands 0.2 mm
  above the plinth, which is about half a pixel in the still (see the limitations for why).
* **Perfume.** A second revolved profile follows the cavity with a 0.4 mm air gap. The liquid is
  amber (transmission 1, IOR 1.36).
* **Cap.** A stepped octagonal cap revolved the same way, its facets aligned with the bottle. It
  uses the `gold` preset, polished to roughness 0.14.
* **Front label.** Six curve and text objects, created in a single `batch` (one undo step):
  * a black enamel plate: a filled, extruded 2D rounded rectangle with a clear coat;
  * a thin gold frame: a closed 3D curve with a round `bevel_depth`;
  * a crescent emblem: a filled 2D curve;
  * the name **VELLUNE** and the line **EAU DE PARFUM**: extruded text (`object.text_add`);
  * a gold rule between the two lines.

  The label pieces are parented to the bottle and sit 0.06 mm in front of the glass. On the
  30 × 27 mm plate the name is 21 mm wide, about as wide as the subline, and keeps 2.8 mm of clear
  space to the frame on each side.
* **Pedestal and props.** A marble plinth and a marble column, both revolved profiles with 4 mm and
  2.5 mm round rims, use the procedural `marble` preset re-tuned with `material.procedural_set`.
  A polished gold sphere sits on the column, and three cream "pearls" (porcelain preset with a
  clear coat and sheen) lie on the floor in front.
* **Cyclorama.** A seamless studio sweep: an open 2D curve (floor, 26 cm cove, wall) whose
  `extrude` turns it into a 1.6 m wide sheet. The paper is a matte deep wine red.
* **Lighting.** Three-point lighting with area lights, plus a background light and a reflector:
  * **key**: a large warm softbox (0.75 × 0.85 m) high front-left, for the label, cap and plinth;
  * **fill**: a cool vertical strip (0.12 × 0.6 m) on the right. Area lights are invisible to the
    camera but appear in reflections, so the front-right facet mirrors it as a bright stripe;
  * **rim**: a narrow strip (0.1 × 0.5 m) behind on the left for the glass, cap and plinth edges;
  * **backdrop glow**: a soft SPOT pooled on the cove right behind the bottle. The camera sees
    this warm glow through the perfume, which makes the liquid shine amber, and it frames the
    bottle like a rising moon;
  * **reflector card**: a weak, wide AREA light (0.9 × 0.3 m, 0.5 W) just behind the camera and
    to its right. It adds almost no light to the scene, but the cap's polished front facet mirrors
    it as a soft gold gradient. Without it, that facet reflected the dark space around the camera
    and read as a black stripe between two bright side facets.

  The STUDIO environment at strength 0.2 adds subtle reflections. The view transform is
  **Khronos PBR Neutral**, which keeps product colours faithful.
* **Camera.** An 85 mm lens at about 1.05 m. **Depth of field** at f/4
  (`camera.properties_set` `dof_use`, `dof_aperture_fstop`) is focused through `dof_focus_object`
  on a "Focus Point" empty at the centre of the label, so the column and the backdrop fall off
  softly. The pearls lie within a few centimetres of the focal plane and stay sharp.
* **Turntable.** `anim.turntable` orbits the *same* camera around the bottle. Its radius, height
  and start angle reproduce the still, so frame 1 is the still. The backdrop, the lights (with the
  reflector card), the props and the focus point are parented to the "Turntable Pivot" and turn
  with the camera. On screen the bottle and its plinth spin while the studio stays put, like on a
  real product turntable, and the focus stays on the front of the bottle. The loop is 36 frames
  long and seamless (CYCLIC extrapolation).

## Checks done by the build

After building, `build.mjs` reads the scene back and stops with an error if something is off:

* `get_scene` reports no evaluation `problems`;
* each of the five SCREW lathes (bottle, perfume, cap, plinth, column) has exactly the expected
  evaluated vertex count (`get_object` `data.evaluated`): one ring of its profile per step, with
  the profile points on the axis merged. A missing modifier or a wrong step count fails the build;
* the bottle has the designed size; the plinth top is at 5 cm and the bottle base 0.2 mm above
  it; the label plate sits on the front facet (gap below 0.2 mm); the name keeps at least 2.5 mm
  from the inner edge of the frame on both sides (measured 2.8 mm);
* `get_object` at frames 1, 10, 19, 28 and 37 gives the evaluated camera position: the azimuth
  advances by exactly a quarter turn every 9 frames, the radius stays 1.038 m, frame 37 equals
  frame 1 (seamless loop), and the evaluated `dof_focus_distance` stays constant (1.016 m). The
  reflector card keeps the same distance from the camera, so it travels with it;
* the bottle never moves.

The renders are checked before anything is written, so a failed or cut-short render never
replaces a good file:

* `render.png` must reach at least `--min-samples` (default: half of `--samples`) before its time
  limit stops it;
* `contact_sheet.png` and `preview.gif` must contain every requested frame and must not be
  truncated.

## Features, operators and tools used

* **MCP tools:**
  * projects: `list_projects`, `delete_project`, `create_project`;
  * building: `set_scene_settings`, `add_object` (empty, camera, AREA and SPOT lights with their
    shape, size and cone given directly), `add_modifier`, `set_material`, `set_active_camera`,
    `run_operator`, `batch`;
  * checking: `get_scene` (problems, base and evaluated counts), `get_object` (evaluated vertex
    counts and bounds, and evaluated values at a frame: camera and card positions, focus
    distance);
  * output: `render_image` (PATHTRACER and RASTER), `render_animation` (CONTACT_SHEET and GIF),
    `export_scene` (glb).
* **Curves and text:** `curve.add_from_points` (POLY curves in 2D and 3D, `cyclic`, `fill_mode`,
  `extrude`, `bevel_depth`) and `object.text_add`.
* **Modifiers:** SCREW on wire curves (lathe) and SMOOTH_BY_ANGLE.
* **Shading:**
  * presets via `material.preset_apply` (gold, marble, porcelain);
  * procedural textures via `material.procedural_set` (MARBLE);
  * new materials and edits via `material.new` and `material.update` (clear coat, sheen);
  * assignment via `object.material_assign`;
  * transmission and IOR via `set_material`.
* **Lights and camera:** `object.light_add` settings through `add_object` (`shape`, `size`,
  `size_y`, `spot_size`, `spot_blend`), `camera.properties_set` (depth of field with a focus
  object, clipping), `object.look_at`.
* **Layout:** `object.select` and `object.shade_smooth` (in a batch), `object.parent_to`.
* **Animation:** `anim.turntable`.
* **Rendering:** the path tracer with denoising, `max_bounces` 10, a time limit, depth of field and
  the NEUTRAL view transform.

## Rebuild

Start a server (any port and data directory; run `npm run build` first if `apps/server/dist` is
missing), then run the script from the repository root. It deletes and recreates the project
`product-shot` on that server and stops with an error on the first failing tool call or check.

```bash
PORT=4505 DATA_DIR=/tmp/ps-data RENDER_WORKERS=3 node apps/server/dist/main.js &   # or: npm start
MCP_URL=http://127.0.0.1:4505/mcp node examples/product-shot/build.mjs                # = --final
MCP_URL=http://127.0.0.1:4505/mcp node examples/product-shot/build.mjs --build-only   # scene only
MCP_URL=http://127.0.0.1:4505/mcp node examples/product-shot/build.mjs --export-only  # scene.glb only
```

| Mode flag | Runs | Time (3 render threads) |
| --- | --- | --- |
| `--final` (default) | Build and verify, then `render.png`, `contact_sheet.png` and `preview.gif` | about 11 min |
| `--build-only` | Build and verify the project only, no renders | about 1 s |
| `--preview` | Build plus a RASTER and a 640×360 path-traced preview (64 samples, at most 60 s) in `--out-dir` (default `/tmp/product-shot-previews`) | about 1 min |
| `--still` | Build plus `render.png` only | about 7.5 min |
| `--anim` | Build plus `contact_sheet.png` and `preview.gif` only | about 3 min |
| `--export-only` | Build plus `scene.glb` only, no renders | about 2 s |

Options:

* `--out-dir <dir>` redirects the outputs;
* `--samples <n>` (default 256) and `--time-limit <s>` (default 450) set the still's samples and
  wall-clock budget;
* `--min-samples <n>` (default: half of `--samples`) is the fewest samples the still may stop at;
  below it the build fails and leaves `render.png` as it was;
* `--anim-samples <n>` (default 16) sets the GIF samples (the contact sheet uses twice as many).

A value flag without its value (for example `--out-dir` with the path forgotten) is an error.
`MODE=build|preview|still|anim|export|full` is accepted as an alias of the mode flags.

## Final production run

`render.png`, `contact_sheet.png` and `preview.gif` come from a single run of `build.mjs --final`
against a freshly started server with a new, empty data directory, which is also the proof that
the project rebuilds from scratch:

```bash
PORT=4555 DATA_DIR=/tmp/ps-final RENDER_WORKERS=3 node apps/server/dist/main.js &
MCP_URL=http://127.0.0.1:4555/mcp node examples/product-shot/build.mjs --final
```

Measured on 2026-11-06 on 4 CPU cores shared with other jobs, with 3 render threads:

| Stage | Time | Result |
| --- | --- | --- |
| Build and verify (`fresh project` … `verify scene`) | 1.2 s | 23 objects, 19,060 evaluated triangles, 8 materials; every check passed |
| `render.png` | 452 s | 1280×720 path traced: 183 of the 256 requested samples per pixel (the 450 s time limit stopped it), denoised; 749 KiB |
| `contact_sheet.png` | 40 s | 12 frames (1, 4, … 34) as 320×180 tiles, 32 samples, denoised; 862 KiB |
| `preview.gif` | 152 s | all 36 frames, 480×270, 16 samples, denoised, 12 fps; 1.6 MB |
| Whole script | 646 s (10 min 46 s) | exit code 0 |

## Known limitations and workarounds

* **No BEVEL modifier on the plinth and column.** The Bevel modifier with more than one segment
  cuts a small notch into the rounded edge at every vertex where two beveled edges meet an
  unbeveled one, so a beveled cylinder shows a jagged zig-zag along its rims (it was visible in
  the first version of this render). The plinth and the column are therefore revolved profiles
  with round fillets, which also give perfectly smooth rims.
* **The glass touches nothing.** The path tracer treats every transmissive surface as a boundary
  between air and the material, so a liquid surface cannot share a boundary with the glass. The
  perfume is a separate body with a 0.4 mm air gap, which adds faint bright outlines where it
  meets the glass. The bottle also stands 0.2 mm above the plinth. When its bottom face and the
  marble top shared a plane, the path tracer used either surface at random for rays refracted
  through the thick base, which left a grainy grey band in it. `scene.raycast` with `all: true`
  also lists only one of two coincident surfaces, so the build checks the gap with `get_object`
  bounds instead.
* **Lamps are invisible to the camera** in the path tracer and appear only in reflections. The
  glow behind the bottle is light pooled on the backdrop, not a visible lamp, and the strip
  highlights on the facets are reflections of the fill and key lights.
* **RASTER previews** have no shadows and no refraction: the glass is drawn as smooth tinted
  transparency. Judge the glass, the liquid and the depth of field only in path-traced renders
  (`--preview` makes one).
* **Inspection counts.** `get_scene` / `get_object` evaluated counts use the modifiers' viewport
  settings. The script sets SCREW `render_steps` equal to `steps`, so what the tools report is what
  renders.
* **Animation quality.** The contact sheet (32 samples per pixel) and the GIF frames (16 samples)
  are denoised at low sample counts, so the glass shows slight blotches and fine detail is
  smoothed; the GIF's 256-colour palette with Bayer dithering leaves a fine dot pattern in the
  backdrop gradient.
* **Focus distance in the build log.** The `camera` line of the log prints the result of
  `camera.properties_set`, which shows `dof_focus_distance: 10`: the stored default, which
  `dof_focus_object` overrides. The distance the renders use (1.016 m, the depth of the label) is
  the evaluated value that `get_object` reports and the turntable check prints.
* **glTF export.** `scene.glb` is written by `--export-only`; the file in this folder predates the
  current scene and is regenerated in a later pass with the finished exporter. glTF has no area
  lights (the exporter warns and writes the four area lights as point lights), and the
  procedural marble is baked to textures on generated (Smart UV Project) UVs.
