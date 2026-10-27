# Pumpkin, Remixed

Draw a pumpkin, choose a visual style and character, and turn the actual sketch into a polished creature with OpenAI image editing. “Keep my weirdness” starts enabled and asks the model to preserve the drawing’s asymmetry, long stems, mismatched eyes, expression, and placement. Results can vary; the model cannot guarantee pixel-perfect preservation.

## Run locally

Requires Node.js 22.22.2+ or 24.15+ on the supported LTS lines (or Node 26+), matching the test tooling’s requirements.

```sh
npm install
cp .env.example .env
# Set OPENAI_API_KEY in .env on the server. Never use a VITE_ prefix for secrets.
npm run dev
```

Open `http://localhost:5173`. The Node server handles `/api` and runs Vite middleware on the same origin. Restart it after changing `.env`. Without a key, the drawing tools and concept demo work and the UI explains why live generation is unavailable.

## Production

```sh
npm ci
npm run build
npm start
```

The same Node server serves `dist/` and the image API. Set environment variables in the deployment environment, or use the ignored `.env` file. Do not deploy only the static `dist/` folder: live generation requires the Node server. `PORT` defaults to `5173`; `HOST` defaults to `0.0.0.0`.

## How the transformation works

1. The client exports the canvas as an opaque 1024 × 1024 PNG. The comparison snapshot uses this exact image.
2. `POST /api/transform` validates the PNG, checks that it contains ink, and validates the selected style, character, and boolean weirdness setting.
3. The server sends the sketch as an image reference to OpenAI’s [image edits endpoint](https://developers.openai.com/api/reference/resources/images/methods/edit), with specific material, costume, composition and preservation instructions. The default model is `gpt-image-2`; override with `OPENAI_IMAGE_MODEL` for an image-editing model your project can access. The API key stays on the server.
4. The returned PNG becomes the actual preview and download. Results are matched to the exact sketch and settings; changing them never silently reuses an unrelated image.

Choose Claymation, Cozy watercolor, Spooky cinematic, or Crochet plushie. Characters include the original pumpkin, tiny knight, swamp monster, space explorer, and elegant aristocrat. Generate styles individually or use the gallery’s **Generate missing styles** button. A fresh four-style gallery makes four sequential provider requests. Completed styles remain available if a later request fails; retry generates only the missing styles.

One transformation runs at a time per server process. `MAX_GENERATIONS_PER_HOUR` defaults to `12` provider attempts shared by the studio; a batch uses one attempt per image. Failures and cancellations count because the provider may already have started processing. The limit resets after an hour or server restart, and is per process rather than distributed. The upstream timeout is three minutes. Cancellation aborts the server’s provider request, but does not guarantee that provider processing or billing stops. Place a publicly deployed studio behind your deployment’s access controls; the app itself does not implement user accounts.

Errors are shown without discarding the sketch or previous successful image. Drawings and generated images stay in page memory; refreshing clears them. Sketches are sent to OpenAI only when generating; the app does not persist uploads or API keys in the browser.

## Demo and artwork

The isolated 13-second concept demo uses pre-made artwork and local visual treatments, makes no API calls, and leaves your working canvas untouched. Style thumbnails are illustrative previews, not generated results. Live outputs never receive CSS style filters.

Artwork: `public/pumpkin-clay.png`, generated with the built-in image generation tool. Prompt: adorable handmade claymation pumpkin creature, lopsided orange body, tall crooked green stem, mismatched eyes, broad goofy smile with one tooth, tiny arms and feet, tactile plasticine texture, warm cream studio background, no text.

## Validation

```sh
npm test
```

This builds the production client, then runs server HTTP tests and React hook tests. A mocked provider verifies the real request contract without incurring image-generation costs. Coverage includes all style/character prompts, preservation settings, upload validation, key isolation, provider errors, stale responses after sketch edits, partial batch recovery, duplicate clicks, cancellation, timeout, hourly limits, and production asset serving. Live provider quality and account access need a configured API key and a manual generation check.
