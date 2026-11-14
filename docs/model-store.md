# Model store

The model store finds props, buildings, vehicles, people and animals for a scene and inserts them
at their real size, standing on the ground, with their licence and author recorded. It searches
the editor's own catalog of original procedural models and, through the server, a few public
model libraries; nothing is downloaded before a model is inserted.

Contents: [providers](#providers) · [built-in models](#built-in-models) ·
[custom catalogs](#custom-catalogs) · [configuration](#configuration) ·
[search, lazy loading and the cache](#search-lazy-loading-and-the-cache) ·
[licences and attribution](#licences-and-attribution) · [inserting](#inserting) · [REST](#rest) ·
[MCP](#mcp) · [behind a proxy](#behind-a-proxy)

## Providers

| Id          | Provider                                                                                    | Search                    | Download                             | Licences                                     |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------ | -------------------------------------------- |
| `builtin`   | The editor's 170 procedural models (also in the browser without a server)                   | always                    | built on insert, nothing to download | CC0, "3D Editor built-in"                    |
| `khronos`   | Khronos glTF Sample Assets on GitHub (its `model-index.json`, each model's `metadata.json`) | no key                    | GLB from raw.githubusercontent.com   | per model (CC0, CC-BY …), all parts credited |
| `polyhaven` | Poly Haven (`api.polyhaven.com`)                                                            | no key                    | glTF at 1k with its textures         | CC0                                          |
| `sketchfab` | Sketchfab                                                                                   | no key                    | needs `SKETCHFAB_TOKEN`              | per model; only downloadable ones insert     |
| `polypizza` | Poly Pizza                                                                                  | needs `POLYPIZZA_API_KEY` | needs `POLYPIZZA_API_KEY`            | per model                                    |
| `catalog`   | JSON catalogs at `STORE_CATALOG_URLS` (your team's own models)                              | no key                    | the files the catalog lists          | as the catalog says                          |

- Khronos: technical test scenes are left out, and so are models that come only with Draco, KTX
  or meshopt compression, which the importer cannot read.
- Sketchfab: categories its API cannot filter are filtered with the models' own categories;
  age-restricted models are skipped. Without a token search works and an insert answers
  `NEEDS_KEY`.
- Every result names its provider in its id: `builtin:park_bench`, `khronos:SheenChair`,
  `polyhaven:modern_arm_chair_01`, `catalog:studio-props.red-chair`.

## Built-in models

170 original procedural models, built by code at insert time (no files), each at its real size
with an EMPTY root and named parts, the origin at the base centre and the front facing −Y:

| Category       | Models | Ids                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `people`       | 6      | person, man, woman, child, toddler, elderly_person (actors)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `animals`      | 11     | horse, pony, donkey, cow, dog, small_dog, cat, sheep, pig, deer, bear (actors)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `furniture`    | 19     | chair, dining_chair, armchair, sofa, loveseat, coffee_table, table, round_table, desk, office_chair, stool, bed, single_bed, wardrobe, nightstand, bookshelf, tv_stand, rug, beach_lounger                                                                                                                                                                                                                                                                                                                                 |
| `props`        | 47     | floor_lamp, table_lamp, tv, laptop, monitor, phone, book, book_stack, mug, cup, plate, bowl, bottle, wine_glass, vase_with_flowers, potted_plant, wall_clock, picture_frame, pillow, cardboard_box, wooden_crate, suitcase, backpack, handbag, closed_umbrella, umbrella, picnic_basket, folded_blanket, picnic_blanket, bucket, trash_can, ladder, kettle, cooking_pot, fridge, stove, kitchen_counter, whiteboard, filing_cabinet, beach_umbrella, tent, campfire, hay_bale, haystack, water_trough, sandcastle, balloon |
| `food`         | 10     | watermelon, watermelon_half, watermelon_slice, apple, orange, banana, bread, cake, pizza, sandwich                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `vehicles`     | 10     | sedan, hatchback, suv, pickup_truck, van, bus, bicycle, motorcycle, rowboat, sailboat                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `nature`       | 17     | oak_tree, pine_tree, palm_tree, bush, rock, boulder, grass_tuft, flower_bed, hill, mountain_backdrop, lake, sea, sand_dune, sand_patch, log, tree_stump, reeds                                                                                                                                                                                                                                                                                                                                                             |
| `architecture` | 23     | house, apartment_building, cottage, log_cabin, barn, stable, storefront, beach_hut, lifeguard_tower, footbridge, pier, brick_wall, stone_wall, picket_fence, rail_fence, gate, door, window, room, stairs, column, arch, well                                                                                                                                                                                                                                                                                              |
| `street`       | 15     | road, road_corner, sidewalk, streetlight, traffic_light, traffic_cone, stop_sign, mailbox, fire_hydrant, bus_stop, park_bench, picnic_table, fountain, signpost, trash_bin                                                                                                                                                                                                                                                                                                                                                 |
| `sports`       | 12     | swing_set, slide, bucket_and_spade, soccer_ball, basketball, beach_ball, tennis_ball, diamond_kite, kite_spool, frisbee, skateboard, surfboard                                                                                                                                                                                                                                                                                                                                                                             |

- Ids are lowercase words joined by underscores; `coffee-table`, `Coffee Table` and
  `builtin:coffee_table` find the same model.
- People and animals are [actors](director-desk.md#actors) (rigged mannequins; `height_m` is their
  standing height); the duck and bird kinds are not built yet, so they are not in the catalog.
- Vehicles share the rig `desk.vehicle_drive` drives: `body`, `wheel.FL/FR/BL/BR` (origin at the
  hub, turning about X), `steer.FL/FR` pivots and `saddle` empties; boats float with z = 0 at the
  waterline.
- The diamond kite has a `bridle` and `tail.1`–`tail.5` parts and the balloon a `string_point`,
  where `desk.tether_fly` ties the string.
- `color` recolours a model's main material; the few models in natural colours (watermelons, the
  campfire) keep them and warn (`recolorable: false` in their search result). Some models take
  parameters (`params`: a sofa's seats, a bed's size, a TV's inches …); their search results
  (`store_search`, `store.search`) list them as JSON schema, and `store_add` and the REST insert
  take them as `params` (e.g. `{floors: 3}` for `builtin:house`), checked by the model's schema
  before anything is inserted: `INVALID_PARAMS` says what is wrong and what the model takes. An
  external model takes none.
- Every model is 48–4,700 triangles and builds in 1–50 ms; search matches names, ids, synonyms
  ("couch" finds the sofa, "telly" the TV), tags and categories, with plurals and accents.

## Custom catalogs

A team publishes its own models as a JSON file next to them and lists its URL in
`STORE_CATALOG_URLS` (comma-separated). URLs inside may be absolute or relative to the catalog
file. Format, version 1:

```json
{
  "version": 1,
  "name": "Studio props",
  "models": [
    {
      "id": "red-chair",
      "name": "Red chair",
      "category": "furniture",
      "tags": ["chair", "red"],
      "description": "A red kitchen chair",
      "thumbnail": "thumbs/red-chair.png",
      "license": { "spdx": "CC-BY-4.0", "url": "https://creativecommons.org/licenses/by/4.0/", "attribution": "Red chair by Ann" },
      "author": "Ann",
      "source_url": "https://example.org/red-chair",
      "dimensions_m": [0.5, 0.5, 0.9],
      "triangles": 1200,
      "downloadable": true,
      "files": { "glb": "models/red-chair.glb" }
    }
  ]
}
```

- `id`: letters, digits, `_` and `-` (unique in the catalog); the store id is
  `catalog:<catalog name as lowercase words joined by '-'>.<id>`.
- Optional: `category` (one of the ten; guessed when missing), `tags`, `description`, `thumbnail`
  (PNG, JPEG, GIF or WebP), `license`, `author`, `source_url`, `dimensions_m` (width X, depth Y,
  height Z), `triangles`, `downloadable` (false: listed, never downloaded).
- `files`: `{"glb": …}`, or `{"gltf": …, "parts": […]}` / `{"obj": …, "parts": […]}` where `parts`
  lists the buffers, textures and materials (or maps paths to URLs). Without `parts` the main file
  is read after downloading and the files it names, next to it on its server, are fetched.
- A catalog that fails to load does not stop the others; invalid models are skipped and reported
  in the provider's status. Without an `attribution`, one is written from the name, author, source
  and licence.
- A catalog may live on the team's own network: its own origin is reached whatever its address,
  for its own models only. Every other URL in it must be a public server.

## Configuration

| Variable                 | Default                                                                           | Meaning                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `STORE_PROVIDERS`        | `builtin,khronos,polyhaven,sketchfab,polypizza` (and `catalog` with catalog URLs) | Providers in search order; unknown ids, and `catalog` without `STORE_CATALOG_URLS`, are refused at startup |
| `SKETCHFAB_TOKEN`        | –                                                                                 | Sketchfab API token, needed for downloads                                                                  |
| `POLYPIZZA_API_KEY`      | –                                                                                 | Poly Pizza API key, needed for search and downloads                                                        |
| `STORE_CATALOG_URLS`     | –                                                                                 | Comma-separated catalog URLs                                                                               |
| `MODEL_CACHE_DIR`        | `<DATA_DIR>/model-cache`                                                          | Downloaded models, thumbnails and provider indexes                                                         |
| `MODEL_CACHE_MAX_MB`     | `2048`                                                                            | Size of the model and thumbnail cache; the least recently used go first                                    |
| `STORE_FETCH_TIMEOUT_MS` | `20000`                                                                           | Timeout of each request to a provider (100–600000)                                                         |

`GET /api/store/providers` (and every search) says how each provider stands: `ok`, `needs_key`
(with the variable to set), `error`, `timeout` or `disabled`, with a message.

## Search, lazy loading and the cache

- **Search** asks every provider in parallel and merges their pages best first, with an opaque
  cursor for the next page (`next_cursor`, at most 50 results a page). A search waits at most 5 s
  (or `STORE_FETCH_TIMEOUT_MS` when lower) for the providers; one that timed out gets a 250 ms
  deadline for the next minute. Results say per provider how it answered.
- **Indexes** (Khronos' model list, Poly Haven's assets) are fetched the first time they are
  needed and cached for 24 hours in memory and on disk; when a refresh is slow the older copy
  answers.
- **Nothing is downloaded before an insert** (or a request for a model's files). Thumbnails are
  proxied and cached; built-in thumbnails are rendered by the server the first time they are asked
  for (256 × 256, clay look, transparent background) and then served from the cache.
- **Downloads** are checked (sizes, checksums the provider gives, the GLB header, images that are
  images), at most 200 MB and 512 files per model, archives unpacked, and stored in the cache under
  `MODEL_CACHE_MAX_MB` (least recently used first; a model in use stays).
- **Network safety**: only http(s); the server never fetches loopback, private, link-local or
  other internal addresses (checked again after redirects and DNS resolution), and the files a
  model names must be on its own server.

Measured through an outbound proxy: a cold search for "chair" over five providers took 0.9 s and
the same search warm 0.1 s; inserting Khronos' SheenChair (a 4.1 MB GLB) 1.2 s, and again from the
cache 0.6 s; a built-in thumbnail 0.2–0.6 s the first time and 2–5 ms from the cache.

## Licences and attribution

- Licences are normalized to SPDX ids with their URL. A Khronos model made of parts under
  different licences gets the most restrictive one, and every artist is credited; trademark
  notices are kept apart from the licence.
- A result with `downloadable: false` (the licence or the provider does not allow it) is refused
  with `NOT_DOWNLOADABLE`; a provider without its key answers `NEEDS_KEY`.
- An inserted model's root carries the custom properties `store_id`, `store_source`, `license`,
  `author` and `source_url`; every video export copies them into its manifest's `credits`, so a
  film can list them.

## Inserting

Built-in models are built by `store.add`; external ones are downloaded and inserted with
`store.insert_files`, which:

1. imports the files (GLB, glTF with its buffers and textures, or OBJ with its MTL and textures),
   leaving out the cameras and lights a file brings (with a warning);
2. wraps the result in an EMPTY root named after the model, with the origin at the base centre;
3. scales it: to the sizes asked for (`height_m`, `width_m`, `depth_m`), else to the provider's
   `dimensions_m`, else keeps the file's size when it is believable for the model's category; a
   model ten times off or more is read as centimetres, inches or millimetres, or scaled to the usual
   size of its category, with a warning naming the size measured and the scale applied. The scale is
   the root's, so a model in micrometres made 1 m tall is shown at 1e-6; the desk and the video
   export go by the size it is shown at, so it is drawn, framed and checked as any other;
4. stands it on the ground at `location` (default the 3D cursor), turned by `rotation_deg` about Z;
5. records the licence and attribution on the root.

It is one undo step. The server checks first that the project has memory for the model (refused
with `OUT_OF_MEMORY`, 507 over REST, before any file is read).

Where an insert runs decides whose undo history it is in:

- `store_add` (MCP) runs in the agent's project: one step of the agent's undo history, synced live.
- The Asset Browser downloads the files through the server and runs `store.insert_files` in the
  browser, so Ctrl+Z undoes it.
- `POST /api/projects/:id/store` runs in the project's room, in no one's undo history.

## REST

| Endpoint                                    | Purpose                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/store/providers`                  | The providers and their state                                                                                           |
| `GET /api/store/search`                     | `query`, `category`, `providers` (comma-separated ids), `limit` (1–50, default 20), `cursor`                            |
| `GET /api/store/models/:model`              | One model; with `?download=1` its files are downloaded (cached) and listed                                              |
| `GET /api/store/models/:model/thumbnail`    | Its thumbnail (cached, ETag)                                                                                            |
| `GET /api/store/models/:model/files/<path>` | One of its files from the cache (empty path: the main file), ETag; the Asset Browser inserts from these                 |
| `POST /api/projects/:id/store`              | Insert: `{model, location, rotation_deg, height_m, width_m, depth_m, name, color, params}`; `{result, entry, warnings}` |

Failures answer `{error, code}`: 400 `NEEDS_KEY` and `INVALID_PARAMS`, 404 `NOT_FOUND`, 409
`NOT_DOWNLOADABLE`, 503 `UPSTREAM` (a provider failed) and `UNAVAILABLE`, 507 `OUT_OF_MEMORY`; a
request whose client went away answers 499.

## MCP

| Tool           | Arguments                                                                                                   | Returns                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `store_search` | `query`, `category`, `providers`, `limit` (1–50, default 20), `cursor`                                      | `{results, providers, next_cursor}`        |
| `store_add`    | `project`, `model`, `location`, `rotation_deg`, `height_m`, `width_m`, `depth_m`, `name`, `color`, `params` | `{result, entry, warnings}`, one undo step |

A result gives `id`, `provider`, `name`, `category`, `tags`, `thumbnail_url`,
`license {spdx, url, attribution}`, `author`, `source_url`, `dimensions_m`, `triangles`, `formats`,
`downloadable` and `needs_key`, and for a built-in model that takes parameters of its own, `params`
(their JSON schema, as `store_add` takes them). The core operators `store.search` and `store.add`
(built-in models only) and `store.insert_files` are also there for `run_operator` and `batch`.

An insert answers `{result, entry, warnings}`, each once: `result` is what it made (`root`,
`objects`, `names`, `name`, `dimensions_m`), `entry` the model in short (`id`, `provider`, `name`,
`license`, `author`, `source_url`, `thumbnail_url`: from `store_add` a link on the server as in
`store_search`'s results, over REST the route's path) and `warnings` what it could not do, such as a
colour for a model without a material to recolour.

## Behind a proxy

Node.js's `fetch` ignores `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` unless the server runs with
`NODE_USE_ENV_PROXY=1`, which Node.js 22.21 and later read (the Docker image has such a Node.js;
an older Node.js 22 ignores the variable without a word, and the providers keep failing). On a
network that reaches the internet only through a proxy, start the server with it (and the proxy's
CA in `NODE_EXTRA_CA_CERTS` when it intercepts TLS):

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://proxy:3128 \
  NO_PROXY=localhost,127.0.0.1,dav.internal,otel.internal npm start
```

The variable applies to every outgoing request of the server, not only the store's: WebDAV
storage (`WEBDAV_URL`) and the OTLP export (`OTEL_EXPORTER_OTLP_ENDPOINT`) go through the proxy
too, so list the hosts the server reaches directly in `NO_PROXY` (above, `dav.internal` and
`otel.internal` stand for yours). Node prints a warning that its proxy agent is experimental; the
store works the same. Without it, the external providers report `error` (the built-in models keep
working).
