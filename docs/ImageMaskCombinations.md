# Image Mask Combinations

ImageMaskCombinations takes multiple equally-sized candidate images and one mask, then enumerates every ordered pair `(i, j)`: image i is used as the base while image j is pasted into the white area of the mask (black keeps the base, grayscale blends by opacity). It outputs a batch containing every composite, together with a string list of combination indices aligned one-to-one with the output batch. It is useful after generating several candidates for the same frame, to exhaustively explore local-region replacements and pick the best parts from each candidate.

## Inputs

| Field | Description | Data type |
| --- | --- | --- |
| `images` | Auto-growing image inputs. The first socket is required (filled); each time you connect one, a new optional socket (hollow) appears below it, up to 50. Each socket accepts a single image or an image batch; all images are flattened into one candidate sequence numbered from 0. All images must have the same size. | `IMAGE` |
| `mask` | Compositing mask. White marks the region replaced by the patch image, black keeps the base image, grayscale produces opacity blending. If the mask size differs from the images it is resized with nearest-neighbor sampling; the first mask of a mask batch is used. | `MASK` |
| `include_self` | When off (default), outputs N×(N-1) combinations, excluding `i=j` pairs which are identical to the original images. When on, outputs N×N combinations; the diagonal entries are the untouched candidates and serve as a baseline. | `BOOLEAN` |

## Outputs

| Field | Description | Data type |
| --- | --- | --- |
| `images` | Batch of all composites, ordered row-first: base index i first, patch index j second. | `IMAGE` |
| `indices` | String list aligned one-to-one with the output batch, formatted as `base->patch`, e.g. `0->2` means candidate 0 is the base and candidate 2 is pasted into the mask region. | `STRING` (list) |
