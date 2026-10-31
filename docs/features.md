# Feature matrix (vs. Blender)

This editor follows Blender's workflow, naming and keymap. The table lists what is implemented
today and what is not, by Blender area. Every implemented action is an operator, so it is
available from menus/hotkeys, the F3 search, the JavaScript console **and MCP agents**.

| Blender area | Status | Details |
| --- | --- | --- |
| Interface | ✅ | Top bar menus, workspaces (Layout, Modeling, Shading, Animation, Scripting), 3D viewport with header/toolbar/sidebar (N)/navigation gizmo, outliner, properties editor, timeline, dope sheet, UV editor, info log, console, F3 search, Adjust Last Operation panel, preferences, resizable areas |
| Navigation | ✅ | Turntable orbit/pan/zoom (MMB, Alt+LMB emulation, touch, trackpad), numpad views with auto-ortho, camera view, align camera to view, frame selected/all, follow another user's view |
| Object mode | ✅ | Add primitives/empties/lights/cameras, select (click, box, all/invert, by type, pattern), G/R/S with axis/plane constraints, numeric input, snapping, gizmo, pivot modes, duplicate (linked), delete, join, parent/clear parent, apply transforms, set origin, shade smooth/flat/auto smooth, hide/reveal, collections, convert (apply modifiers), 3D cursor and snap menu |
| Edit mode (meshes) | ✅ | Vertex/edge/face select modes, click/box/loop/ring/linked/more/less/random/non-manifold/by-normal selection with occlusion; extrude (region, individual, edges, vertices), inset, bevel, loop cut, subdivide, poke, merge, remove doubles, delete/dissolve, fill/new face, bridge edge loops, spin, symmetrize, solidify, split, separate, duplicate, triangulate/tris-to-quads, normals, smooth, seams/sharp/crease, proportional editing |
| UV editing | 🟡 | Cube/cylinder/sphere projection, smart project with packing, reset, UV editor view. No interactive UV editing or conformal (LSCM) unwrap |
| Modifiers | ✅ | Subdivision Surface, Mirror, Array, Solidify, Bevel, Boolean, Triangulate, Weld, Decimate, Wireframe, Screw, Edge Split, Build, Displace, Cast, Simple Deform, Smooth, Wave, Shrinkwrap, Smooth by Angle — viewport/render/edit-mode toggles, reorder, apply, copy |
| Sculpt & paint | 🟡 | Sculpt mode (draw, clay, inflate, smooth, flatten, pinch, grab; X symmetry), vertex paint. No dynamic topology, multires, masks or texture paint |
| Materials | 🟡 | Principled BSDF parameters (base color, metallic, roughness, IOR, transmission, emission, alpha/blend, coat, sheen), image textures, material slots per face. No shader node editor |
| Lights, cameras, world | ✅ | Point/sun/spot/area lights with shadows, perspective/orthographic cameras (lens, sensor, shift, clipping), world color/strength and studio environment |
| Rendering | 🟡 | Viewport Wireframe/Solid/Material Preview/Rendered (rasterized PBR with shadows and tone mapping: AgX, Filmic/ACES, Neutral), F12 render at output resolution, transparent film, server-side CPU renderer. No path tracer (Cycles), no compositor |
| Animation | 🟡 | Keyframes on object/material/light/camera/world properties, Bezier (auto-clamped)/linear/constant interpolation, auto keying, timeline, dope sheet (move/delete keys), playback. No graph editor, NLA, drivers, constraints or shape keys |
| Import / export | ✅ | glTF 2.0 (.glb/.gltf) with hierarchy, materials, textures, cameras, lights and animation; OBJ; STL; PLY |
| Scripting | 🟡 | JavaScript console with the full operator API (`ops(id, params)`, `doc`, `state`); MCP for external agents. No Python |
| Collaboration | ✅ (beyond Blender) | Real-time multi-device sync, presence, per-user undo, offline merge |
| Not yet implemented | ❌ | Curves & text objects, armatures/rigging, physics & particles, geometry nodes, grease pencil, video sequencer, motion tracking, add-ons |
